/**
 * Preload：仅暴露固定、类型化的方法，不提供通用 ipcRenderer 或 Node 能力。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
import type { DesktopAPI, EditorRequest, EditorResponse } from '@shared/ipc'
import type { TaskEvent } from '@shared/types'
import type { AppEvent } from '@shared/ipc'

interface ErrorPayload {
  code: string
  message: string
  retryable: boolean
  details?: string
}

/** 调用主进程的指定通道并将结构化应用错误转换为渲染端异常。 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as { __appError: ErrorPayload } | T
  if (result && typeof result === 'object' && '__appError' in (result as object)) {
    const info = (result as { __appError: ErrorPayload }).__appError
    const error = new Error(info.message) as Error & ErrorPayload
    error.code = info.code
    error.retryable = info.retryable
    error.details = info.details
    throw error
  }
  return result as T
}

const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/** 预加载层暴露给页面的白名单 API；不暴露通用 IPC 或 Node.js 能力。 */
const api: DesktopAPI = {
  update: {
    state: () => invoke(IPC.update.state),
    check: () => invoke(IPC.update.check),
    download: () => invoke(IPC.update.download),
    install: () => invoke(IPC.update.install)
  },
  app: {
    info: () => invoke(IPC.app.info),
    openExternal: (url) => invoke(IPC.app.openExternal, url),
    windowControl: (action) => invoke(IPC.app.windowControl, action),
    openUserData: () => invoke(IPC.app.openUserData),
    chooseDirectory: (title) => invoke(IPC.app.chooseDirectory, title),
    readClipboardText: () => invoke(IPC.app.readClipboardText),
    writeClipboardText: (text) => invoke(IPC.app.writeClipboardText, text),
    pathForFile: (file) =>
      webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
    resolveClose: (action, remember) => invoke(IPC.app.resolveClose, action, remember)
  },
  documents: {
    openDialog: () => invoke(IPC.documents.openDialog),
    openPath: (path) => invoke(IPC.documents.openPath, path),
    openDropped: (path) => invoke(IPC.documents.openDropped, path),
    newDocument: (input) => invoke(IPC.documents.newDocument, input ?? {}),
    snapshot: (documentId) => invoke(IPC.documents.snapshot, documentId),
    update: (documentId, text, baseRevision) => invoke(IPC.documents.update, documentId, text, baseRevision),
    save: (documentId, expectedRevision) => invoke(IPC.documents.save, documentId, expectedRevision),
    saveAs: (documentId) => invoke(IPC.documents.saveAs, documentId),
    close: (documentId) => invoke(IPC.documents.close, documentId),
    listOpen: () => invoke(IPC.documents.listOpen),
    reorderOpen: (ids) => invoke(IPC.documents.reorderOpen, ids),
    recent: () => invoke(IPC.documents.recent),
    resolveConflict: (documentId, choice) => invoke(IPC.documents.resolveConflict, documentId, choice),
    recoveryList: () => invoke(IPC.documents.recoveryList),
    recoveryRestore: (documentId) => invoke(IPC.documents.recoveryRestore, documentId),
    recoveryDiscard: (documentId) => invoke(IPC.documents.recoveryDiscard, documentId),
    inlineImages: (documentId, urls) => invoke(IPC.documents.inlineImages, documentId, urls),
    pickImage: (documentId) => invoke(IPC.documents.pickImage, documentId),
    pickImageData: () => invoke(IPC.documents.pickImageData),
    saveImage: (documentId, name, mime, bytes) =>
      invoke(IPC.documents.saveImage, documentId, name, mime, bytes)
  },
  workspace: {
    current: () => invoke(IPC.workspace.current),
    openDialog: () => invoke(IPC.workspace.openDialog),
    openPath: (path) => invoke(IPC.workspace.openPath, path),
    tree: () => invoke(IPC.workspace.tree),
    readFile: (relativePath) => invoke(IPC.workspace.readFile, relativePath),
    createFile: (input) => invoke(IPC.workspace.createFile, input),
    imagePreview: (relativePath) => invoke(IPC.workspace.imagePreview, relativePath),
    createFolder: (relativePath) => invoke(IPC.workspace.createFolder, relativePath),
    rename: (from, to) => invoke(IPC.workspace.rename, from, to),
    move: (from, toDir) => invoke(IPC.workspace.move, from, toDir),
    remove: (relativePath) => invoke(IPC.workspace.remove, relativePath),
    search: (query, limit) => invoke(IPC.workspace.search, query, limit),
    reveal: (relativePath) => invoke(IPC.workspace.reveal, relativePath),
    openFolder: (relativePath) => invoke(IPC.workspace.openFolder, relativePath),
    recent: () => invoke(IPC.workspace.recent)
  },
  settings: {
    get: () => invoke(IPC.settings.get),
    update: (patch) => invoke(IPC.settings.update, patch),
    reset: () => invoke(IPC.settings.reset)
  },
  providers: {
    list: () => invoke(IPC.providers.list),
    save: (input) => invoke(IPC.providers.save, input),
    remove: (providerId) => invoke(IPC.providers.remove, providerId),
    test: (providerId) => invoke(IPC.providers.test, providerId),
    setDefault: (providerId) => invoke(IPC.providers.setDefault, providerId)
  },
  agent: {
    start: (input) => invoke(IPC.agent.start, input),
    cancel: (taskId) => invoke(IPC.agent.cancel, taskId),
    answer: (answer) => invoke(IPC.agent.answer, answer),
    snapshot: (taskId) => invoke(IPC.agent.snapshot, taskId),
    history: (documentId, offset) => invoke(IPC.agent.history, documentId, offset),
    deleteHistory: (documentId, ids) => invoke(IPC.agent.deleteHistory, documentId, ids)
  },
  changes: {
    review: (changeSetId) => invoke(IPC.changes.review, changeSetId),
    accept: (changeSetId, proposalDigest, documentId) => invoke(IPC.changes.accept, changeSetId, proposalDigest, documentId),
    reject: (changeSetId, documentId) => invoke(IPC.changes.reject, changeSetId, documentId),
    restore: (transactionId) => invoke(IPC.changes.restore, transactionId),
    list: () => invoke(IPC.changes.list)
  },
  attachments: {
    addFromDialog: () => invoke(IPC.attachments.addFromDialog),
    addFromBytes: (name, mime, bytes) => invoke(IPC.attachments.addFromBytes, name, mime, bytes),
    list: () => invoke(IPC.attachments.list),
    remove: (attachmentId) => invoke(IPC.attachments.remove, attachmentId),
    dataUrl: (attachmentId) => invoke(IPC.attachments.dataUrl, attachmentId)
  },
  references: {
    add: (input) => invoke(IPC.references.add, input),
    addFileDialog: () => invoke(IPC.references.addFileDialog),
    addFromBytes: (name, bytes) => invoke(IPC.references.addFromBytes, name, bytes),
    list: () => invoke(IPC.references.list),
    remove: (sourceId) => invoke(IPC.references.remove, sourceId),
    preview: (sourceId, offset) => invoke(IPC.references.preview, sourceId, offset),
    previewPdf: (sourceId) => invoke(IPC.references.previewPdf, sourceId),
    setRoles: (sourceId, roles) => invoke(IPC.references.setRoles, sourceId, roles)
  },
  styles: {
    list: () => invoke(IPC.styles.list),
    save: (input) => invoke(IPC.styles.save, input),
    remove: (profileId) => invoke(IPC.styles.remove, profileId)
  },
  prediction: {
    request: (input) => invoke(IPC.prediction.request, input),
    cancel: (requestId) => invoke(IPC.prediction.cancel, requestId)
  },
  themes: {
    list: () => invoke(IPC.themes.list),
    import: () => invoke(IPC.themes.import),
    activate: (themeId) => invoke(IPC.themes.activate, themeId),
    remove: (themeId) => invoke(IPC.themes.remove, themeId),
    css: (themeId) => invoke(IPC.themes.css, themeId)
  },
  exports: {
    saveHtml: (html, suggestedName) => invoke(IPC.exports.saveHtml, html, suggestedName),
    saveMarkdown: (text, suggestedName) => invoke(IPC.exports.saveMarkdown, text, suggestedName),
    saveMarkdownBundle: (documentId, text, suggestedName) =>
      invoke(IPC.exports.saveMarkdownBundle, documentId, text, suggestedName),
    saveMarkdownInline: (documentId, text, suggestedName) =>
      invoke(IPC.exports.saveMarkdownInline, documentId, text, suggestedName),
    savePdf: (input) => invoke(IPC.exports.savePdf, input),
    pandocStatus: () => invoke(IPC.exports.pandocStatus),
    pandocConvert: (input) => invoke(IPC.exports.pandocConvert, input)
  },
  bridge: {
    onRequest: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, request: EditorRequest): void => {
        void Promise.resolve(handler(request))
          .then((response) => ipcRenderer.send(IPC.bridge.response, response))
          .catch((error: unknown) => {
            const response: EditorResponse = {
              requestId: request.requestId,
              ok: false,
              error: { code: 'UNKNOWN', message: error instanceof Error ? error.message : '编辑器处理失败' }
            }
            ipcRenderer.send(IPC.bridge.response, response)
          })
      }
      ipcRenderer.on(IPC.bridge.request, listener)
      return () => ipcRenderer.removeListener(IPC.bridge.request, listener)
    },
    respond: (response) => ipcRenderer.send(IPC.bridge.response, response)
  },
  on: {
    agentEvent: (listener) => subscribe<TaskEvent>(IPC.events.agent, listener),
    workspaceChanged: (listener) =>
      subscribe<Extract<AppEvent, { type: 'workspace-changed' }>>(IPC.events.workspaceChanged, listener),
    documentChanged: (listener) =>
      subscribe<Extract<AppEvent, { type: 'document-changed' }>>(IPC.events.documentChanged, listener),
    documentConflict: (listener) =>
      subscribe<Extract<AppEvent, { type: 'document-conflict' }>>(IPC.events.documentConflict, listener),
    updateChanged: (listener) => subscribe(IPC.events.updateChanged, listener),
    settingsChanged: (listener) => subscribe(IPC.events.settingsChanged, listener),
    documentOpened: (listener) => subscribe(IPC.events.documentOpened, listener),
    closeRequested: (listener) => subscribe(IPC.events.closeRequested, listener),
    toast: (listener) => subscribe<Extract<AppEvent, { type: 'toast' }>>(IPC.events.toast, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
