<script setup lang="ts">
/**
 * 应用外壳：三栏布局、全局快捷键、事件订阅与恢复草稿提示。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import appIcon from '../../resources/icon.png'
import { useSettingsStore } from './stores/settings'
import { useDocumentsStore } from './stores/documents'
import { useWorkspaceStore } from './stores/workspace'
import { useAgentStore } from './stores/agent'
import { useUiStore } from './stores/ui'
import { editorApi } from './lib/editorApi'
import { closeTabWithConfirm, newDocument, openDocument, saveActive, saveAsActive } from './lib/actions'
import TopBar from './shell/TopBar.vue'
import LeftPanel from './panels/LeftPanel.vue'
import OutlinePanel from './panels/OutlinePanel.vue'
import Resizer from './shell/Resizer.vue'
import CenterPanel from './shell/CenterPanel.vue'
import AppearanceModal from './shell/AppearanceModal.vue'
import ProviderModal from './shell/ProviderModal.vue'
import ShortcutsModal from './shell/ShortcutsModal.vue'
import AboutModal from './shell/AboutModal.vue'
import ImagePreview from './shell/ImagePreview.vue'
import ClosePrompt from './shell/ClosePrompt.vue'
import ReviewDialog from './shell/ReviewDialog.vue'
import ConfirmDialog from './shell/ConfirmDialog.vue'
import ToastHost from './shell/ToastHost.vue'
import Icon from './components/Icon.vue'

const settings = useSettingsStore()
const documents = useDocumentsStore()
const workspace = useWorkspaceStore()
const agent = useAgentStore()
const ui = useUiStore()

const ready = ref(false)
const unsubscribers: Array<() => void> = []
let workspaceTimer = 0

const appStyle = computed(() => ({
  '--left': `${ui.leftWidth}px`,
  '--right': `${ui.rightWidth}px`,
  '--editor-zoom': String(ui.zoom / 100)
}))

const recoveryList = computed(() => documents.recoveries.slice(0, 3))

// 打开或切换文稿时回到可编辑状态：锁定只作用于当次阅读，不跨文件延续
watch(
  () => documents.activeId,
  () => ui.setLocked(false)
)

/** 将桌面进程广播分发给相应状态库，并登记取消订阅回调。 */
function subscribe(): void {
  unsubscribers.push(
    window.api.on.agentEvent((event) => agent.handleEvent(event)),
    window.api.on.documentChanged((event) => documents.applySnapshot(event.snapshot, event.origin)),
    window.api.on.documentConflict((event) => documents.setConflict(event.conflict)),
    window.api.on.documentOpened((snapshot) => documents.upsertFromOutside(snapshot)),
    window.api.on.settingsChanged((next) => {
      settings.settings = next
      settings.apply()
      void settings.refreshThemeCss()
    }),
    window.api.on.toast((event) => ui.toast(event.message, event.tone))
  )
  unsubscribers.push(
    window.api.on.workspaceChanged(() => {
      window.clearTimeout(workspaceTimer)
      workspaceTimer = window.setTimeout(() => {
        void workspace.load()
      }, 320)
    })
  )
}

function onKeydown(event: KeyboardEvent): void {
  const primary = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  if (event.key === 'Escape') {
    if (ui.findOpen) ui.findOpen = false
    else if (ui.modal) ui.modal = null
    else if (ui.reviewOpen) ui.reviewOpen = false
    else if (ui.aiCollapsed === false) {
      // 保持面板，不强制收起
    }
    return
  }
  if (!primary) return
  if (key === 'n') {
    event.preventDefault()
    void newDocument()
  } else if (key === 'o') {
    event.preventDefault()
    void openDocument()
  } else if (key === 's') {
    event.preventDefault()
    if (event.shiftKey) void saveAsActive()
    else void saveActive()
  } else if (key === 'w') {
    event.preventDefault()
    const tab = documents.activeTab
    if (tab) void closeTabWithConfirm(tab)
  } else if (key === 'f' && !event.shiftKey) {
    event.preventDefault()
    if (documents.activeTab) ui.findOpen = true
  } else if (key === 'k') {
    event.preventDefault()
    window.dispatchEvent(new CustomEvent('focus-element-search'))
  } else if (key === 'b') {
    event.preventDefault()
    editorApi.current?.wrapSelection('bold')
  } else if (key === 'i' && !event.shiftKey) {
    event.preventDefault()
    editorApi.current?.wrapSelection('italic')
  } else if (key === 'u' && !event.shiftKey) {
    event.preventDefault()
    editorApi.current?.wrapSelection('underline')
  }
}

async function restoreRecovery(documentId: string): Promise<void> {
  try {
    await documents.restoreRecovery(documentId)
    await documents.flush(documentId)
  } catch (error) {
    ui.toast((error as Error).message || '恢复失败', 'error')
  }
}

async function discardRecoveries(): Promise<void> {
  for (const entry of [...documents.recoveries]) {
    await documents.discardRecovery(entry.documentId).catch(() => undefined)
  }
  ui.toast('已忽略未保存草稿', 'info')
}

onMounted(async () => {
  settings.initSystemTheme()
  try {
    await settings.load()
    await Promise.all([agent.hydrate(), workspace.load(), documents.hydrate()])
    subscribe()
    window.addEventListener('keydown', onKeydown)
    ready.value = true
    document.addEventListener('dragover', (event) => event.preventDefault())
    document.addEventListener('drop', (event) => event.preventDefault())
  } catch (error) {
    ui.toast((error as Error).message || '应用初始化失败', 'error', 6000)
    ready.value = true
  }
})

onBeforeUnmount(() => {
  window.clearTimeout(workspaceTimer)
  for (const unsubscribe of unsubscribers) unsubscribe()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div v-if="!ready" class="splash">
    <img class="splash-icon" :src="appIcon" alt="小彭友" width="56" height="56" />
    <p>正在准备你的写作空间…</p>
  </div>

  <div v-else class="app" :class="{ 'app-focus': ui.focusMode }" :style="appStyle">
    <TopBar v-if="!ui.focusMode" />

    <div v-if="recoveryList.length" class="recovery-banner">
      <Icon name="history" :size="14" />
      <span>发现 {{ documents.recoveries.length }} 份未保存草稿</span>
      <button
        v-for="entry in recoveryList"
        :key="entry.documentId"
        class="recovery-action"
        @click="restoreRecovery(entry.documentId)"
      >
        恢复《{{ entry.title }}》
      </button>
      <button class="recovery-dismiss" @click="discardRecoveries">忽略</button>
    </div>

    <main class="workspace" :class="ui.workspaceClass">
      <LeftPanel :focus="ui.focusMode" />
      <Resizer side="left" />
      <CenterPanel />
      <template v-if="ui.outlineVisible">
        <Resizer side="right" />
        <OutlinePanel />
      </template>
    </main>

    <AppearanceModal v-if="ui.modal === 'appearance'" />
    <ProviderModal v-if="ui.modal === 'providers'" />
    <ShortcutsModal v-if="ui.modal === 'shortcuts'" />
    <AboutModal v-if="ui.modal === 'about'" />
    <ImagePreview />
    <ClosePrompt />
    <ReviewDialog />
    <ConfirmDialog />
    <ToastHost />
  </div>
</template>

<style scoped>
.splash {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--muted);
  font-size: 12px;
}

.splash-icon {
  width: 56px;
  height: 56px;
  border-radius: 13px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
  user-select: none;
  -webkit-user-drag: none;
}

:root[data-theme='dark'] .splash-icon {
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08),
    0 10px 30px rgba(0, 0, 0, 0.45);
}

.recovery-banner {
  position: fixed;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 55;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border: 1px solid var(--line);
  background: var(--card);
  border-radius: 9px;
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.1);
  font-size: 11px;
  color: var(--soft);
  max-width: calc(100vw - 80px);
  flex-wrap: wrap;
}

.recovery-action {
  font-size: 10px;
  color: color-mix(in srgb, var(--accent) 80%, var(--text));
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  border-radius: 5px;
  padding: 3px 8px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recovery-dismiss {
  font-size: 10px;
  color: var(--muted);
  margin-left: 4px;
}
</style>
