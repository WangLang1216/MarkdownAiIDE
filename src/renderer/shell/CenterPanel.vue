<script setup lang="ts">
/**
 * 中间工作区：标签页、编辑模式、格式操作、文档区、AI 面板与状态栏。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDocumentsStore } from '../stores/documents'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { closeTabWithConfirm, insertImageElement, togglePageLock } from '../lib/actions'
import { editorApi } from '../lib/editorApi'
import DocumentArea from '../editor/DocumentArea.vue'
import AiDock from '../ai/AiDock.vue'
import StatusBar from './StatusBar.vue'
import Icon from '../components/Icon.vue'
import type { ContentWidth, EditorMode } from '../types'

const documents = useDocumentsStore()
const workspace = useWorkspaceStore()
const ui = useUiStore()

const modes: Array<{ value: EditorMode; label: string; icon: string }> = [
  { value: 'live', label: '即时渲染', icon: 'pen' },
  { value: 'source', label: '源码', icon: 'code' },
  { value: 'split', label: '分屏', icon: 'columns' }
]

const widths: Array<{ value: ContentWidth; label: string; title: string }> = [
  { value: 'default', label: '默认', title: '默认居中宽度' },
  { value: 'full', label: '铺满', title: '铺满可用宽度' },
  { value: 'narrow', label: '较窄', title: '较窄居中宽度' }
]

/** 锁定/解锁页面，并说明锁定后的行为，避免误以为编辑器失灵 */
function toggleLock(): void {
  togglePageLock()
}

/* --------------------------- 拖入标签栏 --------------------------- */

const tabsRef = ref<HTMLElement | null>(null)
const tabDropActive = ref(false)
const tabsOverflow = ref(false)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
let tabsObserver: ResizeObserver | null = null
const DROP_EXTENSIONS = /\.(md|markdown|mdx|txt)$/i
let tabDragDepth = 0

function hasFiles(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types.includes('Files'))
}

function onTabDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return
  tabDragDepth += 1
  tabDropActive.value = true
}

function onTabDragOver(event: DragEvent): void {
  if (!hasFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onTabDragLeave(): void {
  tabDragDepth = Math.max(0, tabDragDepth - 1)
  if (!tabDragDepth) tabDropActive.value = false
}

/** 拖入标签栏：逐个打开文稿，并以只读成稿状态展示，避免拖入即误改 */
async function onTabDrop(event: DragEvent): Promise<void> {
  tabDragDepth = 0
  tabDropActive.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  const accepted = files.filter((file) => DROP_EXTENSIONS.test(file.name))
  if (!accepted.length) {
    ui.toast('只能拖入 Markdown 或文本文件', 'warning')
    return
  }
  let opened = 0
  for (const file of accepted) {
    const path = window.api.app.pathForFile(file)
    if (!path) {
      ui.toast(`无法获取 ${file.name} 的路径`, 'error')
      continue
    }
    try {
      // 拖入属于显式授权：允许打开工作区外的文稿，标签标题沿用文件名
      const snapshot = await window.api.documents.openDropped(path)
      documents.upsertFromOutside(snapshot)
      opened += 1
    } catch (error) {
      ui.toast((error as Error).message || `打开 ${file.name} 失败`, 'error')
    }
  }
  if (!opened) return
  // 等 activeId 的监听先跑完（切换文稿会解锁），再把拖入的文稿置为锁定阅读
  await nextTick()
  ui.setLocked(true)
  ui.toast(opened > 1 ? `已打开 ${opened} 个文件，当前文稿已锁定` : '已打开文件并锁定阅读', 'success', 2000)
}

/** 刷新标签区的溢出与左右可滚动状态，供箭头显隐与禁用 */
function updateTabScrollState(): void {
  const el = tabsRef.value
  if (!el) return
  const max = el.scrollWidth - el.clientWidth
  tabsOverflow.value = max > 1
  canScrollLeft.value = max > 1 && el.scrollLeft > 2
  canScrollRight.value = max > 1 && el.scrollLeft < max - 2
}

function onTabsScroll(): void {
  updateTabScrollState()
}

/** 左右按钮：按可视宽度滚动约七成，留出上下文 */
function scrollTabs(direction: -1 | 1): void {
  const el = tabsRef.value
  if (!el) return
  el.scrollBy({
    left: direction * Math.max(120, Math.round(el.clientWidth * 0.7)),
    behavior: 'smooth'
  })
}

/** 滚轮在标签栏上转成横向滚动；没有溢出时不拦截，避免影响外部滚动 */
function onTabsWheel(event: WheelEvent): void {
  const el = tabsRef.value
  if (!el || el.scrollWidth <= el.clientWidth + 1) return
  const delta = event.deltaY || event.deltaX
  if (!delta) return
  event.preventDefault()
  el.scrollLeft += delta
}

/** 让活动标签完整露出（左右各留 8px），而不是只保证露出一点 */
function revealActiveTab(smooth = true): void {
  const el = tabsRef.value
  const tab = el?.querySelector<HTMLElement>('.doc-tab.active')
  if (!el || !tab) return
  const tabRect = tab.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  const pad = 8
  let delta = 0
  if (tabRect.left < rect.left + pad) delta = tabRect.left - rect.left - pad
  else if (tabRect.right > rect.right - pad) delta = tabRect.right - rect.right + pad
  if (!delta) return
  el.scrollBy({ left: delta, behavior: smooth ? 'smooth' : 'auto' })
}

// 新标签或切换标签后把活动标签滚入可视区，避免标签很多时“打开了却看不到”
watch(
  () => documents.activeId,
  async () => {
    await nextTick()
    revealActiveTab()
    updateTabScrollState()
  }
)

// 标签数量变化（打开/关闭）后同步箭头状态，并保证活动标签可见
watch(
  () => documents.tabs.length,
  async () => {
    await nextTick()
    updateTabScrollState()
    revealActiveTab()
  }
)

onMounted(async () => {
  await nextTick()
  updateTabScrollState()
  revealActiveTab(false)
  const el = tabsRef.value
  if (el && typeof ResizeObserver === 'function') {
    tabsObserver = new ResizeObserver(() => {
      updateTabScrollState()
      revealActiveTab(false)
    })
    tabsObserver.observe(el)
  }
})

onBeforeUnmount(() => {
  tabsObserver?.disconnect()
  tabsObserver = null
})

const breadcrumb = computed(() => {
  const tab = documents.activeTab
  if (!tab) return { root: workspace.info?.name ?? '本地文稿', path: '' }
  const relative = tab.snapshot.relativePath
  const parts = relative ? relative.split('/') : []
  parts.pop()
  return { root: workspace.info?.name ?? '本地文稿', path: parts.join(' / ') }
})

const saveText = computed(() => {
  const tab = documents.activeTab
  if (!tab) return ''
  if (tab.saveState === 'saving') return '正在保存…'
  if (tab.saveState === 'conflict') return '检测到外部修改'
  if (tab.snapshot.dirty) return '未保存'
  return '已保存到本地'
})

function format(kind: 'bold' | 'italic' | 'code'): void {
  editorApi.current?.wrapSelection(kind)
}

function insert(id: string): void {
  editorApi.current?.insertSnippet(id)
}

async function resolve(choice: 'reload' | 'overwrite' | 'saveAs'): Promise<void> {
  await documents.resolveConflict(choice)
}
</script>

<template>
  <section class="center-panel">
    <div class="editor-toolbar">
      <div
        class="tabs-shell"
        @dragenter="onTabDragEnter"
        @dragover="onTabDragOver"
        @dragleave="onTabDragLeave"
        @drop.prevent="onTabDrop"
      >
        <button
          v-if="tabsOverflow"
          class="tabs-arrow left"
          type="button"
          title="向左滚动标签"
          aria-label="向左滚动标签"
          :disabled="!canScrollLeft"
          @click="scrollTabs(-1)"
        >
          <Icon name="left" :size="11" />
        </button>
        <div
          ref="tabsRef"
          class="doc-tabs"
          :class="{ 'drop-active': tabDropActive }"
          role="tablist"
          aria-label="打开的文档"
          @scroll="onTabsScroll"
          @wheel="onTabsWheel"
        >
          <div
            v-for="tab in documents.tabs"
            :key="tab.snapshot.documentId"
            class="doc-tab"
            :class="{ active: tab.snapshot.documentId === documents.activeId }"
            role="tab"
            tabindex="0"
            :aria-selected="tab.snapshot.documentId === documents.activeId"
            @click="documents.setActive(tab.snapshot.documentId)"
            @keydown.enter="documents.setActive(tab.snapshot.documentId)"
          >
            <span class="md-badge">M↓</span>
            <span class="name" :title="tab.snapshot.relativePath ?? tab.snapshot.title">{{
              tab.snapshot.title
            }}</span>
            <span v-if="tab.snapshot.dirty" class="dirty" aria-label="未保存" />
            <button
              class="close"
              title="关闭标签"
              aria-label="关闭标签"
              @click.stop="closeTabWithConfirm(tab)"
            >
              <Icon name="x" :size="11" />
            </button>
          </div>
        </div>
        <button
          v-if="tabsOverflow"
          class="tabs-arrow right"
          type="button"
          title="向右滚动标签"
          aria-label="向右滚动标签"
          :disabled="!canScrollRight"
          @click="scrollTabs(1)"
        >
          <Icon name="right" :size="11" />
        </button>
        <button
          class="iconbtn small tab-add"
          type="button"
          title="新建文稿"
          aria-label="新建文稿"
          @click="documents.newUntitled()"
        >
          <Icon name="plus" :size="14" />
        </button>
        <span v-if="tabDropActive" class="tabs-drop-hint" aria-hidden="true"> 松开以打开并锁定阅读 </span>
      </div>

      <div class="mode-switch" role="group" aria-label="编辑模式">
        <button
          v-for="mode in modes"
          :key="mode.value"
          :class="{ active: ui.mode === mode.value }"
          :title="mode.label"
          @click="ui.setMode(mode.value)"
        >
          <Icon :name="mode.icon" :size="13" />{{ mode.label }}
        </button>
      </div>

      <div v-if="ui.mode === 'live'" class="width-switch" role="group" aria-label="正文宽度">
        <button
          v-for="option in widths"
          :key="option.value"
          :class="{ active: ui.contentWidth === option.value }"
          :title="option.title"
          @click="ui.setContentWidth(option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <button
        class="iconbtn focus-toggle"
        :class="{ active: ui.focusMode }"
        :title="ui.focusMode ? '退出专注模式' : '专注模式'"
        :aria-label="ui.focusMode ? '退出专注模式' : '专注模式'"
        @click="ui.toggleFocus()"
      >
        <Icon name="expand" :size="15" />
        <span v-if="ui.focusMode">退出专注</span>
      </button>
    </div>

    <div class="formatbar">
      <div class="breadcrumb">
        {{ breadcrumb.root }}
        <template v-if="breadcrumb.path"><span>/</span>{{ breadcrumb.path }}</template>
      </div>
      <div class="format-actions">
        <button title="加粗 (Ctrl B)" aria-label="加粗" :disabled="ui.locked" @click="format('bold')">
          <b>B</b>
        </button>
        <button title="斜体 (Ctrl I)" aria-label="斜体" :disabled="ui.locked" @click="format('italic')">
          <i>I</i>
        </button>
        <button title="行内代码" aria-label="行内代码" :disabled="ui.locked" @click="format('code')">
          `
        </button>
        <span class="sep" />
        <button title="插入链接" aria-label="插入链接" :disabled="ui.locked" @click="insert('link')">
          <Icon name="link" :size="15" />
        </button>
        <button title="插入图片" aria-label="插入图片" :disabled="ui.locked" @click="insertImageElement">
          <Icon name="image" :size="15" />
        </button>
        <button title="插入表格" aria-label="插入表格" :disabled="ui.locked" @click="insert('table')">
          <Icon name="table" :size="15" />
        </button>
        <span class="sep" />
        <button
          title="撤销 (Ctrl Z)"
          aria-label="撤销"
          :disabled="ui.locked"
          @click="editorApi.current?.undo()"
        >
          <Icon name="undo" :size="15" />
        </button>
      </div>
      <button
        class="lock-toggle"
        :class="{ active: ui.locked }"
        :aria-pressed="ui.locked"
        :title="ui.locked ? '页面已锁定，点击解锁' : '锁定页面：只读，点击内容不再回到源码'"
        @click="toggleLock"
      >
        <Icon :name="ui.locked ? 'lock' : 'unlock'" :size="12" />{{ ui.locked ? '已锁定' : '锁定' }}
      </button>
      <div class="save-area">
        <template v-if="documents.activeTab?.saveState === 'conflict'">
          <button class="conflict-btn" @click="resolve('reload')">重新载入</button>
          <button class="conflict-btn" @click="resolve('overwrite')">覆盖</button>
          <button class="conflict-btn" @click="resolve('saveAs')">另存为</button>
        </template>
        <span v-else class="saved" :class="{ dirty: documents.activeTab?.snapshot.dirty }">
          <Icon :name="documents.activeTab?.snapshot.dirty ? 'pen' : 'check'" :size="12" />{{ saveText }}
        </span>
      </div>
    </div>

    <DocumentArea />
    <AiDock />
    <StatusBar />
  </section>
</template>

<style scoped>
.focus-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: auto;
  padding: 0 9px;
  font-size: 10px;
  color: var(--soft);
}

.focus-toggle.active {
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--card);
  color: var(--text);
}

.save-area {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.lock-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  flex-shrink: 0;
}

.lock-toggle:hover {
  color: var(--text);
  background: var(--hover);
}

.lock-toggle.active {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 32%, var(--line));
  background: color-mix(in srgb, var(--accent) 10%, var(--card));
}

.conflict-btn {
  font-size: 9px;
  color: #8d4436;
  border: 1px solid #e2c3ba;
  border-radius: 4px;
  padding: 2px 6px;
}

.doc-tab .close {
  background: none;
}

.doc-tab .close:hover {
  background: var(--hover);
}

.tabs-drop-hint {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--card) 80%, transparent);
  color: var(--accent);
  font-size: 11px;
  letter-spacing: 0.2px;
  pointer-events: none;
}
</style>
