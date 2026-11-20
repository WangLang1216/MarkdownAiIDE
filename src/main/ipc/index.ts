/**
 * IPC 路由：所有通道都在此处校验调用来源与参数，并把异常收敛为可序列化错误。
 * Renderer 不获得任何通用文件系统能力，只能调用此处白名单方法。
 */

import { isAbsolute, resolve } from 'node:path'
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { NewDocumentInput, StyleProfileInput } from '@shared/ipc'
import type {
  AddSourceInput,
  AppInfo,
  ClarificationAnswer,
  ExportPdfInput,
  PandocConvertInput,
  PartialSettings,
  PredictionRequestInput,
  ProviderInput,
  StartTaskInput
} from '@shared/types'
import { AppError, toErrorInfo } from '@shared/errors'
import { isPathInside } from '../utils/fs'
import { pathExists } from '../utils/fs'
import { appPaths, configureCacheDir } from '../utils/paths'
import { appIconDataUrl } from '../app/icon'
import type { SettingsStore } from '../settings/store'
import type { SecretService } from '../secrets/service'
import type { ProviderService } from '../providers/service'
import type { WorkspaceService } from '../workspace/service'
import type { DocumentService } from '../documents/service'
import type { EditorBridge } from '../bridge'
import type { ChangeService } from '../changes/service'
import type { AgentController } from '../agent/controller'
import type { AttachmentService } from '../attachments/service'
import type { ReferenceService } from '../references/service'
import type { StyleService } from '../styles/service'
import type { PredictionService } from '../prediction/service'
import type { ThemeService } from '../themes/service'
import type { ExportService } from '../exports/service'
import type { MediaService } from '../media'
import { logger } from '../utils/logger'

/** 为 IPC 注册注入当前主窗口、主进程服务及生命周期回调。 */
export interface IpcContext {
  /** 提供当前主窗口，供 IPC 请求来源校验与事件发送使用。 */
  window: BrowserWindow
  settings: SettingsStore
  /** 仅主进程可用的密钥服务，用于报告加密后端状态。 */
  secrets: SecretService
  providers: ProviderService
  workspace: WorkspaceService
  documents: DocumentService
  bridge: EditorBridge
  changes: ChangeService
  agent: AgentController
  attachments: AttachmentService
  references: ReferenceService
  styles: StyleService
  prediction: PredictionService
  themes: ThemeService
  exports: ExportService
  /** 文稿图片解析和导出资源服务。 */
  media: MediaService
  /** 关闭窗口与托盘：由主进程注入，避免 IPC 层直接持有窗口生命周期状态 */
  lifecycle: {
    resolveClose(action: 'tray' | 'quit', remember: boolean): Promise<void>
    persistOpenFiles(): Promise<void>
  }
}

const MAX_TEXT_LENGTH = 20 * 1024 * 1024

function fail(code: AppError['code'], message: string): { __appError: ReturnType<AppError['toInfo']> } {
  return { __appError: { code, message, retryable: false } }
}

/** 注册桌面 IPC 处理器，将经过来源和参数校验的请求分派给对应服务。 */
export function registerIpc(context: IpcContext): void {
  const { window } = context

  const broadcast = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    BrowserWindow.fromWebContents(event.sender) === window

  const handle = <T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) return fail('OUT_OF_SCOPE', '调用来源不可信。')
      try {
        return await fn(...args)
      } catch (error) {
        const info = toErrorInfo(error)
        if (info.code !== 'CANCELLED' && info.code !== 'PREDICTION_STALE') {
          logger.warn('ipc', `通道 ${channel} 失败`, { code: info.code })
        }
        return { __appError: info }
      }
    })
  }

  const asString = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value) throw new AppError('INVALID_INPUT', `${name} 不合法。`)
    return value
  }

  const asRecord = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('INVALID_INPUT', `${name} 不合法。`)
    return value as Record<string, unknown>
  }

  const allowDocumentPath = (path: string): boolean => {
    const current = context.workspace.getCurrent()
    if (current && isPathInside(current.rootPath, path)) return true
    return context.settings.get().recentFiles.some((entry) => samePath(entry.path, path))
  }

  /* ------------------------------- app ------------------------------- */

  handle<AppInfo>(IPC.app.info, async () => {
    const current = context.workspace.getCurrent()
    const pandoc = await context.exports.pandocStatus()
    const demoExists = await pathExists(appPaths().demoWorkspace)
    return {
      version: '1.0.0',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      userDataPath: appPaths().userData,
      workspace: current,
      safeStorage: { available: context.secrets.isEncryptionAvailable(), backend: context.secrets.backend() },
      pandoc,
      demoWorkspacePath: demoExists ? appPaths().demoWorkspace : null,
      iconDataUrl: await appIconDataUrl()
    }
  })

  handle<void>(IPC.app.openExternal, async (url) => {
    const value = asString(url, '链接')
    if (!/^(https?:\/\/|mailto:)/i.test(value))
      throw new AppError('INVALID_INPUT', '只允许打开 http/https/mailto 链接。')
    await shell.openExternal(value)
  })

  handle<void>(IPC.app.windowControl, async (action) => {
    const value = asString(action, '窗口操作')
    if (value === 'minimize') window.minimize()
    else if (value === 'maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (value === 'close') window.close()
  })

  handle<void>(IPC.app.openUserData, async () => {
    await shell.openPath(appPaths().userData)
  })

  handle(IPC.app.chooseDirectory, async (title) => {
    const result = await dialog.showOpenDialog(window, {
      title: typeof title === 'string' && title ? title : '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(IPC.app.readClipboardText, async () => clipboard.readText())

  handle(IPC.app.writeClipboardText, async (text) => {
    await clipboard.writeText(asString(text, '剪贴板文本'))
  })

  handle(IPC.app.resolveClose, async (action, remember) => {
    const choice = action === 'tray' ? 'tray' : 'quit'
    await context.lifecycle.resolveClose(choice, Boolean(remember))
  })

  /* ----------------------------- documents ---------------------------- */

  handle(IPC.documents.openDialog, async () => {
    const opened = await context.documents.openDialog(window)
    if (opened.length) await context.lifecycle.persistOpenFiles()
    return opened
  })

  handle(IPC.documents.openPath, async (path) => {
    const raw = asString(path, '文件路径')
    const current = context.workspace.getCurrent()
    const absolute = isAbsolute(raw) ? resolve(raw) : current ? resolve(current.rootPath, raw) : resolve(raw)
    if (!allowDocumentPath(absolute))
      throw new AppError('OUT_OF_SCOPE', '只能打开工作区内或最近打开过的文件。')
    const snapshot = await context.documents.openPath(absolute, true)
    await context.lifecycle.persistOpenFiles()
    return snapshot
  })

  // 用户把文件拖到标签栏属于显式授权，可以打开工作区外的文稿；
  // 扩展名、是否存在、文件大小仍由 DocumentService.readTextDocument 统一校验。
  handle(IPC.documents.openDropped, async (path) => {
    const raw = asString(path, '文件路径')
    if (!isAbsolute(raw)) throw new AppError('INVALID_INPUT', '拖入的文件路径无效。')
    const snapshot = await context.documents.openPath(resolve(raw), true)
    await context.lifecycle.persistOpenFiles()
    return snapshot
  })

  handle(IPC.documents.newDocument, async (input) =>
    context.documents.newDocument((input ?? {}) as NewDocumentInput)
  )

  handle(IPC.documents.snapshot, async (documentId) =>
    context.documents.snapshot(asString(documentId, '文档 ID'))
  )

  handle(IPC.documents.update, async (documentId, text, baseRevision) => {
    if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH)
      throw new AppError('INVALID_INPUT', '文本内容不合法。')
    if (typeof baseRevision !== 'number') throw new AppError('INVALID_INPUT', '版本号不合法。')
    return context.documents.update(asString(documentId, '文档 ID'), text, baseRevision)
  })

  handle(IPC.documents.save, async (documentId, expectedRevision) =>
    context.documents.save(asString(documentId, '文档 ID'), Number(expectedRevision))
  )

  handle(IPC.documents.saveAs, async (documentId) => {
    const result = await context.documents.saveAs(asString(documentId, '文档 ID'))
    if (result) await context.lifecycle.persistOpenFiles()
    return result
  })

  handle(IPC.documents.close, async (documentId) => {
    await context.documents.close(asString(documentId, '文档 ID'))
    await context.lifecycle.persistOpenFiles()
  })

  handle(IPC.documents.listOpen, async () => context.documents.listOpen())

  handle(IPC.documents.recent, async () => context.documents.recent())

  handle(IPC.documents.resolveConflict, async (documentId, choice) => {
    const value = asString(choice, '处理方式')
    if (!['reload', 'overwrite', 'saveAs'].includes(value)) throw new AppError('INVALID_INPUT')
    return context.documents.resolveConflict(
      asString(documentId, '文档 ID'),
      value as 'reload' | 'overwrite' | 'saveAs'
    )
  })

  handle(IPC.documents.recoveryList, async () => context.documents.recoveryList())
  handle(IPC.documents.recoveryRestore, async (documentId) =>
    context.documents.recoveryRestore(asString(documentId, '文档 ID'))
  )
  handle(IPC.documents.recoveryDiscard, async (documentId) =>
    context.documents.recoveryDiscard(asString(documentId, '文档 ID'))
  )

  handle(IPC.documents.inlineImages, async (documentId, urls) => {
    const list = Array.isArray(urls)
      ? urls.filter((item): item is string => typeof item === 'string').slice(0, 100)
      : []
    return context.media.inlineImages(asString(documentId, '文档 ID'), list)
  })

  handle(IPC.documents.pickImage, async (documentId) =>
    context.documents.pickImage(asString(documentId, '文档 ID'))
  )

  handle(IPC.documents.saveImage, async (documentId, name, _mime, bytes) => {
    if (!(bytes instanceof ArrayBuffer)) throw new AppError('INVALID_INPUT', '图片数据格式不正确。')
    if (bytes.byteLength > 12 * 1024 * 1024) throw new AppError('INVALID_INPUT', '图片超过 12MB 限制。')
    return context.documents.saveImage(
      documentId ? asString(documentId, '文档 ID') : null,
      asString(name, '文件名'),
      bytes
    )
  })

  /* ----------------------------- workspace ---------------------------- */

  handle(IPC.workspace.current, async () => context.workspace.getCurrent())

  handle(IPC.workspace.openDialog, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '打开工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return openWorkspace(result.filePaths[0])
  })

  handle(IPC.workspace.openPath, async (path) => {
    const value = asString(path, '工作区路径')
    const allowed = context.settings.get().recentWorkspaces.some((item) => samePath(item, value))
    if (!allowed) throw new AppError('OUT_OF_SCOPE', '请通过目录选择器打开新的工作区。')
    return openWorkspace(value)
  })

  async function openWorkspace(path: string) {
    const info = await context.workspace.open(path)
    await context.settings.rememberWorkspace(info.rootPath)
    broadcast(IPC.events.workspaceChanged, {
      workspaceId: info.workspaceId,
      reason: 'reset',
      relativePath: ''
    })
    broadcast(IPC.events.settingsChanged, context.settings.get())
    return info
  }

  handle(IPC.workspace.tree, async () => {
    const current = context.workspace.getCurrent()
    if (!current) return null
    return { workspace: current, tree: await context.workspace.tree() }
  })

  handle(IPC.workspace.readFile, async (relativePath) =>
    context.workspace.readText(asString(relativePath, '相对路径')).then((result) => result.text)
  )

  handle(IPC.workspace.createFile, async (input) => {
    const data = asRecord(input, '创建参数')
    const relativePath = asString(data.relativePath, '相对路径')
    const content = typeof data.content === 'string' ? data.content : ''
    const created = await context.workspace.createFile(relativePath, content)
    let document = null
    if (data.open !== false) {
      const current = context.workspace.getCurrent()
      if (current) document = await context.documents.openPath(resolve(current.rootPath, created), true)
    }
    return { relativePath: created, document }
  })

  handle(IPC.workspace.imagePreview, async (relativePath) =>
    context.workspace.imagePreview(asString(relativePath, '图片路径'))
  )

  handle(IPC.workspace.createFolder, async (relativePath) =>
    context.workspace.createFolder(asString(relativePath, '相对路径'))
  )

  handle(IPC.workspace.rename, async (from, to) => {
    const fromPath = asString(from, '原路径')
    const toPath = asString(to, '新路径')
    const result = await context.workspace.rename(fromPath, toPath)
    await context.documents.handleRenamed(fromPath, toPath)
    return result
  })

  handle(IPC.workspace.remove, async (relativePath) => {
    const value = asString(relativePath, '相对路径')
    const result = await context.workspace.remove(value)
    await context.documents.handleWorkspaceEvent('unlink', value)
    return result
  })

  handle(IPC.workspace.search, async (query, limit) =>
    context.workspace.search(asString(query, '关键词'), Number(limit) || 40)
  )

  handle(IPC.workspace.reveal, async (relativePath) =>
    context.workspace.reveal(asString(relativePath, '相对路径'))
  )

  handle(IPC.workspace.recent, async () =>
    context.settings
      .get()
      .recentWorkspaces.map((path) => ({ path, title: path.split(/[\\/]/).pop() ?? path, openedAt: 0 }))
  )

  /* ------------------------------ settings ---------------------------- */

  handle(IPC.settings.get, async () => context.settings.get())
  handle(IPC.settings.update, async (patch) => {
    const next = await context.settings.update((patch ?? {}) as PartialSettings)
    if (next.storage.cacheDir) configureCacheDir(next.storage.cacheDir)
    broadcast(IPC.events.settingsChanged, next)
    return next
  })
  handle(IPC.settings.reset, async () => {
    const next = await context.settings.reset()
    configureCacheDir('')
    broadcast(IPC.events.settingsChanged, next)
    return next
  })

  /* ----------------------------- providers ---------------------------- */

  handle(IPC.providers.list, async () => context.providers.list())
  handle(IPC.providers.save, async (input) => {
    const data = asRecord(input, '模型配置') as unknown as ProviderInput
    const saved = await context.providers.save(data)
    return saved
  })
  handle(IPC.providers.remove, async (providerId) =>
    context.providers.remove(asString(providerId, '配置 ID'))
  )
  handle(IPC.providers.test, async (providerId) => context.providers.test(asString(providerId, '配置 ID')))
  handle(IPC.providers.setDefault, async (providerId) =>
    context.providers.setDefault(asString(providerId, '配置 ID'))
  )

  /* ------------------------------- agent ------------------------------ */

  handle(IPC.agent.start, async (input) => context.agent.start(input as StartTaskInput))
  handle(IPC.agent.cancel, async (taskId) => context.agent.cancel(asString(taskId, '任务 ID')))
  handle(IPC.agent.answer, async (answer) => context.agent.answer(answer as ClarificationAnswer))
  handle(IPC.agent.snapshot, async (taskId) => context.agent.snapshot(asString(taskId, '任务 ID')))

  /* ------------------------------ changes ----------------------------- */

  handle(IPC.changes.review, async (changeSetId) => context.changes.review(asString(changeSetId, '提案 ID')))
  handle(IPC.changes.accept, async (changeSetId, digest) =>
    context.changes.accept(asString(changeSetId, '提案 ID'), asString(digest, '提案摘要'))
  )
  handle(IPC.changes.reject, async (changeSetId) => context.changes.reject(asString(changeSetId, '提案 ID')))
  handle(IPC.changes.restore, async (transactionId) =>
    context.changes.restore(asString(transactionId, '事务 ID'))
  )
  handle(IPC.changes.list, async () => context.changes.list())

  /* ---------------------------- attachments --------------------------- */

  handle(IPC.attachments.addFromDialog, async () => context.attachments.addFromDialog())
  handle(IPC.attachments.addFromBytes, async (name, mime, bytes) => {
    if (!(bytes instanceof ArrayBuffer)) throw new AppError('INVALID_INPUT', '图片数据格式不正确。')
    if (bytes.byteLength > 12 * 1024 * 1024) throw new AppError('INVALID_INPUT', '图片超过 12MB 限制。')
    return context.attachments.addFromBytes(asString(name, '文件名'), String(mime ?? ''), bytes)
  })
  handle(IPC.attachments.list, async () => context.attachments.list())
  handle(IPC.attachments.remove, async (attachmentId) =>
    context.attachments.remove(asString(attachmentId, '附件 ID'))
  )

  handle(IPC.attachments.dataUrl, async (attachmentId) =>
    context.attachments.dataUrl(asString(attachmentId, '附件 ID'))
  )

  /* ---------------------------- references ---------------------------- */

  handle(IPC.references.add, async (input) => {
    const data = asRecord(input, '参考材料') as unknown as AddSourceInput
    if (data.kind === 'file' && data.path) {
      const current = context.workspace.getCurrent()
      if (!current || !isPathInside(current.rootPath, resolve(data.path))) {
        throw new AppError('OUT_OF_SCOPE', '工作区外的文件请使用“选择文件”按钮。')
      }
    }
    return context.references.add(data)
  })
  handle(IPC.references.addFileDialog, async () => context.references.addFileDialog())
  handle(IPC.references.addFromBytes, async (name, bytes) => {
    if (!(bytes instanceof ArrayBuffer)) throw new AppError('INVALID_INPUT', '文件数据格式不正确。')
    if (bytes.byteLength > 15 * 1024 * 1024) throw new AppError('INVALID_INPUT', '参考文件超过 15MB 限制。')
    return context.references.addFromBytes(asString(name, '文件名'), bytes)
  })
  handle(IPC.references.list, async () => context.references.list())
  handle(IPC.references.remove, async (sourceId) => context.references.remove(asString(sourceId, '来源 ID')))
  handle(IPC.references.preview, async (sourceId) =>
    context.references.preview(asString(sourceId, '来源 ID'))
  )
  handle(IPC.references.setRoles, async (sourceId, roles) => {
    const value = Array.isArray(roles) ? roles : []
    const allowed = ['facts', 'data', 'writing_style', 'visual_style']
    if (!value.length || value.some((role) => !allowed.includes(String(role)))) {
      throw new AppError('INVALID_INPUT', '用途标签不合法。')
    }
    return context.references.setRoles(asString(sourceId, '来源 ID'), value as AddSourceInput['roles'])
  })

  /* ------------------------------- styles ----------------------------- */

  handle(IPC.styles.list, async () => context.styles.list())
  handle(IPC.styles.save, async (input) => context.styles.save(input as StyleProfileInput))
  handle(IPC.styles.remove, async (profileId) => context.styles.remove(asString(profileId, '风格 ID')))

  /* ----------------------------- prediction --------------------------- */

  handle(IPC.prediction.request, async (input) => context.prediction.request(input as PredictionRequestInput))
  handle(IPC.prediction.cancel, async (requestId) =>
    context.prediction.cancel(asString(requestId, '请求 ID'))
  )

  /* ------------------------------- themes ----------------------------- */

  handle(IPC.themes.list, async () => context.themes.list())
  handle(IPC.themes.import, async () => context.themes.importDialog())
  handle(IPC.themes.activate, async (themeId) => context.themes.activate(asString(themeId, '主题 ID')))
  handle(IPC.themes.remove, async (themeId) => context.themes.remove(asString(themeId, '主题 ID')))
  handle(IPC.themes.css, async (themeId) => context.themes.css(asString(themeId, '主题 ID')))

  /* ------------------------------ exports ----------------------------- */

  handle(IPC.exports.saveHtml, async (html, suggestedName) => {
    if (typeof html !== 'string') throw new AppError('INVALID_INPUT', 'HTML 内容不合法。')
    return context.exports.saveHtml(html, String(suggestedName ?? '导出.html'))
  })
  handle(IPC.exports.saveMarkdown, async (text, suggestedName) => {
    if (typeof text !== 'string') throw new AppError('INVALID_INPUT', 'Markdown 内容不合法。')
    return context.exports.saveMarkdown(text, String(suggestedName ?? '导出.md'))
  })
  handle(IPC.exports.saveMarkdownBundle, async (documentId, text, suggestedName) => {
    if (typeof text !== 'string') throw new AppError('INVALID_INPUT', 'Markdown 内容不合法。')
    return context.exports.saveMarkdownBundle(
      asString(documentId, '文档 ID'),
      text,
      String(suggestedName ?? '导出.md')
    )
  })
  handle(IPC.exports.saveMarkdownInline, async (documentId, text, suggestedName) => {
    if (typeof text !== 'string') throw new AppError('INVALID_INPUT', 'Markdown 内容不合法。')
    return context.exports.saveMarkdownInline(
      asString(documentId, '文档 ID'),
      text,
      String(suggestedName ?? '导出.md')
    )
  })
  handle(IPC.exports.savePdf, async (input) => context.exports.savePdf(input as ExportPdfInput))
  handle(IPC.exports.pandocStatus, async () => context.exports.pandocStatus())
  handle(IPC.exports.pandocConvert, async (input) => {
    const result = await context.exports.pandocConvert(input as PandocConvertInput)
    if (result.ok && result.outputPath && (input as PandocConvertInput).direction === 'import') {
      // 导入后由主进程登记为最近文件并打开标签，避免渲染进程直接访问任意路径
      await context.documents.openPath(result.outputPath, true).catch(() => undefined)
    }
    return result
  })

  /* ------------------------------- bridge ----------------------------- */

  ipcMain.on(IPC.bridge.response, (event, response) => {
    if (!trusted(event)) return
    if (!response || typeof response !== 'object') return
    context.bridge.handleResponse(response as never)
  })

  logger.info('ipc', 'IPC 通道注册完成')
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 暴露给主进程其他模块的广播辅助 */
export function createNotifier(context: IpcContext): {
  agent: (event: unknown) => void
  workspace: (payload: unknown) => void
  document: (payload: unknown) => void
  conflict: (payload: unknown) => void
  settings: (payload: unknown) => void
} {
  const send = (channel: string, payload: unknown): void => {
    if (!context.window.isDestroyed()) context.window.webContents.send(channel, payload)
  }
  return {
    agent: (event) => send(IPC.events.agent, event),
    workspace: (payload) => send(IPC.events.workspaceChanged, payload),
    document: (payload) => send(IPC.events.documentChanged, payload),
    conflict: (payload) => send(IPC.events.documentConflict, payload),
    settings: (payload) => send(IPC.events.settingsChanged, payload)
  }
}
