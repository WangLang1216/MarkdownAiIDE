<script setup lang="ts">
/**
 * 右侧目录：标题树、当前章节高亮、定位、阅读进度与折叠。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { countText, parseOutline } from '@shared/markdown/outline'
import type { OutlineNode } from '@shared/types'
import { useDocumentsStore } from '../stores/documents'
import { useUiStore } from '../stores/ui'
import { editorApi } from '../lib/editorApi'
import Icon from '../components/Icon.vue'

const documents = useDocumentsStore()
const ui = useUiStore()
const outline = ref<OutlineNode[]>([])
const stats = ref({ words: 0, readingMinutes: 1 })
let timer = 0

function recompute(): void {
  const text = documents.activeText
  outline.value = parseOutline(text)
  const counted = countText(text)
  stats.value = { words: counted.words, readingMinutes: counted.readingMinutes }
}

watch(
  () => documents.activeText,
  () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(recompute, 200)
  },
  { immediate: true }
)

onBeforeUnmount(() => window.clearTimeout(timer))

const activeId = computed(() => {
  const offset = ui.cursorOffset
  let active: OutlineNode | null = null
  for (const node of outline.value) {
    if (node.from <= offset) active = node
    else break
  }
  return active?.sectionId ?? null
})

const h2Numbering = computed(() => {
  const map = new Map<string, string>()
  let count = 0
  for (const node of outline.value) {
    if (node.level === 2) {
      count += 1
      map.set(node.sectionId, String(count).padStart(2, '0'))
    }
  }
  return map
})

const progress = computed(() => Math.round(ui.scrollRatio * 100))

function jump(node: OutlineNode): void {
  editorApi.current?.revealOffset(node.from)
}

function hide(): void {
  ui.setOutlineVisible(false)
}
</script>

<template>
  <aside class="outline-panel">
    <div class="outline-heading">
      <Icon name="list" :size="15" />
      <b>文档目录</b>
      <button class="iconbtn" title="收起目录" aria-label="收起目录" @click="hide">
        <Icon name="panel-right" :size="14" />
      </button>
    </div>
    <div class="outline-subtitle">清晰结构，专注表达</div>

    <nav class="outline-nav" aria-label="文档目录">
      <button
        v-for="node in outline"
        :key="node.sectionId"
        :class="{
          active: node.sectionId === activeId && node.level <= 2,
          sub: node.level > 2,
          'sub-active': node.sectionId === activeId && node.level > 2
        }"
        :title="node.headingPath.join(' › ')"
        @click="jump(node)"
      >
        <span v-if="node.level === 2" class="num">{{ h2Numbering.get(node.sectionId) }}</span>
        {{ node.title }}
      </button>
      <p v-if="!outline.length" class="outline-empty">当前文档还没有标题</p>
    </nav>

    <div class="outline-bottom">
      <span>阅读进度</span>
      <b>{{ progress }}%</b>
      <div class="progress-track"><i :style="{ width: `${progress}%` }" /></div>
      <small
        ><Icon name="clock" :size="11" />约 {{ stats.readingMinutes }} 分钟阅读 · {{ stats.words }} 字</small
      >
    </div>
  </aside>
</template>

<style scoped>
.outline-empty {
  font-size: 10px;
  color: var(--muted);
  padding: 6px 4px;
}
</style>
