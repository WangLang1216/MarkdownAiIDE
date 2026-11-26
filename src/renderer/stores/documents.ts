/**
 * 文档 Store：标签页、编辑同步、保存、外部冲突与恢复草稿。
 * 渲染进程是编辑事务的拥有者；所有写入串行发送，避免版本乱序。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { DiskConflictInfo, DocumentSnapshot, RecoveryEntry, SaveResult } from '@shared/types'
import { applyEditsToText } from '@shared/markdown/edits'
import { collectDataImageRefs } from '@shared/markdown/images'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'
import { editorApi } from '../lib/editorApi'

/** 描述文稿标签对用户展示的未保存、保存中及结果状态。 */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'failed'

/** 保存标签的最新文稿快照、保存状态及外部冲突信息。 */
export interface TabState {
  /** 标签当前可用的文稿快照，包含本地编辑中的正文。 */
  snapshot: DocumentSnapshot
  /** 状态栏和标签所展示的保存进度。 */
  saveState: SaveState
  /** 待用户处理的外部磁盘变更；无冲突时为 null。 */
  conflict: DiskConflictInfo | null
  /** 最近一次保存成功的时间戳。 */
  lastSavedAt: number | null
  /** 最近一次真实编辑（输入、AI 写入或保存）的时间；仅用于「最近」列表排序。 */
  lastEditedAt: number
  /** 供界面显示的结果或错误说明。 */
  message: string | null
}

interface SyncState {
  timer: number | null
  latest: string | null
  running: Promise<void> | null
  autosave: number | null
  retried: boolean
}

/** 维护文稿标签、活动文稿、编辑缓冲区同步和自动保存。 */
export const useDocumentsStore = defineStore('documents', () => {
  const tabs = ref<TabState[]>([])
  const activeId = ref<string | null>(null)
  const recoveries = ref<RecoveryEntry[]>([])
  const loading = ref(false)
  const syncStates = new Map<string, SyncState>()
  let applyingRemote = false

  const activeTab = computed<TabState | null>(
    () => tabs.value.find((tab) => tab.snapshot.documentId === activeId.value) ?? null
  )
  const activeText = computed(() => activeTab.value?.snapshot.text ?? '')
  const hasDirty = computed(() => tabs.value.some((tab) => tab.snapshot.dirty))

  function stateOf(documentId: string): SyncState {
    let state = syncStates.get(documentId)
    if (!state) {
      state = { timer: null, latest: null, running: null, autosave: null, retried: false }
      syncStates.set(documentId, state)
    }
    return state
  }

  function upsert(snapshot: DocumentSnapshot, activate = false): TabState {
    const existing = tabs.value.find((tab) => tab.snapshot.documentId === snapshot.documentId)
    if (existing) {
      existing.snapshot = mergeSnapshot(existing.snapshot, snapshot)
      existing.saveState = existing.snapshot.dirty ? 'dirty' : 'saved'
      if (activate) activeId.value = snapshot.documentId
      return existing
    }
    const tab: TabState = {
      snapshot,
      saveState: snapshot.dirty ? 'dirty' : 'saved',
      conflict: null,
      lastSavedAt: snapshot.existsOnDisk ? Date.now() : null,
      // 打开文稿不算“编辑”，避免刚打开就顶到「最近」最前面
      lastEditedAt: 0,
      message: null
    }
    tabs.value = [...tabs.value, tab]
    if (activate || !activeId.value) activeId.value = snapshot.documentId
    return tab
  }

  /**
   * 合并主进程快照时正文默认以本地为准。
   * 同步/保存的响应可能比正在输入的内容慢一拍，直接覆盖会把刚敲的字退回去、光标跳位；
   * 外部修改与重载由调用方显式接管正文（见 applySnapshot / resolveConflict）。
   */
  function mergeSnapshot(current: DocumentSnapshot, next: DocumentSnapshot): DocumentSnapshot {
    return { ...current, ...next, text: current.text }
  }

  async function hydrate(): Promise<void> {
    loading.value = true
    try {
      const [open, recoveryEntries] = await Promise.all([
        window.api.documents.listOpen(),
        window.api.documents.recoveryList()
      ])
      for (const snapshot of open) upsert(snapshot, false)
      activeId.value = open[0]?.documentId ?? null
      recoveries.value = recoveryEntries
    } finally {
      loading.value = false
    }
  }

  async function openDialog(): Promise<void> {
    const snapshots = await window.api.documents.openDialog()
    for (const snapshot of snapshots) {
      upsert(snapshot, true)
      useUiStore().setLocked(false)
    }
  }

  function upsertFromOutside(snapshot: DocumentSnapshot): void {
    upsert(snapshot, true)
  }

  async function openPath(path: string): Promise<void> {
    const snapshot = await window.api.documents.openPath(path)
    upsert(snapshot, true)
    useUiStore().setLocked(false)
  }

  async function newUntitled(): Promise<void> {
    const snapshot = await window.api.documents.newDocument()
    upsert(snapshot, true)
    useUiStore().setLocked(false)
    window.setTimeout(() => editorApi.current?.focus(), 30)
  }

  async function createInWorkspace(relativePath: string, workspaceId: string): Promise<void> {
    const snapshot = await window.api.documents.newDocument({ relativePath, workspaceId })
    upsert(snapshot, true)
    useUiStore().setLocked(false)
  }

  async function moveTab(sourceId: string, targetId: string, after: boolean): Promise<void> {
    if (sourceId === targetId) return
    const ids = tabs.value.map((tab) => tab.snapshot.documentId)
    const from = ids.indexOf(sourceId)
    const target = ids.indexOf(targetId)
    if (from < 0 || target < 0) return
    const insertion = target + Number(after)
    const to = insertion > from ? insertion - 1 : insertion
    if (from === to) return
    const ordered = [...tabs.value]
    const [tab] = ordered.splice(from, 1)
    ordered.splice(to, 0, tab)
    tabs.value = ordered
    try {
      await window.api.documents.reorderOpen(ordered.map((item) => item.snapshot.documentId))
    } catch (error) {
      useUiStore().toast((error as Error).message || '无法保存标签顺序', 'error')
    }
  }

  function setActive(documentId: string): void {
    if (!tabs.value.some((tab) => tab.snapshot.documentId === documentId)) return
    if (activeId.value === documentId) return
    activeId.value = documentId
  }

  /** 编辑器文本变化：立即更新本地视图，随后节流同步到主进程 */
  /** 将编辑器输入合入活动标签，并安排同步及已启用的自动保存。 */
  function onEditorText(text: string): void {
    const tab = activeTab.value
    if (!tab) return
    if (applyingRemote) return
    if (tab.snapshot.text === text) return
    tab.snapshot.text = text
    tab.snapshot.dirty = true
    tab.saveState = 'dirty'
    tab.lastEditedAt = Date.now()
    tab.message = null
    queueSync(tab.snapshot.documentId)
    scheduleAutosave(tab)
  }

  function queueSync(documentId: string): void {
    const state = stateOf(documentId)
    const tab = tabs.value.find((item) => item.snapshot.documentId === documentId)
    if (!tab) return
    state.latest = tab.snapshot.text
    if (state.timer) window.clearTimeout(state.timer)
    state.timer = window.setTimeout(() => {
      state.timer = null
      void flush(documentId)
    }, 180)
  }

  /** 把最新文本发送到主进程；同一文档严格串行 */
  /** 串行推送同一标签中待同步的正文与基础修订，处理版本更新或冲突。 */
  async function flush(documentId: string): Promise<void> {
    const state = stateOf(documentId)
    if (state.timer) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
    if (state.running) {
      await state.running
      if (state.latest === null) return
    }
    state.running = (async () => {
      while (state.latest !== null) {
        const tab = tabs.value.find((item) => item.snapshot.documentId === documentId)
        if (!tab) {
          state.latest = null
          break
        }
        const text = state.latest
        state.latest = null
        try {
          const snapshot = await window.api.documents.update(documentId, text, tab.snapshot.revision)
          tab.snapshot = mergeSnapshot(tab.snapshot, snapshot)
          state.retried = false
          if (!snapshot.dirty) tab.saveState = 'saved'
        } catch (error) {
          const typed = error as Error & { code?: string }
          if (typed.code === 'REVISION_CONFLICT') {
            const snapshot = await window.api.documents.snapshot(documentId)
            // 保留本地最新文本，只采纳主进程的新 revision，再重试一次
            const localText = tab.snapshot.text
            tab.snapshot = { ...snapshot, text: localText, dirty: localText !== snapshot.text }
            tab.saveState = 'dirty'
            if (!state.retried) {
              state.retried = true
              state.latest = localText
              window.setTimeout(() => void flush(documentId), 120)
            } else {
              tab.saveState = 'failed'
              useUiStore().toast('文档版本反复变化，请另存为后再继续', 'error', 4200)
            }
          } else {
            useUiStore().toast(typed.message || '同步文档失败', 'error')
          }
          break
        }
      }
    })().finally(() => {
      state.running = null
    })
    await state.running
  }

  async function flushAll(): Promise<void> {
    await Promise.all(tabs.value.map((tab) => flush(tab.snapshot.documentId)))
  }

  function scheduleAutosave(tab: TabState): void {
    const settings = useSettingsStore()
    if (!settings.settings.editor.autosave) return
    if (!tab.snapshot.existsOnDisk) return
    const state = stateOf(tab.snapshot.documentId)
    if (state.autosave) window.clearTimeout(state.autosave)
    state.autosave = window.setTimeout(() => {
      state.autosave = null
      void save(tab.snapshot.documentId, true)
    }, settings.settings.editor.autosaveDelayMs)
  }

  async function save(documentId?: string, silent = false): Promise<boolean> {
    const tab = documentId
      ? tabs.value.find((item) => item.snapshot.documentId === documentId)
      : activeTab.value
    if (!tab) return false
    const state = stateOf(tab.snapshot.documentId)
    if (state.autosave) {
      window.clearTimeout(state.autosave)
      state.autosave = null
    }
    if (tab.saveState === 'saving') return false
    tab.saveState = 'saving'
    try {
      await flush(tab.snapshot.documentId)
      const result: SaveResult = await window.api.documents.save(
        tab.snapshot.documentId,
        tab.snapshot.revision
      )
      return applySaveResult(tab, result, silent)
    } catch (error) {
      tab.saveState = 'failed'
      tab.message = (error as Error).message
      if (!silent) useUiStore().toast((error as Error).message || '保存失败', 'error')
      return false
    }
  }

  async function saveAs(documentId?: string): Promise<boolean> {
    const tab = documentId
      ? tabs.value.find((item) => item.snapshot.documentId === documentId)
      : activeTab.value
    if (!tab) return false
    try {
      await flush(tab.snapshot.documentId)
      const result = await window.api.documents.saveAs(tab.snapshot.documentId)
      if (!result) {
        tab.saveState = tab.snapshot.dirty ? 'dirty' : 'saved'
        return false
      }
      return applySaveResult(tab, result, false)
    } catch (error) {
      tab.saveState = 'failed'
      useUiStore().toast((error as Error).message || '另存为失败', 'error')
      return false
    }
  }

  function applySaveResult(tab: TabState, result: SaveResult, silent: boolean): boolean {
    tab.snapshot = mergeSnapshot(tab.snapshot, result.snapshot)
    if (result.status === 'saved') {
      // 保存时内联图片被改写成相对路径：同步回编辑器，避免界面仍显示 base64。
      // 只在编辑器里还留着 data URL 时回写，避免覆盖保存期间刚敲入的新内容。
      if (result.convertedImages && activeId.value === tab.snapshot.documentId && editorApi.current) {
        const current = editorApi.current.getText()
        if (current !== result.snapshot.text && collectDataImageRefs(current).length) {
          editorApi.current.setText(result.snapshot.text)
        }
      }
      tab.saveState = 'saved'
      tab.lastSavedAt = Date.now()
      tab.lastEditedAt = Date.now()
      tab.message = result.message ?? null
      tab.conflict = null
      if (!silent) useUiStore().toast('已保存', 'success', 1600)
      return true
    }
    if (result.status === 'conflict') {
      tab.saveState = 'conflict'
      tab.conflict = {
        documentId: tab.snapshot.documentId,
        diskHash: '',
        sessionHash: tab.snapshot.contentHash,
        message: result.message ?? '磁盘文件已被外部修改。'
      }
      useUiStore().toast(result.message ?? '保存冲突', 'warning')
      return false
    }
    tab.saveState = 'failed'
    tab.message = result.message ?? null
    useUiStore().toast(result.message ?? '保存失败', 'error')
    return false
  }

  async function resolveConflict(choice: 'reload' | 'overwrite' | 'saveAs'): Promise<void> {
    const tab = activeTab.value
    if (!tab) return
    try {
      const result = await window.api.documents.resolveConflict(tab.snapshot.documentId, choice)
      if (!result) return
      if ('status' in result) {
        applySaveResult(tab, result as SaveResult, false)
      } else {
        const snapshot = result as DocumentSnapshot
        tab.snapshot = mergeSnapshot(tab.snapshot, snapshot)
        // 重新载入：以磁盘正文为准
        tab.snapshot.text = snapshot.text
        tab.saveState = 'saved'
        tab.conflict = null
        editorApi.current?.setText(snapshot.text)
        useUiStore().toast('已载入磁盘上的最新版本', 'info')
      }
    } catch (error) {
      useUiStore().toast((error as Error).message || '处理冲突失败', 'error')
    }
  }

  async function close(documentId: string, force = false): Promise<boolean> {
    const tab = tabs.value.find((item) => item.snapshot.documentId === documentId)
    if (!tab) return true
    if (tab.snapshot.dirty && !force) return false
    const dirtyBeforeClose = tab.snapshot.dirty
    const state = stateOf(documentId)
    if (state.timer) window.clearTimeout(state.timer)
    if (state.autosave) window.clearTimeout(state.autosave)
    if (!force) await flush(documentId)
    await window.api.documents.close(documentId)
    syncStates.delete(documentId)
    const index = tabs.value.findIndex((item) => item.snapshot.documentId === documentId)
    tabs.value = tabs.value.filter((item) => item.snapshot.documentId !== documentId)
    if (activeId.value === documentId) {
      const next = tabs.value[Math.min(index, tabs.value.length - 1)]
      activeId.value = next?.snapshot.documentId ?? null
    }
    // 关闭未保存文稿会在主进程留下恢复草稿，立即刷新让「最近」马上能展示并管理它
    if (dirtyBeforeClose) await refreshRecoveries().catch(() => undefined)
    return true
  }

  /** 处理主进程推送的文档快照（外部修改、保存、Agent 应用） */
  /** 消费主进程广播，按变更来源协调快照与本地缓冲区。 */
  function applySnapshot(snapshot: DocumentSnapshot, origin: string): void {
    const tab = tabs.value.find((item) => item.snapshot.documentId === snapshot.documentId)
    if (!tab) return
    const textChanged = tab.snapshot.text !== snapshot.text
    tab.snapshot = mergeSnapshot(tab.snapshot, snapshot)
    if (origin === 'external' || origin === 'reload') {
      // 磁盘上的正文才是准的：显式覆盖本地缓冲
      tab.snapshot.text = snapshot.text
      tab.saveState = snapshot.dirty ? 'dirty' : 'saved'
      if (textChanged && activeId.value === snapshot.documentId) editorApi.current?.setText(snapshot.text)
    } else if (origin === 'save') {
      tab.saveState = snapshot.dirty ? 'dirty' : 'saved'
      if (!snapshot.dirty) tab.lastSavedAt = Date.now()
    } else if (origin === 'agent') {
      if (snapshot.dirty) {
        tab.saveState = 'dirty'
        scheduleAutosave(tab)
      }
    }
  }

  function setConflict(conflict: DiskConflictInfo): void {
    const tab = tabs.value.find((item) => item.snapshot.documentId === conflict.documentId)
    if (!tab) return
    tab.conflict = conflict
    tab.saveState = 'conflict'
    useUiStore().toast(conflict.message, 'warning', 4200)
  }

  /** 主进程请求同步：返回编辑器当前文本 */
  function currentTextFor(documentId: string): string | undefined {
    if (activeId.value === documentId && editorApi.current) return editorApi.current.getText()
    return tabs.value.find((item) => item.snapshot.documentId === documentId)?.snapshot.text
  }

  /** 主进程请求应用编辑：活动文档走编辑器事务，其余标签直接更新缓冲区 */
  function applyRemoteEdits(
    documentId: string,
    edits: Array<{ from: number; to: number; insert: string }>,
    reveal?: { from: number; to: number }
  ): string | null {
    const tab = tabs.value.find((item) => item.snapshot.documentId === documentId)
    if (!tab) return null
    const state = stateOf(documentId)
    if (state.timer) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
    state.latest = null
    if (activeId.value === documentId && editorApi.current) {
      applyingRemote = true
      try {
        editorApi.current.applyEdits(edits, reveal)
      } finally {
        applyingRemote = false
      }
      const text = editorApi.current.getText()
      tab.snapshot.text = text
    } else {
      tab.snapshot.text = applyEditsToText(tab.snapshot.text, edits)
    }
    tab.snapshot.dirty = true
    tab.saveState = 'dirty'
    tab.lastEditedAt = Date.now()
    return tab.snapshot.text
  }

  async function restoreRecovery(documentId: string): Promise<void> {
    const snapshot = await window.api.documents.recoveryRestore(documentId)
    upsert(snapshot, true)
    // 恢复草稿属于一次真实编辑，让它排在「最近」前列
    const tab = tabs.value.find((item) => item.snapshot.documentId === documentId)
    if (tab) tab.lastEditedAt = Date.now()
    recoveries.value = recoveries.value.filter((item) => item.documentId !== documentId)
    useUiStore().toast('已恢复未保存的草稿', 'success')
  }

  async function discardRecovery(documentId: string): Promise<void> {
    await window.api.documents.recoveryDiscard(documentId)
    recoveries.value = recoveries.value.filter((item) => item.documentId !== documentId)
  }

  async function refreshRecoveries(): Promise<void> {
    recoveries.value = await window.api.documents.recoveryList()
  }

  function updateTabMeta(documentId: string, patch: Partial<DocumentSnapshot>): void {
    const tab = tabs.value.find((item) => item.snapshot.documentId === documentId)
    if (!tab) return
    tab.snapshot = { ...tab.snapshot, ...patch }
  }

  return {
    tabs,
    activeId,
    activeTab,
    activeText,
    recoveries,
    loading,
    hasDirty,
    hydrate,
    upsertFromOutside,
    openDialog,
    openPath,
    newUntitled,
    createInWorkspace,
    setActive,
    moveTab,
    onEditorText,
    flush,
    flushAll,
    save,
    saveAs,
    resolveConflict,
    close,
    applySnapshot,
    setConflict,
    currentTextFor,
    applyRemoteEdits,
    restoreRecovery,
    discardRecovery,
    refreshRecoveries,
    updateTabMeta
  }
})
