<script setup lang="ts">
/**
 * 编辑器宿主：负责 CodeMirror 生命周期、与 Store 双向同步、主进程桥接与拖放。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useDocumentsStore } from '../stores/documents'
import { useSettingsStore } from '../stores/settings'
import { useAgentStore } from '../stores/agent'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'
import { EditorController } from './createEditor'
import SelectionMenu from './SelectionMenu.vue'
import EmojiPicker from './EmojiPicker.vue'
import { editorApi } from '../lib/editorApi'
import { insertImageElement } from '../lib/actions'

type ContextAction =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link'
  | 'clear'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'

const emit = defineEmits<{
  scroll: [ratio: number]
  selection: [info: { from: number; to: number }]
  cursorLine: [line: number]
}>()

const documents = useDocumentsStore()
const settings = useSettingsStore()
const agent = useAgentStore()
const ui = useUiStore()
const workspace = useWorkspaceStore()

const host = ref<HTMLElement | null>(null)
const controller = shallowRef<EditorController | null>(null)
const dragging = ref(false)
const menu = ref<{ x: number; y: number; hasSelection: boolean } | null>(null)
const emojiPicker = ref<{ from: number; to: number; x: number; y: number } | null>(null)
let pendingSelection: { from: number; to: number } | null = null
let unregisterBridge: (() => void) | null = null
let autoTimer = 0
let currentLoadedId: string | null = null

/** 自动预测的最短上下文：短诗、短句也应能续写，只挡掉空文档和刚起笔的一两个字 */
const AUTO_PREDICT_MIN_CHARS = 4

const activeSnapshot = computed(() => documents.activeTab?.snapshot ?? null)
const isEmpty = computed(() => !documents.activeId || !activeSnapshot.value)

function themeScope(): string | null {
  const theme = settings.activeTheme
  return theme.kind === 'imported' ? (theme.cssScopeId ?? null) : null
}

/** 文档切换时载入新状态；同一文档的外部更新只替换文本 */
/** 将活动标签及当前视图设置同步到 CodeMirror。 */
function syncEditor(): void {
  const controllerRef = controller.value
  if (!controllerRef) return
  const snapshot = activeSnapshot.value
  if (!snapshot) {
    currentLoadedId = null
    controllerRef.loadDocument('', null)
    controllerRef.setEditable(false)
    return
  }
  controllerRef.setEditable(!ui.locked)
  if (currentLoadedId !== snapshot.documentId) {
    currentLoadedId = snapshot.documentId
    controllerRef.loadDocument(snapshot.text, snapshot.documentId)
    return
  }
  if (controllerRef.getText() !== snapshot.text) {
    controllerRef.setText(snapshot.text)
  }
}

/** 在适合自动续写的编辑场景下，按设置防抖请求候选。 */
function scheduleAutoPrediction(): void {
  window.clearTimeout(autoTimer)
  if (!settings.settings.prediction.enabled || !settings.settings.prediction.auto) return
  if (agent.isRunning || !controller.value || controller.value.isComposing()) return
  if (controller.value.getText().trim().length < AUTO_PREDICT_MIN_CHARS) return
  autoTimer = window.setTimeout(() => {
    void agent.requestPrediction('auto')
  }, settings.settings.prediction.debounceMs)
}

/** 图片同时写入文稿资源目录并作为 AI 参考；未打开文稿时仅作参考 */
async function handleImageFile(file: File): Promise<void> {
  if (ui.locked) {
    ui.toast('文稿已锁定，解锁后再插入图片或附件', 'warning')
    return
  }
  try {
    const buffer = await file.arrayBuffer()
    const name = file.name || '粘贴的图片.png'
    void agent.addAttachmentBytes(name, file.type, buffer)
    if (!documents.activeId) {
      ui.toast('已添加为 AI 参考图片（先打开文稿才能写入本地图片）', 'info')
      return
    }
    const saved = await window.api.documents.saveImage(documents.activeId, name, file.type, buffer)
    const alt = saved.alt.replace(/[[\]]/g, ' ')
    editorApi.current?.insertText(`\n![${alt}](./${saved.relativePath})\n`)
    void workspace.load()
    ui.toast('图片已复制到资源目录并插入文稿', 'success')
  } catch (error) {
    ui.toast((error as Error).message || '图片处理失败', 'error')
  }
}

function onEditorMouseDown(event: MouseEvent): void {
  // 锁定态把左键事件留给浏览器：可像普通网页一样拖选表格、公式与正文并复制
  if (ui.locked) {
    if (event.button === 0) event.stopPropagation()
    return
  }
  if (event.button !== 2) return
  pendingSelection = controller.value?.getSelection() ?? null
}

/** 锁定态同时放行双击选词，避免 CodeMirror 接管后无法选中 */
function onEditorDblClick(event: MouseEvent): void {
  if (ui.locked) event.stopPropagation()
}

/**
 * 锁定态接管复制：按浏览器原生选区输出成稿文字与 HTML。
 * 否则 CodeMirror 会把握手后的选区当作源码选区，复制出 **、## 等标记。
 */
function onEditorCopy(event: ClipboardEvent): void {
  if (!ui.locked) return
  const selection = window.getSelection()
  const text = selection?.toString() ?? ''
  if (!selection || !text) return
  event.preventDefault()
  // 阻断 CodeMirror 的 copy 处理器，否则它会把结果改写成源码选区
  event.stopPropagation()
  event.clipboardData?.setData('text/plain', text)
  const range = selection.rangeCount ? selection.getRangeAt(0) : null
  if (!range) return
  const holder = document.createElement('div')
  holder.append(range.cloneContents())
  event.clipboardData?.setData('text/html', holder.innerHTML)
}

function onContextMenu(event: MouseEvent): void {
  const editor = controller.value
  if (!editor || !host.value) return
  event.preventDefault()
  const current = editor.getSelection()
  let selection = current
  // 右键可能让光标先收起：恢复按下右键前的选区，保证样式作用在原文字上
  if (
    !ui.locked &&
    current.from === current.to &&
    pendingSelection &&
    pendingSelection.from !== pendingSelection.to
  ) {
    selection = pendingSelection
    editor.setSelection(selection.from, selection.to)
  }
  const rect = host.value.getBoundingClientRect()
  const selectedText = ui.locked ? (window.getSelection()?.toString() ?? '') : ''
  menu.value = {
    x: Math.max(6, Math.min(event.clientX - rect.left, rect.width - 200)),
    y: Math.max(6, Math.min(event.clientY - rect.top, rect.height - 300)),
    hasSelection: ui.locked ? selectedText.length > 0 : selection.from !== selection.to
  }
}

function closeMenu(): void {
  menu.value = null
}

/** 关闭编辑区浮层：右键菜单与表情面板 */
function closeOverlays(): void {
  menu.value = null
  emojiPicker.value = null
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeOverlays()
}

/** 计算表情面板相对编辑区的位置；锚点不在可视区时返回 null */
function emojiPosition(range: { from: number; to: number }): { x: number; y: number } | null {
  const view = controller.value?.view
  const hostEl = host.value
  if (!view || !hostEl) return null
  const position = Math.max(0, Math.min(range.from, view.state.doc.length))
  const coords = view.coordsAtPos(position)
  if (!coords) return null
  // 锚点滚出可视区就不再跟随，直接收起面板
  const scroller = view.scrollDOM.getBoundingClientRect()
  if (coords.bottom < scroller.top || coords.top > scroller.bottom) return null
  const rect = hostEl.getBoundingClientRect()
  const width = 306
  const height = 300
  let x = coords.left - rect.left
  let y = coords.bottom - rect.top + 8
  if (x + width > rect.width - 8) x = Math.max(8, rect.width - width - 8)
  if (y + height > rect.height - 8) y = Math.max(8, coords.top - rect.top - height - 8)
  return { x, y }
}

/** 表情简码插入后在光标下方弹出选择器，必要时上移或左移，避免超出编辑区 */
function openEmojiPicker(range: { from: number; to: number }): void {
  const position = emojiPosition(range) ?? { x: 24, y: 24 }
  emojiPicker.value = { ...range, ...position }
}

/** 滚动时让面板跟着表情走，表情滚出可视区则关闭 */
function repositionEmojiPicker(): void {
  const picker = emojiPicker.value
  if (!picker) return
  const position = emojiPosition(picker)
  if (!position) {
    emojiPicker.value = null
    return
  }
  if (position.x !== picker.x || position.y !== picker.y) {
    emojiPicker.value = { ...picker, ...position }
  }
}

/** 编辑区滚动：右键菜单直接收起，表情面板跟随锚点 */
function onEditorScroll(): void {
  menu.value = null
  repositionEmojiPicker()
}

function closeEmojiPicker(): void {
  emojiPicker.value = null
}

/** 点击表情面板以外的区域时收起，避免面板遮住正文 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!emojiPicker.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.emoji-picker')) return
  closeEmojiPicker()
}

/** 用选中的简码替换刚插入的表情，光标停在后面可继续输入 */
function pickEmoji(name: string): void {
  const picker = emojiPicker.value
  if (!picker) return
  emojiPicker.value = null
  controller.value?.replaceRange(picker.from, picker.to, `:${name}:`)
}

/** 锁定态全选渲染后的正文，供直接复制（包含表格、公式与图片说明） */
function selectRenderedContent(): void {
  const content = host.value?.querySelector('.cm-content')
  const selection = window.getSelection()
  if (!content || !selection) return
  const range = document.createRange()
  range.selectNodeContents(content)
  selection.removeAllRanges()
  selection.addRange(range)
}

async function runMenuAction(action: ContextAction): Promise<void> {
  const editor = controller.value
  menu.value = null
  if (!editor) return
  switch (action) {
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strike':
    case 'code':
      editor.wrapSelection(action)
      break
    case 'link':
      editor.wrapLink()
      break
    case 'clear':
      editor.clearInlineFormat()
      break
    case 'selectAll':
      if (ui.locked) {
        selectRenderedContent()
        break
      }
      editor.selectAll()
      editor.focus()
      break
    case 'copy': {
      // 锁定态取浏览器原生选区，复制到的就是屏幕上看到的成稿文字
      if (ui.locked) {
        const text = window.getSelection()?.toString() ?? ''
        if (text) await window.api.app.writeClipboardText(text).catch(() => undefined)
        break
      }
      const range = editor.getSelection()
      const text = editor.getText().slice(range.from, range.to)
      if (text) await navigator.clipboard.writeText(text).catch(() => undefined)
      break
    }
    case 'cut': {
      const range = editor.getSelection()
      const text = editor.getText().slice(range.from, range.to)
      if (text) {
        await navigator.clipboard.writeText(text).catch(() => undefined)
        editor.applyEdits([{ from: range.from, to: range.to, insert: '' }])
      }
      break
    }
    case 'paste': {
      const text = await window.api.app.readClipboardText().catch(() => '')
      if (text) editor.insertText(text)
      break
    }
  }
}

onMounted(() => {
  if (!host.value) return
  const instance = new EditorController(
    host.value,
    {
      documentId: activeSnapshot.value?.documentId ?? null,
      mode: ui.mode,
      dark: settings.isDark,
      loadRemoteImages: settings.settings.editor.loadRemoteImages,
      lineNumbers: settings.settings.editor.showLineNumbers,
      typewriter: settings.settings.editor.typewriter,
      spellcheck: false,
      themeScope: themeScope(),
      locked: ui.locked
    },
    {
      onTextChange: (text) => {
        closeEmojiPicker()
        documents.onEditorText(text)
        scheduleAutoPrediction()
      },
      onSelection: (selection, lineNumber, _lineText, docChanged) => {
        emit('selection', selection)
        emit('cursorLine', lineNumber)
        if (!docChanged && editorApi.current?.hasGhost()) editorApi.current.clearGhost()
        if (!docChanged) window.clearTimeout(autoTimer)
      },
      onScroll: (ratio) => emit('scroll', ratio),
      onEmojiInserted: (range) => openEmojiPicker(range)
    }
  )
  controller.value = instance
  editorApi.current = instance
  syncEditor()

  instance.view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })
  // CodeMirror 会拦截冒泡阶段的右键事件，这里用捕获阶段先拿到选区与坐标
  host.value?.addEventListener('mousedown', onEditorMouseDown, true)
  host.value?.addEventListener('dblclick', onEditorDblClick, true)
  host.value?.addEventListener('copy', onEditorCopy, true)
  host.value?.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('pointerdown', closeOverlays)
  document.addEventListener('keydown', onMenuKeydown)

  // 图片粘贴：作为参考附件，不直接写入正文
  instance.view.dom.addEventListener('paste', (event: ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (!file) continue
      event.preventDefault()
      void handleImageFile(file)
      break
    }
  })

  unregisterBridge = window.api.bridge.onRequest((request) => {
    if (request.type === 'sync') {
      return {
        requestId: request.requestId,
        ok: true,
        text: documents.currentTextFor(request.documentId),
        revision: documents.tabs.find((tab) => tab.snapshot.documentId === request.documentId)?.snapshot
          .revision
      }
    }
    if (request.type === 'reveal') {
      if (documents.activeId === request.documentId) {
        controller.value?.revealOffset(request.from)
      }
      return { requestId: request.requestId, ok: true }
    }
    const text = documents.applyRemoteEdits(request.documentId, request.edits, request.reveal)
    if (text === null) {
      return {
        requestId: request.requestId,
        ok: false,
        error: { code: 'FILE_NOT_FOUND', message: '目标文档未在编辑器中打开。' }
      }
    }
    return { requestId: request.requestId, ok: true, text, revision: request.expectedRevision + 1 }
  })
})

onBeforeUnmount(() => {
  window.clearTimeout(autoTimer)
  host.value?.removeEventListener('mousedown', onEditorMouseDown, true)
  host.value?.removeEventListener('dblclick', onEditorDblClick, true)
  host.value?.removeEventListener('copy', onEditorCopy, true)
  host.value?.removeEventListener('contextmenu', onContextMenu, true)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('pointerdown', closeMenu)
  document.removeEventListener('keydown', onMenuKeydown)
  unregisterBridge?.()
  editorApi.current = null
  controller.value?.destroy()
})

watch(
  () => documents.activeId,
  () => {
    closeOverlays()
    syncEditor()
  }
)
watch(
  () => activeSnapshot.value?.revision,
  () => {
    const controllerRef = controller.value
    const snapshot = activeSnapshot.value
    if (!controllerRef || !snapshot) return
    if (currentLoadedId !== snapshot.documentId) return
    if (controllerRef.getText() !== snapshot.text) controllerRef.setText(snapshot.text)
  }
)

watch(
  () => ui.mode,
  (mode) => controller.value?.setMode(mode)
)
watch(
  () => ui.locked,
  (locked) => {
    const controllerRef = controller.value
    if (!controllerRef) return
    if (locked) closeOverlays()
    controllerRef.setLocked(locked)
    // 没有打开的文稿时保持不可编辑，避免解锁后写入无主缓冲区
    if (!documents.activeId) controllerRef.setEditable(false)
  }
)
watch(
  () => settings.isDark,
  (dark) => controller.value?.setDark(dark)
)
watch(
  () => settings.settings.editor.loadRemoteImages,
  (value) => controller.value?.setLoadRemoteImages(value)
)
watch(
  () => settings.settings.editor.showLineNumbers,
  (value) => controller.value?.setLineNumbers(value)
)
watch(
  () => settings.settings.editor.typewriter,
  (value) => controller.value?.setTypewriter(value)
)
watch(
  () => settings.activeTheme.themeId,
  () => controller.value?.setTextAttributes(themeScope())
)

function onDragOver(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dragging.value = true
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const files = event.dataTransfer?.files
  if (files?.length) {
    event.preventDefault()
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      void handleImageFile(file)
      break
    }
    return
  }
  const id = event.dataTransfer?.getData('text/plain')
  if (!id) return
  event.preventDefault()
  if (ui.locked) {
    ui.toast('文稿已锁定，解锁后再插入内容', 'warning')
    return
  }
  if (id === 'image') {
    void insertImageElement()
    return
  }
  controller.value?.insertSnippet(id)
}

/** 供父组件把键盘焦点交还给当前编辑视图。 */
defineExpose({ focus: () => controller.value?.focus() })
</script>

<template>
  <div
    ref="host"
    class="editor-host"
    :class="{ 'drag-over': dragging }"
    @dragover="onDragOver"
    @dragleave="dragging = false"
    @drop="onDrop"
  >
    <div v-if="isEmpty" class="editor-empty">
      <p>还没有打开的文档</p>
      <button class="ghostbtn" @click="documents.newUntitled()">新建文稿</button>
    </div>
    <SelectionMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :has-selection="menu.hasSelection"
      :locked="ui.locked"
      @action="runMenuAction"
      @close="closeMenu"
    />
    <EmojiPicker
      v-if="emojiPicker"
      :x="emojiPicker.x"
      :y="emojiPicker.y"
      @pick="pickEmoji"
      @close="closeEmojiPicker"
    />
  </div>
</template>

<style scoped>
.editor-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--page);
}

.editor-host :deep(.cm-editor) {
  flex: 1;
  min-height: 0;
}

.editor-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--muted);
  font-size: 12px;
  pointer-events: none;
}

.editor-empty button {
  pointer-events: auto;
}
</style>
