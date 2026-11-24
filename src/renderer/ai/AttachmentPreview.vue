<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { SourceAsset, SourcePreviewChunk } from '@shared/types'
import Icon from '../components/Icon.vue'
import { useUiStore } from '../stores/ui'

const props = defineProps<{ source: SourceAsset }>()
defineEmits<{ close: []; remove: [] }>()

const ui = useUiStore()
const page = ref(1)
const pageCount = ref(1)
const chunks = ref<SourcePreviewChunk[]>([])
const canvas = ref<HTMLCanvasElement | null>(null)
const pdfReady = ref(false)
const busy = ref(true)
const error = ref('')
const previewPane = ref<HTMLElement | null>(null)
let loadingTask: PDFDocumentLoadingTask | undefined
let pdf: PDFDocumentProxy | undefined
let renderTask: RenderTask | undefined
let closed = false

const copying = ref(false)
const spreadsheet = computed(() => /\.(xlsx|tsv)$/i.test(props.source.title))
const json = computed(() => /\.json$/i.test(props.source.title))

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** 把预览内容复制到剪贴板：PDF 取当前页的文字层，其余取已解析的片段 */
async function copyPreviewText(): Promise<void> {
  if (copying.value) return
  copying.value = true
  try {
    let text = ''
    if (pdfReady.value && pdf) {
      const selected = await pdf.getPage(page.value)
      const content = await selected.getTextContent()
      text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .trim()
    } else {
      text = chunks.value.map((chunk) => chunk.text).join('\n\n').trim()
    }
    if (!text) {
      ui.toast('这一页没有可复制的文字', 'warning')
      return
    }
    await window.api.app.writeClipboardText(text)
    ui.toast(pdfReady.value ? `已复制第 ${page.value} 页文字` : '已复制预览文字', 'success')
  } catch (error) {
    ui.toast((error as Error).message || '复制失败', 'error')
  } finally {
    copying.value = false
  }
}

async function showPage(number: number): Promise<void> {
  if (number < 1 || number > pageCount.value) return
  busy.value = true
  error.value = ''
  try {
    if (pdf && canvas.value) {
      const selected = await pdf.getPage(number)
      const width = Math.min(850, (previewPane.value?.clientWidth || 700) - 28)
      const original = selected.getViewport({ scale: 1 })
      const viewport = selected.getViewport({
        scale: Math.min(width / original.width, 1400 / original.height, 1.7)
      })
      const scale = Math.min(2, window.devicePixelRatio)
      canvas.value.width = Math.ceil(viewport.width * scale)
      canvas.value.height = Math.ceil(viewport.height * scale)
      canvas.value.style.width = viewport.width + 'px'
      renderTask = selected.render({
        canvas: canvas.value,
        viewport,
        transform: [scale, 0, 0, scale, 0, 0]
      })
      await renderTask.promise
    } else {
      chunks.value = await window.api.references.preview(props.source.sourceId, (number - 1) * 25)
    }
    page.value = number
    if (previewPane.value) previewPane.value.scrollTop = 0
  } catch {
    if (!closed) error.value = '无法显示此页。'
  } finally {
    if (!closed) busy.value = false
  }
}

onMounted(async () => {
  if (props.source.kind === 'pdf') {
    try {
      const bytes = await window.api.references.previewPdf(props.source.sourceId)
      if (closed) return
      if (bytes) {
        const [{ GlobalWorkerOptions, getDocument }, { default: worker }] = await Promise.all([
          import('pdfjs-dist/legacy/build/pdf.mjs'),
          import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
        ])
        if (closed) return
        GlobalWorkerOptions.workerSrc = worker
        loadingTask = getDocument({ data: bytes, useSystemFonts: true })
        pdf = await loadingTask.promise
        if (closed) return
        pdfReady.value = true
        pageCount.value = pdf.numPages
      }
    } catch {
      pdf = undefined
    }
  }
  if (closed) return
  if (!pdf) pageCount.value = Math.max(1, Math.ceil(props.source.chunkCount / 25))
  await nextTick()
  await showPage(1)
})

onBeforeUnmount(() => {
  closed = true
  renderTask?.cancel()
  void loadingTask?.destroy().catch(() => undefined)
})
</script>

<template>
  <div
    class="modal-backdrop attachment-backdrop"
    @click.self="$emit('close')"
    @keydown.esc.stop="$emit('close')"
  >
    <section class="modal wide attachment-preview" role="dialog" aria-modal="true" aria-label="附件预览">
      <header class="modal-title">
        <div>
          <h2>{{ source.title }}</h2>
          <p v-if="source.message">{{ source.message }}</p>
        </div>
        <button type="button" class="iconbtn" aria-label="关闭" autofocus @click="$emit('close')">
          <Icon name="x" :size="16" />
        </button>
      </header>
      <div ref="previewPane" class="attachment-body" :aria-busy="busy">
        <p v-if="busy">正在加载…</p>
        <p v-if="error">{{ error }}</p>
        <canvas v-if="pdfReady" ref="canvas" :aria-label="'PDF 第 ' + page + ' 页'" />
        <article v-for="chunk in chunks" v-else :key="chunk.chunkId" class="attachment-chunk">
          <small>{{ chunk.label }}</small>
          <table v-if="spreadsheet">
            <tbody>
              <tr v-for="(row, index) in chunk.text.split('\n')" :key="index">
                <td v-for="(cell, col) in row.split('\t')" :key="col">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
          <pre v-else-if="json">{{ prettyJson(chunk.text) }}</pre>
          <p v-else>{{ chunk.text }}</p>
        </article>
        <p v-if="!busy && !error && !pdfReady && !chunks.length">此附件没有可预览的内容。</p>
      </div>
      <footer class="modal-footer">
        <button class="textbtn" @click="$emit('remove')">移除参考</button>
        <button v-if="!busy && !error" class="textbtn" :disabled="copying" @click="copyPreviewText">
          {{ pdfReady ? '复制本页文字' : '复制全文' }}
        </button>
        <div v-if="pageCount > 1" class="attachment-pagination">
          <button class="ghostbtn" :disabled="busy || page <= 1" @click="showPage(page - 1)">上一页</button>
          <span>{{ page }} / {{ pageCount }}</span>
          <button class="ghostbtn" :disabled="busy || page >= pageCount" @click="showPage(page + 1)">
            下一页
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.attachment-backdrop {
  -webkit-app-region: no-drag;
}
.attachment-preview {
  display: flex;
  flex-direction: column;
}
.attachment-preview .modal-title {
  word-break: break-word;
}
.attachment-preview .iconbtn {
  flex: none;
}
.attachment-body {
  /* 正文区域是可读内容，显式允许光标选中与复制 */
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
  overflow: auto;
  min-height: 160px;
  max-height: 64vh;
  margin-top: 14px;
}
.attachment-body canvas {
  cursor: default;
  max-width: 100%;
  display: block;
  margin: 0 auto;
  background: white;
}
.attachment-chunk {
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.attachment-chunk small {
  color: var(--soft);
}
.attachment-chunk p,
.attachment-chunk pre,
.attachment-chunk td {
  user-select: text;
  -webkit-user-select: text;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.75;
}
.attachment-chunk table {
  border-collapse: collapse;
  margin-top: 8px;
  width: 100%;
}
.attachment-chunk td {
  border: 1px solid var(--line);
  padding: 5px 8px;
  white-space: pre-wrap;
}
.attachment-pagination {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
