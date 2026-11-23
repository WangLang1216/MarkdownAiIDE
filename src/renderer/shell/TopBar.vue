<script setup lang="ts">
/**
 * 顶部栏：品牌、菜单、当前文稿、外观与导出、窗口控制。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useDocumentsStore } from '../stores/documents'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useUpdatesStore } from '../stores/updates'
import {
  closeTabWithConfirm,
  newDocument,
  openDocument,
  openWorkspace,
  saveActive,
  saveAsActive,
  togglePageLock
} from '../lib/actions'
import {
  exportHtml,
  exportMarkdownBundle,
  exportMarkdownInline,
  exportPdf,
  exportWithPandoc,
  importWithPandoc
} from '../lib/exporter'
import Icon from '../components/Icon.vue'
import { editorApi } from '../lib/editorApi'

interface MenuEntry {
  label?: string
  shortcut?: string
  action?: () => void
  disabled?: boolean
  separator?: boolean
}

type MenuName = 'file' | 'edit' | 'view' | 'help' | 'export'

const documents = useDocumentsStore()
const settings = useSettingsStore()
const ui = useUiStore()
const updates = useUpdatesStore()

const openMenu = ref<MenuName | null>(null)
const menuPosition = ref({ x: 0, y: 0 })
const isMaximized = ref(false)

const title = computed(() => documents.activeTab?.snapshot.title ?? '未打开文稿')

function positionFor(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  menuPosition.value = {
    x: Math.min(rect.left, window.innerWidth - 300),
    y: rect.bottom + 6
  }
}

function toggle(menu: MenuName, event: MouseEvent): void {
  if (openMenu.value === menu) {
    openMenu.value = null
    return
  }
  positionFor(event)
  openMenu.value = menu
}

function run(action?: () => void): void {
  openMenu.value = null
  if (action) action()
}

const recentFiles = computed<MenuEntry[]>(() =>
  settings.settings.recentFiles.slice(0, 5).map((entry) => ({
    label: entry.title,
    action: () =>
      void documents.openPath(entry.path).catch((error: Error) => ui.toast(error.message, 'error'))
  }))
)

/** 在当前宽度档位前加勾选标记，菜单里能直接看出生效项 */
function widthLabel(value: 'default' | 'full' | 'narrow', text: string): string {
  return ui.contentWidth === value ? `✓ ${text}` : `　 ${text}`
}

const fileMenu = computed<MenuEntry[]>(() => [
  { label: '新建文稿', shortcut: 'Ctrl N', action: () => void newDocument() },
  { label: '打开 Markdown…', shortcut: 'Ctrl O', action: () => void openDocument() },
  { label: '打开工作区…', action: () => void openWorkspace() },
  ...(recentFiles.value.length ? [{ separator: true }, { label: '最近打开' }, ...recentFiles.value] : []),
  { separator: true },
  { label: '保存', shortcut: 'Ctrl S', action: () => void saveActive(), disabled: !documents.activeTab },
  {
    label: '另存为…',
    shortcut: 'Ctrl Shift S',
    action: () => void saveAsActive(),
    disabled: !documents.activeTab
  },
  {
    label: '关闭标签',
    shortcut: 'Ctrl W',
    action: () => {
      const tab = documents.activeTab
      if (tab) void closeTabWithConfirm(tab)
    },
    disabled: !documents.activeTab
  },
  { separator: true },
  { label: '导入 DOCX / ODT / HTML / EPUB…', action: () => void importWithPandoc() },
  { label: '导出…', action: () => openExportMenu() }
])

const editMenu = computed<MenuEntry[]>(() => [
  { label: '撤销', shortcut: 'Ctrl Z', action: () => editorUndo(), disabled: !documents.activeTab },
  { label: '重做', shortcut: 'Ctrl Shift Z', action: () => editorRedo(), disabled: !documents.activeTab },
  { separator: true },
  {
    label: '查找与替换',
    shortcut: 'Ctrl F',
    action: () => (ui.findOpen = true),
    disabled: !documents.activeTab
  },
  { separator: true },
  {
    label: '全选',
    shortcut: 'Ctrl A',
    action: () => editorApi.current?.selectAll(),
    disabled: !documents.activeTab
  }
])

const viewMenu = computed<MenuEntry[]>(() => [
  { label: '即时渲染', action: () => ui.setMode('live') },
  { label: '源码', action: () => ui.setMode('source') },
  { label: '源码 / 预览分屏', action: () => ui.setMode('split') },
  { separator: true },
  { label: widthLabel('default', '正文宽度：默认居中'), action: () => ui.setContentWidth('default') },
  { label: widthLabel('full', '正文宽度：铺满'), action: () => ui.setContentWidth('full') },
  { label: widthLabel('narrow', '正文宽度：较窄居中'), action: () => ui.setContentWidth('narrow') },
  { separator: true },
  {
    label: ui.locked ? '解锁页面' : '锁定页面（只读）',
    action: () => togglePageLock()
  },
  { separator: true },
  { label: ui.outlineVisible ? '隐藏目录' : '显示目录', action: () => ui.toggleOutline() },
  { label: ui.focusMode ? '退出专注模式' : '专注模式', action: () => ui.toggleFocus() },
  {
    label: settings.settings.editor.typewriter ? '关闭打字机模式' : '打字机模式',
    action: () => void settings.update({ editor: { typewriter: !settings.settings.editor.typewriter } })
  },
  { separator: true },
  { label: '外观与文稿主题…', action: () => (ui.modal = 'appearance') },
  { label: '模型服务…', action: () => (ui.modal = 'providers') },
  { label: '导出设置…', action: () => (ui.modal = 'appearance') }
])

const helpMenu = computed<MenuEntry[]>(() => [
  { label: '快捷键与使用提示', action: () => (ui.modal = 'shortcuts') },
  { label: '打开本地数据目录', action: () => void window.api.app.openUserData() },
  { separator: true },
  { label: '关于小彭友', action: () => (ui.modal = 'about') }
])

const exportMenu = computed<MenuEntry[]>(() => [
  { label: 'Markdown（含图片压缩包）', shortcut: '.zip', action: () => void exportMarkdownBundle() },
  { label: 'Markdown（单文件 Base64）', shortcut: '.md', action: () => void exportMarkdownInline() },
  { label: '带样式 HTML', shortcut: '.html', action: () => void exportHtml(true) },
  { label: '无样式 HTML', shortcut: '.html', action: () => void exportHtml(false) },
  { label: 'PDF 文档', shortcut: '.pdf', action: () => void exportPdf() },
  { separator: true },
  { label: 'Word 文档', shortcut: 'Pandoc', action: () => void exportWithPandoc('docx') },
  { label: 'ODT 文档', shortcut: 'Pandoc', action: () => void exportWithPandoc('odt') },
  { label: 'EPUB 电子书', shortcut: 'Pandoc', action: () => void exportWithPandoc('epub') },
  { label: 'LaTeX 源码', shortcut: 'Pandoc', action: () => void exportWithPandoc('latex') }
])

/* ---------------------------- 动作代理 ---------------------------- */

function editorUndo(): void {
  editorApi.current?.undo()
}

function editorRedo(): void {
  editorApi.current?.redo()
}

function openExportMenu(): void {
  const button = document.getElementById('exportBtn')
  if (!button) return
  const rect = button.getBoundingClientRect()
  menuPosition.value = { x: Math.min(rect.right - 230, window.innerWidth - 300), y: rect.bottom + 6 }
  openMenu.value = 'export'
}

function menuItems(): MenuEntry[] {
  if (openMenu.value === 'file') return fileMenu.value
  if (openMenu.value === 'edit') return editMenu.value
  if (openMenu.value === 'view') return viewMenu.value
  if (openMenu.value === 'help') return helpMenu.value
  if (openMenu.value === 'export') return exportMenu.value
  return []
}

function closeMenu(): void {
  openMenu.value = null
}

function onTopbarDoubleClick(event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('button, input, select')) return
  void windowControl('maximize')
}

async function windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void> {
  await window.api.app.windowControl(action)
  isMaximized.value = action === 'maximize' ? !isMaximized.value : isMaximized.value
}

onMounted(() => {
  document.addEventListener('click', closeMenu)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu()
  })
})

onBeforeUnmount(() => document.removeEventListener('click', closeMenu))
</script>

<template>
  <header class="topbar" @dblclick="onTopbarDoubleClick">
    <div class="brand">
      <span class="brand-wordmark"><span class="brand-initial">X</span>iaopengyou</span>
      <b>小彭友</b>
      <span class="brand-en">MARKDOWN AI IDE</span>
    </div>

    <nav class="menubar" @click.stop>
      <button :class="{ open: openMenu === 'file' }" @click="toggle('file', $event)">文件</button>
      <button :class="{ open: openMenu === 'edit' }" @click="toggle('edit', $event)">编辑</button>
      <button :class="{ open: openMenu === 'view' }" @click="toggle('view', $event)">视图</button>
      <button :class="{ open: openMenu === 'help' }" @click="toggle('help', $event)">帮助</button>
      <button v-if="updates.state.release" type="button" class="update-indicator"
        @click="closeMenu(); ui.modal = 'update'"><Icon name="download" :size="12" />有新版本</button>
    </nav>

    <div class="title-doc">
      <span class="dot" />
      <span>{{ title }}</span>
    </div>

    <div class="top-actions">
      <button class="iconbtn" title="外观与主题" aria-label="外观与主题" @click="ui.modal = 'appearance'">
        <Icon name="sun" :size="17" />
      </button>
      <button id="exportBtn" class="export-btn" @click.stop="toggle('export', $event)">
        <Icon name="download" :size="15" />导出<Icon name="chevron-down" :size="12" />
      </button>
      <span class="window-sep" />
      <button
        class="iconbtn window-control"
        title="最小化"
        aria-label="最小化"
        @click="windowControl('minimize')"
      >
        <Icon name="minus" :size="13" />
      </button>
      <button
        class="iconbtn window-control"
        title="最大化 / 还原"
        aria-label="最大化"
        @click="windowControl('maximize')"
      >
        <Icon :name="isMaximized ? 'square' : 'square'" :size="13" />
      </button>
      <button
        class="iconbtn window-control"
        title="关闭"
        aria-label="关闭窗口"
        @click="windowControl('close')"
      >
        <Icon name="x" :size="13" />
      </button>
    </div>

    <div
      v-if="openMenu"
      class="popup"
      :style="{ left: `${menuPosition.x}px`, top: `${menuPosition.y}px` }"
      @click.stop
    >
      <template v-for="(item, index) in menuItems()" :key="index">
        <div v-if="item.separator" class="sep" />
        <div v-else-if="!item.action" class="group-label">{{ item.label }}</div>
        <button v-else :disabled="item.disabled" @click="run(item.action)">
          <span>{{ item.label }}</span>
          <small v-if="item.shortcut">{{ item.shortcut }}</small>
        </button>
      </template>
    </div>
  </header>
</template>

<style scoped>
.brand {
  flex: none;
  white-space: nowrap;
}

.brand-wordmark {
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  padding: 0 9px;
  border: 1px solid #4d5a4f;
  border-radius: 9px;
  background: linear-gradient(135deg, #333b35, #232a25);
  color: #f4f7f1;
  font-family: 'Gabriola', 'Brush Script MT', cursive;
  font-size: 17px;
  font-weight: 600;
  line-height: 28px;
}

.brand-initial {
  font-size: 25px;
}

.menubar button.open {
  background: var(--hover);
  color: var(--text);
}
</style>
