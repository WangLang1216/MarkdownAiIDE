<script setup lang="ts">
/**
 * 左侧栏：元素 / 文件切换，支持点击与拖入正文。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'
import { useDocumentsStore } from '../stores/documents'
import {
  ELEMENT_SNIPPETS,
  EXTENDED_SNIPPETS,
  MODULE_SNIPPETS,
  importedTemplates,
  importContentTemplate,
  deleteContentTemplate
} from '../editor/snippets'
import { editorApi } from '../lib/editorApi'
import { insertImageElement } from '../lib/actions'
import { snippetGlyph, snippetIcon } from '../editor/elementBadges'
import { formatRecentTime, type RecentItem } from '@shared/recent'
import Icon from '../components/Icon.vue'

const ui = useUiStore()
const workspace = useWorkspaceStore()
const documents = useDocumentsStore()

/** 专注模式只保留元素区，隐藏元素/文件切换 */
const props = defineProps<{ focus?: boolean }>()
const activeTab = computed(() => (props.focus ? 'elements' : ui.leftTab))

const templateInput = ref<HTMLInputElement | null>(null)

async function importTemplates(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) {
    try {
      if (file.size > 512 * 1024) throw new Error('模板大小上限为 512 KB。')
      const text = await file.text()
      if (!text.trim()) throw new Error('模板为空。')
      importContentTemplate(file.name.replace(/\.(md|markdown|txt)$/i, ''), text)
      if (moduleCollapsed.value) toggleModules()
    } catch (error) {
      ui.toast((error as Error).message || '模板导入失败', 'error')
    }
  }
  input.value = ''
}

function removeTemplate(id: string): void {
  try {
    deleteContentTemplate(id)
  } catch (error) {
    ui.toast((error as Error).message || '删除模板失败', 'error')
  }
}

const elementQuery = ref('')
const fileQuery = ref('')
const elementSearch = ref<HTMLInputElement | null>(null)
const newInput = ref<HTMLInputElement | null>(null)

// 「最近」的“几分钟前”需要随时间走动，否则长时间停留时标签会停在旧值
const nowTick = ref(Date.now())
let nowTimer = 0

type PromptMode = 'file' | 'folder' | 'rename'
const prompt = ref<{ mode: PromptMode; parent: string; target?: string; value: string } | null>(null)

const ELEMENT_ORDER_KEY = 'moye.elementOrder'
const EXTENDED_ORDER_KEY = 'moye.extendedOrder'
const MODULE_ORDER_KEY = 'moye.moduleOrder'

/** 只接受已知 id，新版本新增的元素自动追加到末尾 */
function readOrder(key: string, fallback: string[]): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    const ids = parsed.filter((id): id is string => typeof id === 'string' && fallback.includes(id))
    return [...ids, ...fallback.filter((id) => !ids.includes(id))]
  } catch {
    return fallback
  }
}

const elementOrder = ref(
  readOrder(
    ELEMENT_ORDER_KEY,
    ELEMENT_SNIPPETS.map((item) => item.id)
  )
)
const extendedOrder = ref(
  readOrder(
    EXTENDED_ORDER_KEY,
    EXTENDED_SNIPPETS.map((item) => item.id)
  )
)
const moduleOrder = ref(
  readOrder(
    MODULE_ORDER_KEY,
    MODULE_SNIPPETS.map((item) => item.id)
  )
)
const headingCollapsed = ref(window.localStorage.getItem('moye.elementsCollapsed') === '1')
// 扩展元素默认收起：使用新键，避免沿用旧版“展开”的历史状态
const EXTENDED_COLLAPSED_KEY = 'moye.extendedCollapsedV3'
const extendedCollapsed = ref(window.localStorage.getItem(EXTENDED_COLLAPSED_KEY) === '1')
const MODULE_COLLAPSED_KEY = 'moye.modulesCollapsedV2'
const moduleCollapsed = ref(window.localStorage.getItem(MODULE_COLLAPSED_KEY) !== '0')
const reorder = ref<{ id: string; target: string | null } | null>(null)

const orderedElements = computed(() =>
  elementOrder.value
    .map((id) => ELEMENT_SNIPPETS.find((item) => item.id === id))
    .filter((item): item is (typeof ELEMENT_SNIPPETS)[number] => Boolean(item))
)
const orderedExtended = computed(() =>
  extendedOrder.value
    .map((id) => EXTENDED_SNIPPETS.find((item) => item.id === id))
    .filter((item): item is (typeof EXTENDED_SNIPPETS)[number] => Boolean(item))
)
const orderedModules = computed(() =>
  moduleOrder.value
    .map((id) => MODULE_SNIPPETS.find((item) => item.id === id))
    .filter((item): item is (typeof MODULE_SNIPPETS)[number] => Boolean(item))
    .concat(importedTemplates.value)
)

const filteredElements = computed(() =>
  orderedElements.value.filter(
    (item) =>
      !elementQuery.value || item.label.includes(elementQuery.value) || item.id.includes(elementQuery.value)
  )
)
const filteredExtended = computed(() =>
  orderedExtended.value.filter(
    (item) =>
      !elementQuery.value ||
      item.label.includes(elementQuery.value) ||
      item.id.includes(elementQuery.value) ||
      (item.description ?? '').includes(elementQuery.value)
  )
)
const filteredModules = computed(() =>
  orderedModules.value.filter(
    (item) =>
      !elementQuery.value || item.label.includes(elementQuery.value) || item.id.includes(elementQuery.value)
  )
)

function insert(id: string): void {
  if (!documents.activeId) {
    ui.toast('先打开一个文稿，再插入元素', 'warning')
    return
  }
  if (ui.locked) {
    ui.toast('文稿已锁定，解锁后再插入元素', 'warning')
    return
  }
  if (id === 'image') {
    void insertImageElement()
    return
  }
  editorApi.current?.insertSnippet(id)
  // 点击会把焦点留在按钮上，下一帧把焦点交还编辑器，选中状态才会显示
  window.requestAnimationFrame(() => editorApi.current?.focus())
}

function toggleHeading(): void {
  headingCollapsed.value = !headingCollapsed.value
  window.localStorage.setItem('moye.elementsCollapsed', headingCollapsed.value ? '1' : '0')
}

function toggleExtended(): void {
  extendedCollapsed.value = !extendedCollapsed.value
  window.localStorage.setItem(EXTENDED_COLLAPSED_KEY, extendedCollapsed.value ? '1' : '0')
}

function toggleModules(): void {
  moduleCollapsed.value = !moduleCollapsed.value
  window.localStorage.setItem(MODULE_COLLAPSED_KEY, moduleCollapsed.value ? '1' : '0')
}

function startDrag(event: DragEvent, id: string): void {
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

/** 拖动排序：只写入专用类型，避免被编辑器当成元素插入 */
function startReorder(event: DragEvent, id: string): void {
  reorder.value = { id, target: null }
  event.dataTransfer?.setData('application/x-mdide-element', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onReorderOver(id: string): void {
  if (reorder.value && reorder.value.id !== id) reorder.value.target = id
}

function moveInOrder(listRef: typeof elementOrder, key: string, source: string, target: string): void {
  const list = [...listRef.value]
  const from = list.indexOf(source)
  const to = list.indexOf(target)
  if (from < 0 || to < 0) return
  list.splice(from, 1)
  // 向下拖时插入到目标之后，向上拖时插入到目标之前
  list.splice(to, 0, source)
  listRef.value = list
  window.localStorage.setItem(key, JSON.stringify(list))
}

function finishReorder(targetId: string, kind: 'element' | 'extended' | 'module' = 'element'): void {
  const source = reorder.value?.id
  reorder.value = null
  if (!source || source === targetId) return
  if (kind === 'element') moveInOrder(elementOrder, ELEMENT_ORDER_KEY, source, targetId)
  else if (kind === 'extended') moveInOrder(extendedOrder, EXTENDED_ORDER_KEY, source, targetId)
  else moveInOrder(moduleOrder, MODULE_ORDER_KEY, source, targetId)
}

function endReorder(): void {
  reorder.value = null
}

function focusElementSearch(): void {
  ui.setLeftTab('elements')
  void nextTick(() => elementSearch.value?.focus())
}

onMounted(() => {
  window.addEventListener('focus-element-search', focusElementSearch)
  void workspace.load()
  nowTimer = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 60_000)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus-element-search', focusElementSearch)
  window.clearInterval(nowTimer)
})

let searchTimer = 0
function onFileSearch(): void {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    void workspace.search(fileQuery.value)
  }, 220)
}

function openFile(relativePath: string): void {
  void workspace.openFile(relativePath).catch((error: Error) => ui.toast(error.message, 'error'))
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])

function isImageRow(ext?: string): boolean {
  return Boolean(ext && IMAGE_EXTENSIONS.has(ext.toLowerCase()))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 图片在弹层中预览，文本仍按文稿打开 */
async function openTreeNode(row: { relativePath: string; ext?: string; name: string }): Promise<void> {
  if (!isImageRow(row.ext)) {
    openFile(row.relativePath)
    return
  }
  try {
    const data = await window.api.workspace.imagePreview(row.relativePath)
    ui.openImage(data.dataUrl, data.name, `${data.mime} · ${formatSize(data.size)}`)
  } catch (error) {
    ui.toast((error as Error).message || '图片预览失败', 'error')
  }
}

async function openSearchHit(relativePath: string, line: number): Promise<void> {
  await workspace.openFile(relativePath)
  const text = await window.api.workspace.readFile(relativePath).catch(() => '')
  const offset = text
    .split('\n')
    .slice(0, line - 1)
    .join('\n').length
  editorApi.current?.revealOffset(offset)
}

/** 切换「最近 / 全部文件」视图；切换时收起尚未提交的新建输入。 */
function switchScope(scope: 'recent' | 'tree'): void {
  prompt.value = null
  workspace.setFileScope(scope)
  // 「最近」按磁盘修改时间排序，切回来时重新扫描一次，避免显示过期时间
  if (scope === 'recent') void workspace.load()
}

async function openRecentItem(item: RecentItem): Promise<void> {
  try {
    if (item.kind === 'draft' && item.documentId) {
      await documents.restoreRecovery(item.documentId)
      return
    }
    if (item.relativePath) await workspace.openFile(item.relativePath)
  } catch (error) {
    ui.toast((error as Error).message || '打开文稿失败', 'error')
  }
}

/** 「最近」副行的位置说明：未关联工作区的草稿单独标注，避免误以为在根目录。 */
function recentLocation(item: RecentItem): string {
  if (item.parent) return item.parent
  return item.kind === 'draft' && !item.relativePath ? '本地草稿' : '根目录'
}

/** 删除「最近」中的记录：草稿只丢弃未保存内容，磁盘文稿仍走回收站流程。 */
async function removeRecentItem(item: RecentItem): Promise<void> {
  if (item.kind !== 'draft' || !item.documentId) {
    if (item.relativePath) await removeFile(item.relativePath)
    return
  }
  const documentId = item.documentId
  const confirmed = await ui.askConfirm({
    title: '删除未保存草稿',
    message: item.relativePath
      ? `将丢弃《${item.title}》尚未保存的修改，磁盘上的原文件不受影响，之后也不会再提示恢复。确定继续？`
      : `将丢弃《${item.title}》的全部内容，之后也不会再提示恢复。确定继续？`,
    confirmText: '删除',
    danger: true
  })
  if (!confirmed) return
  try {
    await documents.discardRecovery(documentId)
    ui.toast('已删除未保存草稿', 'success')
  } catch (error) {
    ui.toast((error as Error).message || '删除草稿失败', 'error')
  }
}

function beginCreate(mode: 'file' | 'folder'): void {
  prompt.value = { mode, parent: '', value: '' }
  void nextTick(() => newInput.value?.focus())
}

function beginRename(relativePath: string): void {
  prompt.value = {
    mode: 'rename',
    parent: workspace.dirname(relativePath),
    target: relativePath,
    value: relativePath.split('/').pop() ?? ''
  }
  void nextTick(() => newInput.value?.focus())
}

async function confirmPrompt(): Promise<void> {
  const value = prompt.value
  if (!value) return
  const name = value.value.trim()
  if (!name) {
    prompt.value = null
    return
  }
  try {
    if (value.mode === 'file') await workspace.createFile(value.parent, name)
    else if (value.mode === 'folder') await workspace.createFolder(value.parent, name)
    else if (value.target) await workspace.rename(value.target, name)
  } catch (error) {
    ui.toast((error as Error).message, 'error')
  } finally {
    prompt.value = null
  }
}

async function removeFile(relativePath: string): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: '删除文件',
    message: `将把 ${relativePath} 移入回收站或应用恢复区，可从系统中恢复。确定继续？`,
    confirmText: '删除',
    danger: true
  })
  if (!confirmed) return
  try {
    const openTab = documents.tabs.find((tab) => tab.snapshot.relativePath === relativePath)
    if (openTab) {
      await documents.close(openTab.snapshot.documentId, true)
      // 文稿已被删除，关闭时留下的未保存草稿也一并丢弃，避免下次提示恢复一个不存在的文件
      await documents.discardRecovery(openTab.snapshot.documentId)
    }
    await workspace.remove(relativePath)
  } catch (error) {
    ui.toast((error as Error).message, 'error')
  }
}

async function switchWorkspace(): Promise<void> {
  try {
    await workspace.openDialog()
  } catch (error) {
    ui.toast((error as Error).message, 'error')
  }
}
</script>

<template>
  <aside class="left-panel">
    <div v-if="!focus" class="switcher" role="tablist" aria-label="侧栏内容">
      <button
        role="tab"
        :aria-selected="ui.leftTab === 'elements'"
        :class="{ selected: ui.leftTab === 'elements' }"
        @click="ui.setLeftTab('elements')"
      >
        <Icon name="blocks" :size="15" />元素
      </button>
      <button
        role="tab"
        :aria-selected="ui.leftTab === 'files'"
        :class="{ selected: ui.leftTab === 'files' }"
        @click="ui.setLeftTab('files')"
      >
        <Icon name="folder" :size="15" />文件
      </button>
    </div>

    <section v-if="activeTab === 'elements'">
      <div class="searchbox">
        <Icon name="search" :size="14" />
        <input ref="elementSearch" v-model="elementQuery" placeholder="查找元素…" aria-label="查找元素" />
        <kbd>Ctrl K</kbd>
      </div>

      <div class="side-heading collapsible">
        <button
          class="heading-toggle"
          :aria-expanded="!headingCollapsed"
          aria-controls="element-grid"
          @click="toggleHeading"
        >
          <Icon :name="headingCollapsed ? 'right' : 'down'" :size="10" />
          基础元素
        </button>
        <span>拖放或点击插入</span>
      </div>
      <div v-show="!headingCollapsed || elementQuery" id="element-grid" class="element-grid">
        <div
          v-for="item in filteredElements"
          :key="item.id"
          class="element-cell"
          :class="{ 'drop-target': reorder?.target === item.id, sorting: reorder?.id === item.id }"
          draggable="true"
          @dragstart="startDrag($event, item.id)"
          @dragend="endReorder"
          @dragover.prevent="onReorderOver(item.id)"
          @drop.prevent.stop="finishReorder(item.id)"
        >
          <button
            class="element-tile"
            :aria-label="`插入${item.label}`"
            :title="`点击或拖动插入${item.label}`"
            @click="insert(item.id)"
          >
            <span v-if="snippetGlyph(item)" class="glyph">{{ snippetGlyph(item) }}</span>
            <Icon v-else :name="snippetIcon(item)" :size="15" />
            <span class="label">{{ item.label }}</span>
          </button>
          <span
            class="reorder-grip"
            draggable="true"
            title="拖动调整顺序"
            aria-label="拖动调整顺序"
            @dragstart.stop="startReorder($event, item.id)"
            @click.stop
            >⠿</span
          >
        </div>
      </div>
      <p v-if="!filteredElements.length" class="tree-empty">没有匹配的元素</p>

      <div class="side-heading section-space collapsible">
        <button
          class="heading-toggle"
          :aria-expanded="!extendedCollapsed"
          aria-controls="extended-list"
          @click="toggleExtended"
        >
          <Icon :name="extendedCollapsed ? 'right' : 'down'" :size="10" />
          扩展元素
        </button>
      </div>
      <div v-show="!extendedCollapsed || elementQuery" id="extended-list" class="element-grid">
        <div
          v-for="item in filteredExtended"
          :key="item.id"
          class="element-cell"
          :class="{ 'drop-target': reorder?.target === item.id, sorting: reorder?.id === item.id }"
          @dragover.prevent="onReorderOver(item.id)"
          @drop.prevent.stop="finishReorder(item.id, 'extended')"
        >
          <button
            class="element-tile"
            draggable="true"
            :title="`点击或拖动插入${item.label}`"
            @click="insert(item.id)"
            @dragstart="startDrag($event, item.id)"
            @dragend="endReorder"
          >
            <span v-if="snippetGlyph(item)" class="glyph">{{ snippetGlyph(item) }}</span>
            <Icon v-else :name="snippetIcon(item)" :size="15" />
            <span class="label">{{ item.label }}</span>
          </button>
          <span
            class="reorder-grip"
            draggable="true"
            title="拖动调整顺序"
            aria-label="拖动调整顺序"
            @dragstart.stop="startReorder($event, item.id)"
            @click.stop
            >⠿</span
          >
        </div>
      </div>
      <p v-if="!filteredExtended.length" class="tree-empty">没有匹配的扩展元素</p>

      <div class="side-heading section-space collapsible">
        <button
          class="heading-toggle"
          :aria-expanded="!moduleCollapsed"
          aria-controls="module-list"
          @click="toggleModules"
        >
          <Icon :name="moduleCollapsed ? 'right' : 'down'" :size="10" />
          内容模板
        </button>
        <button class="textbtn" @click="templateInput?.click()">导入模板</button>
        <input
          ref="templateInput"
          type="file"
          accept=".md,.markdown,.txt"
          multiple
          hidden
          @change="importTemplates"
        />
      </div>
      <div v-show="!moduleCollapsed || elementQuery" id="module-list" class="module-list">
        <div
          v-for="item in filteredModules"
          :key="item.id"
          class="module-cell"
          :class="{ 'drop-target': reorder?.target === item.id, sorting: reorder?.id === item.id }"
          @dragover.prevent="onReorderOver(item.id)"
          @drop.prevent.stop="finishReorder(item.id, 'module')"
        >
          <button
            class="module-button"
            draggable="true"
            :title="`点击或拖动插入${item.label}`"
            @click="insert(item.id)"
            @dragstart="startDrag($event, item.id)"
            @dragend="endReorder"
          >
            <span class="module-icon">
              <span v-if="item.id === 'math'" class="math-icon">ƒ</span>
              <Icon v-else :name="item.icon ?? (item.id === 'mermaid' ? 'workflow' : 'file')" :size="15" />
            </span>
            <span
              >{{ item.label }}<small>{{ item.description }}</small></span
            >
          </button>
          <button
            v-if="item.id.startsWith('imported-')"
            type="button"
            class="template-delete iconbtn"
            :aria-label="'删除模板 ' + item.label"
            @click.stop="removeTemplate(item.id)"
          >
            <Icon name="x" :size="12" />
          </button>
          <span
            v-else
            class="reorder-grip"
            draggable="true"
            title="拖动调整顺序"
            aria-label="拖动调整顺序"
            @dragstart.stop="startReorder($event, item.id)"
            @click.stop
            >⠿</span
          >
        </div>
      </div>
      <p v-if="!filteredModules.length" class="tree-empty">没有匹配的模块</p>

      <div class="sidebar-tip">
        <Icon name="mouse" :size="15" />
        <div>
          写作，从一个元素开始<small>拖入正文，或输入 <kbd>/</kbd> 快速插入</small>
        </div>
      </div>
    </section>

    <section v-else>
      <div class="folder-row">
        <Icon name="folder-open" :size="14" />
        <b :title="workspace.info?.rootPath">{{ workspace.info?.name ?? '未打开工作区' }}</b>
        <button class="iconbtn small" title="打开工作区" aria-label="打开工作区" @click="switchWorkspace">
          <Icon name="folder-plus" :size="14" />
        </button>
      </div>

      <div class="searchbox">
        <Icon name="search" :size="14" />
        <input
          v-model="fileQuery"
          placeholder="搜索文件或内容…"
          aria-label="搜索文件"
          @input="onFileSearch"
        />
      </div>

      <div v-if="!workspace.info" class="empty-state">
        <Icon name="folder" :size="24" />
        <p>打开一个工作区，开始整理文稿</p>
        <button class="ghostbtn" @click="switchWorkspace">选择目录</button>
      </div>

      <template v-else>
        <div class="scope-switch" role="tablist" aria-label="文件视图">
          <button
            role="tab"
            :aria-selected="workspace.fileScope === 'recent'"
            :class="{ selected: workspace.fileScope === 'recent' }"
            @click="switchScope('recent')"
          >
            <Icon name="history" :size="12" />最近
          </button>
          <button
            role="tab"
            :aria-selected="workspace.fileScope === 'tree'"
            :class="{ selected: workspace.fileScope === 'tree' }"
            @click="switchScope('tree')"
          >
            <Icon name="folder" :size="12" />全部文件
          </button>
        </div>

        <div v-if="!workspace.searchQuery && workspace.fileScope === 'recent'" class="recent-list">
          <div class="side-heading">
            最近编辑<span>{{ workspace.recentItems.length }} 篇</span>
          </div>
          <div
            v-for="item in workspace.recentItems"
            :key="item.key"
            class="recent-row"
            :class="{
              active: item.relativePath && documents.activeTab?.snapshot.relativePath === item.relativePath
            }"
            :title="item.relativePath ?? item.title"
            @click="openRecentItem(item)"
          >
            <Icon :name="item.kind === 'draft' ? 'history' : 'file'" :size="12" />
            <span class="recent-main">
              <span class="label">{{ item.title }}</span>
              <small>{{ recentLocation(item) }} · {{ formatRecentTime(item.editedAt, nowTick) }}</small>
            </span>
            <span v-if="item.unsaved" class="recent-badge">未保存</span>
            <span class="row-actions" @click.stop>
              <button title="删除" aria-label="删除" @click="removeRecentItem(item)">
                <Icon name="trash" :size="12" />
              </button>
            </span>
          </div>
          <p v-if="!workspace.recentItems.length" class="tree-empty">还没有最近编辑的文稿</p>
        </div>

        <div class="tree" v-else-if="!workspace.searchQuery">
          <div class="tree-actions">
            <button class="textbtn" @click="beginCreate('file')">+ 新建文稿</button>
            <button class="textbtn" @click="beginCreate('folder')">+ 新建目录</button>
          </div>
          <template v-for="row in workspace.visibleRows" :key="row.relativePath">
            <div
              v-if="row.kind === 'directory'"
              class="tree-row"
              :style="{ paddingLeft: `${6 + row.depth * 13}px` }"
              @click="workspace.toggle(row.relativePath)"
            >
              <Icon :name="workspace.expanded.has(row.relativePath) ? 'down' : 'right'" :size="10" />
              <Icon :name="workspace.expanded.has(row.relativePath) ? 'folder-open' : 'folder'" :size="13" />
              <span class="label">{{ row.name }}</span>
            </div>
            <div
              v-else
              class="tree-row"
              :class="{ active: documents.activeTab?.snapshot.relativePath === row.relativePath }"
              :style="{ paddingLeft: `${8 + row.depth * 13}px` }"
              @click="openTreeNode(row)"
            >
              <Icon :name="isImageRow(row.ext) ? 'image' : 'file'" :size="12" />
              <span class="label">{{ row.name }}</span>
              <span class="row-actions" @click.stop>
                <button title="重命名" aria-label="重命名" @click="beginRename(row.relativePath)">
                  <Icon name="pen" :size="12" />
                </button>
                <button title="删除" aria-label="删除" @click="removeFile(row.relativePath)">
                  <Icon name="trash" :size="12" />
                </button>
              </span>
            </div>
          </template>
          <p v-if="!workspace.visibleRows.length" class="tree-empty">没有匹配的文件</p>
        </div>

        <div v-else class="search-results">
          <div class="side-heading">
            搜索结果<span>{{ workspace.searchResults.length }} 处</span>
          </div>
          <button
            v-for="(hit, index) in workspace.searchResults"
            :key="`${hit.relativePath}-${index}`"
            class="search-hit"
            @click="openSearchHit(hit.relativePath, hit.line)"
          >
            <b>{{ hit.relativePath }} · 第 {{ hit.line }} 行</b>
            <small>{{ hit.excerpt }}</small>
          </button>
          <p v-if="!workspace.searchResults.length" class="tree-empty">没有找到匹配内容</p>
        </div>
      </template>

      <div class="sidebar-tip">
        <Icon name="harddrive" :size="15" />
        <div>本地文件，随时可用<small>文稿保存在你的设备中，AI 只在授权范围内读取</small></div>
      </div>
    </section>

    <div v-if="prompt" class="inline-prompt" @keydown.stop>
      <label>{{
        prompt.mode === 'file' ? '新建文稿' : prompt.mode === 'folder' ? '新建目录' : '重命名'
      }}</label>
      <input
        ref="newInput"
        v-model="prompt.value"
        :placeholder="prompt.mode === 'file' ? '名称.md' : '名称'"
        @keydown.enter.prevent="confirmPrompt"
        @keydown.esc.prevent="prompt = null"
      />
      <div class="inline-actions">
        <button class="textbtn" @click="prompt = null">取消</button>
        <button class="darkbtn" @click="confirmPrompt">确定</button>
      </div>
    </div>

    <div class="left-footer">
      <button @click="ui.modal = 'providers'"><Icon name="sparkles" :size="14" />模型服务</button>
      <button @click="ui.modal = 'appearance'"><Icon name="settings" :size="14" />偏好设置</button>
    </div>
  </aside>
</template>

<style scoped>
.searchbox input:focus-visible {
  outline: none;
}
.template-delete {
  position: absolute;
  right: 4px;
  top: 4px;
  width: 22px;
  height: 22px;
}
</style>
