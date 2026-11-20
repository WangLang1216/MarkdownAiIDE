<script setup lang="ts">
/**
 * 文档区：承载编辑器、可选的预览列与查找栏，并处理双栏滚动同步。
 * 分屏默认左右等宽居中，分隔条支持拖动、键盘微调与一键恢复居中。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDocumentsStore } from '../stores/documents'
import { useUiStore } from '../stores/ui'
import { editorApi } from '../lib/editorApi'
import EditorHost from './EditorHost.vue'
import MarkdownPreview from './MarkdownPreview.vue'
import FindBar from './FindBar.vue'

const SPLIT_RATIO_KEY = 'moye.splitRatio'
/** 单侧最小宽度，避免拖到完全不可读 */
const MIN_PANE_WIDTH = 260
const CENTER_TOLERANCE = 0.004

const documents = useDocumentsStore()
const ui = useUiStore()
const preview = ref<InstanceType<typeof MarkdownPreview> | null>(null)
const panes = ref<HTMLElement | null>(null)
const splitRatio = ref(readSplitRatio())
const dragging = ref(false)
let syncing = false
let releaseTimer = 0
let paneObserver: ResizeObserver | null = null

function readSplitRatio(): number {
  const raw = window.localStorage.getItem(SPLIT_RATIO_KEY)
  const value = raw === null ? Number.NaN : Number(raw)
  // 只接受合理区间，历史脏数据或极端值回落到居中
  return Number.isFinite(value) && value >= 0.2 && value <= 0.8 ? value : 0.5
}

const isCentered = computed(() => Math.abs(splitRatio.value - 0.5) < CENTER_TOLERANCE)
const splitStyle = computed(() => ({ '--split-ratio': `${(splitRatio.value * 100).toFixed(3)}%` }))

/** 把比例限制在两侧最小宽度之内；窗口过窄时退化为可用的对称区间 */
function clampRatio(ratio: number): number {
  const width = panes.value?.getBoundingClientRect().width ?? 0
  if (!width) return Math.min(0.8, Math.max(0.2, ratio))
  const min = Math.min(MIN_PANE_WIDTH, width * 0.42)
  const minRatio = min / width
  return Math.min(1 - minRatio, Math.max(minRatio, ratio))
}

function persistRatio(): void {
  window.localStorage.setItem(SPLIT_RATIO_KEY, splitRatio.value.toFixed(4))
}

function setRatio(next: number): void {
  splitRatio.value = clampRatio(next)
}

function onSplitterDown(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging.value = true
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    // 合成事件或指针已释放时忽略，交由冒泡的 pointermove 处理
  }
  document.body.classList.add('split-resizing')
}

function onSplitterMove(event: PointerEvent): void {
  if (!dragging.value) return
  const element = panes.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  if (!rect.width) return
  setRatio((event.clientX - rect.left) / rect.width)
}

function onSplitterUp(event: PointerEvent): void {
  if (!dragging.value) return
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  dragging.value = false
  document.body.classList.remove('split-resizing')
  persistRatio()
}

function nudgeSplit(delta: number): void {
  setRatio(splitRatio.value + delta)
  persistRatio()
}

function resetSplit(): void {
  splitRatio.value = 0.5
  persistRatio()
}

function releaseSync(): void {
  window.clearTimeout(releaseTimer)
  releaseTimer = window.setTimeout(() => {
    syncing = false
  }, 80)
}

function onEditorScroll(ratio: number): void {
  ui.scrollRatio = ratio
  if (ui.mode !== 'split' || !preview.value || syncing) return
  syncing = true
  preview.value.setScrollRatio(ratio)
  releaseSync()
}

function onPreviewScroll(ratio: number): void {
  if (syncing) return
  syncing = true
  editorApi.current?.setScrollRatio(ratio)
  releaseSync()
}

function onSelection(selection: { from: number; to: number }): void {
  ui.selectionFrom = selection.from
  ui.selectionTo = selection.to
  ui.cursorOffset = selection.from
}

function onCursorLine(line: number): void {
  ui.cursorLine = line
}

watch(
  () => documents.activeId,
  () => {
    ui.scrollRatio = 0
  }
)

onMounted(() => {
  if (!panes.value) return
  // 窗口变窄时把比例收回到合法区间，避免某侧被挤成 0
  paneObserver = new ResizeObserver(() => {
    if (dragging.value || !panes.value) return
    const next = clampRatio(splitRatio.value)
    if (Math.abs(next - splitRatio.value) > 0.0005) splitRatio.value = next
  })
  paneObserver.observe(panes.value)
})

onBeforeUnmount(() => {
  window.clearTimeout(releaseTimer)
  paneObserver?.disconnect()
  document.body.classList.remove('split-resizing')
})
</script>

<template>
  <div
    class="document-area"
    :class="[`mode-${ui.mode}`, `width-${ui.contentWidth}`, { locked: ui.locked }]"
    :style="splitStyle"
  >
    <div v-if="ui.mode === 'split'" class="split-labels">
      <span>MARKDOWN 源码</span>
      <span class="preview-label">
        实时预览
        <button v-if="!isCentered" class="split-reset" title="恢复左右等宽" @click="resetSplit">
          恢复居中
        </button>
        <span class="sync-label">滚动同步</span>
      </span>
    </div>
    <div ref="panes" class="document-panes">
      <div class="editor-pane" :class="{ 'source-mode': ui.mode !== 'live' }">
        <EditorHost @scroll="onEditorScroll" @selection="onSelection" @cursor-line="onCursorLine" />
      </div>
      <div
        v-if="ui.mode === 'split'"
        class="splitter"
        :class="{ dragging, offset: !isCentered }"
        role="separator"
        aria-label="调整源码与预览宽度，双击恢复居中"
        aria-orientation="vertical"
        aria-valuemin="20"
        aria-valuemax="80"
        :aria-valuenow="Math.round(splitRatio * 100)"
        tabindex="0"
        title="拖动调整宽度 · 双击恢复居中"
        @pointerdown.prevent="onSplitterDown"
        @pointermove="onSplitterMove"
        @pointerup="onSplitterUp"
        @pointercancel="onSplitterUp"
        @lostpointercapture="onSplitterUp"
        @dblclick="resetSplit"
        @keydown.left.prevent="nudgeSplit(-0.02)"
        @keydown.right.prevent="nudgeSplit(0.02)"
        @keydown.home.prevent="resetSplit"
      >
        <span class="splitter-grip" aria-hidden="true" />
      </div>
      <MarkdownPreview
        v-if="ui.mode === 'split'"
        ref="preview"
        :text="documents.activeText"
        :document-id="documents.activeTab?.snapshot.documentId ?? null"
        @scroll="onPreviewScroll"
      />
    </div>
    <FindBar v-if="ui.findOpen" />
  </div>
</template>
