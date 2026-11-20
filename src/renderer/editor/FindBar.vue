<script setup lang="ts">
/**
 * 查找替换栏：驱动 CodeMirror 搜索状态，不改动文档外的任何东西。
 */
import { nextTick, ref, watch } from 'vue'
import { useUiStore } from '../stores/ui'
import { editorApi } from '../lib/editorApi'
import Icon from '../components/Icon.vue'

const ui = useUiStore()
const query = ref('')
const replacement = ref('')
const caseSensitive = ref(false)
const index = ref(0)
const total = ref(0)
const input = ref<HTMLInputElement | null>(null)

function applySearch(): void {
  const editor = editorApi.current
  if (!editor) return
  editor.setSearch(query.value, caseSensitive.value, replacement.value)
  refreshCounts()
}

function refreshCounts(): void {
  const counts = editorApi.current?.searchCounts() ?? { index: 0, total: 0 }
  index.value = counts.index
  total.value = counts.total
}

watch([query, caseSensitive, replacement], () => applySearch())

watch(
  () => ui.findOpen,
  async (open) => {
    if (!open) return
    await nextTick()
    input.value?.focus()
    input.value?.select()
    refreshCounts()
  }
)

function findNext(backwards = false): void {
  applySearch()
  editorApi.current?.findNext(backwards)
  refreshCounts()
}

function replaceOne(): void {
  if (!query.value || ui.locked) return
  applySearch()
  editorApi.current?.replaceCurrent()
  refreshCounts()
}

function replaceEverything(): void {
  if (!query.value || ui.locked) return
  applySearch()
  const count = editorApi.current?.replaceAllMatches() ?? 0
  ui.toast(count ? `已替换 ${count} 处` : '没有可替换的匹配', count ? 'success' : 'info')
  refreshCounts()
}

function close(): void {
  ui.findOpen = false
  editorApi.current?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    findNext(event.shiftKey)
  }
}
</script>

<template>
  <div class="findbar" role="dialog" aria-label="查找与替换" @keydown="onKeydown">
    <input ref="input" v-model="query" placeholder="查找…" aria-label="查找内容" />
    <span class="count">{{ total ? `${index}/${total}` : '0 处' }}</span>
    <button class="iconbtn" title="上一个 (Shift+Enter)" aria-label="上一个" @click="findNext(true)">
      <Icon name="up" :size="13" />
    </button>
    <button class="iconbtn" title="下一个 (Enter)" aria-label="下一个" @click="findNext(false)">
      <Icon name="down" :size="13" />
    </button>
    <span class="sep" />
    <input
      v-model="replacement"
      class="replace"
      :disabled="ui.locked"
      :placeholder="ui.locked ? '页面已锁定' : '替换为…'"
      :title="ui.locked ? '页面已锁定，解锁后才能替换' : undefined"
      aria-label="替换内容"
    />
    <button class="textbtn" :disabled="ui.locked" title="替换当前" @click="replaceOne">替换</button>
    <button class="textbtn" :disabled="ui.locked" title="全部替换" @click="replaceEverything">全部</button>
    <label class="case" title="区分大小写">
      <input v-model="caseSensitive" type="checkbox" />
      Aa
    </label>
    <button class="iconbtn" title="关闭 (Esc)" aria-label="关闭查找" @click="close">
      <Icon name="x" :size="13" />
    </button>
  </div>
</template>

<style scoped>
.findbar {
  position: absolute;
  top: 8px;
  right: 18px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  background: var(--card);
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
}

.findbar input {
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0 8px;
  width: 150px;
  font-size: 11px;
  background: var(--page);
}

.findbar input.replace {
  width: 110px;
}

.findbar .sep {
  width: 1px;
  height: 16px;
  background: var(--line);
  margin: 0 2px;
}

.findbar .case {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 9px;
  color: var(--muted);
  cursor: pointer;
}

.findbar .case input {
  width: 12px;
  height: 12px;
  accent-color: var(--accent);
}

.findbar button:disabled,
.findbar input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
