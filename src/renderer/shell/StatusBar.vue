<script setup lang="ts">
/**
 * 状态栏：保存状态、字数、编码与换行、缩放、目录开关。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { countText } from '@shared/markdown/outline'
import { useDocumentsStore } from '../stores/documents'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'

const documents = useDocumentsStore()
const ui = useUiStore()
const stats = ref({ words: 0, characters: 0 })
let timer = 0

watch(
  () => documents.activeText,
  (text) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const counted = countText(text)
      stats.value = { words: counted.words, characters: counted.characters }
    }, 260)
  },
  { immediate: true }
)

onBeforeUnmount(() => window.clearTimeout(timer))

const saveLabel = computed(() => {
  const tab = documents.activeTab
  if (!tab) return '未打开文档'
  if (tab.saveState === 'saving') return '正在保存…'
  if (tab.saveState === 'conflict') return '保存冲突，需要处理'
  if (tab.saveState === 'failed') return '保存失败'
  if (tab.snapshot.dirty) return '有未保存修改'
  return '所有更改已保存'
})

const saveTone = computed(() => {
  const tab = documents.activeTab
  if (!tab) return 'idle'
  if (tab.saveState === 'conflict' || tab.saveState === 'failed') return 'warn'
  if (tab.snapshot.dirty) return 'dirty'
  return 'ok'
})

const eolLabel = computed(() => {
  const eol = documents.activeTab?.snapshot.eol
  return eol === 'crlf' ? 'CRLF' : eol === 'mixed' ? '混合换行' : 'LF'
})

async function save(): Promise<void> {
  const tab = documents.activeTab
  if (tab) await documents.save(tab.snapshot.documentId)
}
</script>

<template>
  <footer class="statusbar">
    <span :class="['save-state', saveTone]" @click="save">
      <span class="green-dot" :class="{ off: saveTone !== 'ok' }" />
      {{ saveLabel }}
    </span>
    <span>{{ stats.words }} 字</span>
    <span>{{ stats.characters }} 字符</span>
    <span>Markdown</span>
    <span>UTF-8 · {{ eolLabel }}</span>
    <button title="切换缩放" @click="ui.cycleZoom()">
      {{ ui.zoom }}%<Icon name="chevron-down" :size="10" />
    </button>
    <button
      :title="ui.outlineVisible ? '隐藏目录' : '显示目录'"
      :aria-label="ui.outlineVisible ? '隐藏目录' : '显示目录'"
      @click="ui.toggleOutline()"
    >
      <Icon name="panel-right" :size="12" />
    </button>
  </footer>
</template>

<style scoped>
.save-state {
  cursor: pointer;
}

.save-state.dirty {
  color: color-mix(in srgb, #b08a4a 80%, var(--muted));
}

.save-state.warn {
  color: #a05a45;
}
</style>
