/**
 * 文档服务：打开、同步、保存、外部冲突、未保存恢复草稿。
 * 磁盘编码固定 UTF-8；内存统一 LF；保存时按原文档风格还原 CRLF 与 BOM。
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type {
  DiskConflictInfo,
  DocumentSnapshot,
  EolStyle,
  InsertedImage,
  PickedImageData,
  RecentEntry,
  RecoveryEntry,
  SaveResult
} from '@shared/types'
import { AppError } from '@shared/errors'
import { collectDataImageRefs, rewriteImageRefs } from '@shared/markdown/images'
import {
  atomicWriteFile,
  isPathInside,
  newId,
  normalizeToLf,
  pathExists,
  readTextDocument,
  sha256,
  toDiskText,
  toPosix
} from '../utils/fs'
import { sanitizeImageName, sniffImage } from '../utils/image'
import { appPaths } from '../utils/paths'
import { logger } from '../utils/logger'
import type { WorkspaceService } from '../workspace/service'
import type { EditorBridge } from '../bridge'
import type { SettingsStore } from '../settings/store'
import { DocumentSession } from './session'
import type { NewDocumentInput } from '@shared/ipc'

const TEXT_EXT = new Set(['.md', '.markdown', '.mdx', '.txt'])
const MAX_OPEN_DOCUMENTS = 30

interface RecoveryFile {
  documentId: string
  title: string
  absPath: string | null
  relativePath: string | null
  workspaceId: string | null
  text: string
  eol: EolStyle
  hasBom: boolean
  savedAt: number
  revision: number
  diskFingerprint?: string | null
}

/** 维护文稿会话、版本同步、保存冲突、图片资产和未保存草稿恢复。 */
export class DocumentService {
  private sessions = new Map<string, DocumentSession>()
  private openOrder = new Map<string, number>()
  private byPath = new Map<string, string>()
  private recoveryTimers = new Map<string, NodeJS.Timeout>()

  private changeListener:
    | ((snapshot: DocumentSnapshot, origin: 'renderer' | 'external' | 'agent' | 'reload' | 'save') => void)
    | null = null
  private conflictListener: ((conflict: DiskConflictInfo) => void) | null = null

  /** 注入文稿会话依赖，包括工作区、设置与编辑器桥。 */
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly bridge: EditorBridge,
    private readonly settings: SettingsStore
  ) {}

  /** 注册文稿快照变更监听器。 */
  onChanged(
    listener: (
      snapshot: DocumentSnapshot,
      origin: 'renderer' | 'external' | 'agent' | 'reload' | 'save'
    ) => void
  ): void {
    this.changeListener = listener
  }

  /** 注册文稿外部磁盘冲突监听器。 */
  onConflict(listener: (conflict: DiskConflictInfo) => void): void {
    this.conflictListener = listener
  }

  private pathKey(absPath: string): string {
    const normalized = resolve(absPath)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  private emit(
    session: DocumentSession,
    origin: 'renderer' | 'external' | 'agent' | 'reload' | 'save'
  ): void {
    this.changeListener?.(session.snapshot(), origin)
  }

  /** 按 ID 查找主进程中的文稿会话。 */
  getSession(documentId: string): DocumentSession {
    const session = this.sessions.get(documentId)
    if (!session) throw new AppError('FILE_NOT_FOUND', '文档会话不存在或已关闭。')
    return session
  }

  /** 取得该文稿会话关联的磁盘绝对路径。 */
  getAbsPath(documentId: string): string | null {
    return this.sessions.get(documentId)?.absPath ?? null
  }

  /** 返回已附加到界面的文稿快照列表。 */
  listOpen(): DocumentSnapshot[] {
    return [...this.sessions.values()]
      .filter((session) => session.attached)
      .sort((a, b) => {
        const first = this.openOrder.get(a.documentId) ?? Number.MAX_SAFE_INTEGER
        const second = this.openOrder.get(b.documentId) ?? Number.MAX_SAFE_INTEGER
        return first - second || a.openedAt - b.openedAt
      })
      .map((session) => session.snapshot())
  }

  reorderOpen(ids: string[]): void {
    const open = this.listOpen().map((document) => document.documentId)
    const known = new Set(open)
    const order = new Set(ids.filter((id) => known.has(id)))
    for (const id of open) order.add(id)
    this.openOrder = new Map([...order].map((id, index) => [id, index]))
  }

  /** 让用户选择一个或多个 Markdown 文件并打开会话。 */
  async openDialog(window: BrowserWindow | null): Promise<DocumentSnapshot[]> {
    const options: Electron.OpenDialogOptions = {
      title: '打开 Markdown 文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown / 文本', extensions: ['md', 'markdown', 'mdx', 'txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    const snapshots: DocumentSnapshot[] = []
    for (const file of result.filePaths.slice(0, 8)) {
      const snapshot = await this.openPath(file, true)
      snapshots.push(snapshot)
    }
    return snapshots
  }

  /** 以指定路径打开或复用文稿会话，返回当前快照。 */
  async openPath(absPath: string, attached = true): Promise<DocumentSnapshot> {
    const resolved = resolve(absPath)
    if (!TEXT_EXT.has(extname(resolved).toLowerCase())) {
      throw new AppError('INVALID_INPUT', '目前只支持打开 Markdown 与纯文本文件。')
    }
    const key = this.pathKey(resolved)
    const existingId = this.byPath.get(key)
    if (existingId) {
      const existing = this.sessions.get(existingId)
      if (existing) {
        if (attached) {
          existing.attached = true
          existing.openedAt = Date.now()
        }
        await this.settings.rememberFile(resolved, existing.title)
        return existing.snapshot()
      }
    }
    if (this.listOpen().length >= MAX_OPEN_DOCUMENTS) {
      throw new AppError('INVALID_INPUT', `同时打开的文档不能超过 ${MAX_OPEN_DOCUMENTS} 个。`)
    }

    const disk = await readTextDocument(resolved)
    const workspace = this.workspace.getCurrent()
    const insideWorkspace = workspace ? isPathInside(workspace.rootPath, resolved) : false
    const session = new DocumentSession({
      documentId: newId('doc'),
      workspaceId: insideWorkspace ? workspace!.workspaceId : null,
      absPath: resolved,
      relativePath: insideWorkspace ? toPosix(relative(workspace!.rootPath, resolved)) : null,
      title: basename(resolved),
      text: disk.text,
      eol: disk.eol,
      hasBom: disk.hasBom,
      diskFingerprint: disk.fingerprint,
      existsOnDisk: true,
      attached
    })
    this.sessions.set(session.documentId, session)
    this.byPath.set(key, session.documentId)
    await this.settings.rememberFile(resolved, session.title)
    return session.snapshot()
  }

  /** Agent 读取工作区外的文件前，必须由用户显式选择 */
  async pickExternalFile(window: BrowserWindow | null): Promise<DocumentSnapshot | null> {
    const options: Electron.OpenDialogOptions = {
      title: '选择要允许访问的文件',
      properties: ['openFile'],
      filters: [{ name: 'Markdown / 文本', extensions: ['md', 'markdown', 'txt'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return this.openPath(result.filePaths[0], false)
  }

  /** 为 Agent 创建不显示标签页的会话，用于读取或修改未打开文件 */
  async openHeadless(absPath: string): Promise<DocumentSnapshot> {
    const key = this.pathKey(resolve(absPath))
    const existingId = this.byPath.get(key)
    if (existingId) {
      const existing = this.sessions.get(existingId)
      if (existing) return existing.snapshot()
    }
    return this.openPath(absPath, false)
  }

  /** 创建文稿会话，并按输入决定是否关联工作区目标路径。 */
  async newDocument(input: NewDocumentInput = {}): Promise<DocumentSnapshot> {
    const workspace = this.workspace.getCurrent()
    const relPath = input.relativePath?.trim()
    if (relPath && workspace) {
      const created = await this.workspace.createFile(relPath, input.content ?? '')
      const opened = await this.openPath(resolve(workspace.rootPath, created), true)
      return opened
    }
    if (this.listOpen().length >= MAX_OPEN_DOCUMENTS) {
      throw new AppError('INVALID_INPUT', `同时打开的文档不能超过 ${MAX_OPEN_DOCUMENTS} 个。`)
    }
    const title = input.title?.trim() || '未命名文稿.md'
    const session = new DocumentSession({
      documentId: newId('doc'),
      workspaceId: workspace?.workspaceId ?? null,
      absPath: null,
      relativePath: null,
      title,
      text: input.content ?? '',
      eol: 'lf',
      hasBom: false,
      diskFingerprint: null,
      existsOnDisk: false,
      attached: true
    })
    this.sessions.set(session.documentId, session)
    this.scheduleRecovery(session)
    return session.snapshot()
  }

  /** 读取指定文稿的当前会话快照。 */
  snapshot(documentId: string): DocumentSnapshot {
    return this.getSession(documentId).snapshot()
  }

  /**
   * 渲染进程推送最新文本。revision 不匹配说明存在乱序或旧请求，
   * 直接拒绝而不是覆盖，避免静默丢失编辑。
   */
  update(documentId: string, text: string, baseRevision: number): DocumentSnapshot {
    const session = this.getSession(documentId)
    if (baseRevision !== session.revision) {
      throw new AppError(
        'REVISION_CONFLICT',
        `文档版本已变化（当前 ${session.revision}，收到 ${baseRevision}）。`
      )
    }
    session.applyText(text)
    this.scheduleRecovery(session)
    return session.snapshot()
  }

  /** 尽力读取渲染端最新缓冲区；未附加到标签或无法同步时返回现有主进程快照。 */
  async syncForAgent(documentId: string): Promise<DocumentSnapshot> {
    const session = this.getSession(documentId)
    if (session.attached) {
      const response = await this.bridge.sync(documentId)
      if (response?.ok && typeof response.text === 'string') {
        session.applyText(response.text)
      }
    }
    return session.snapshot()
  }

  /**
   * 选择保存路径并绑定会话，但不写盘；图片落盘需要先用这个路径确定资源目录。
   */
  private async bindSavePath(session: DocumentSession): Promise<boolean> {
    const workspace = this.workspace.getCurrent()
    const defaultPath =
      session.absPath ??
      (workspace ? join(workspace.rootPath, session.title) : join(appPaths().userData, session.title))
    const result = await dialog.showSaveDialog({
      title: '另存为',
      defaultPath,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '纯文本', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePath) return false
    const target = resolve(result.filePath)
    const oldKey = session.absPath ? this.pathKey(session.absPath) : null
    const insideWorkspace = workspace ? isPathInside(workspace.rootPath, target) : false
    session.relocate(
      target,
      insideWorkspace ? toPosix(relative(workspace!.rootPath, target)) : null,
      insideWorkspace ? workspace!.workspaceId : null
    )
    if (oldKey) this.byPath.delete(oldKey)
    this.byPath.set(this.pathKey(target), session.documentId)
    await this.settings.rememberFile(target, session.title)
    return true
  }

  /**
   * 把未落盘时以 base64 内嵌的图片写成资源文件，并把 Markdown 改回相对路径。
   * 写盘前调用，保证磁盘上和编辑器里最终都是相对引用。
   */
  private async persistInlineImages(session: DocumentSession): Promise<number> {
    const refs = collectDataImageRefs(session.text)
    if (!refs.length) return 0
    const mapping = new Map<string, string>()
    for (const [index, dataUrl] of refs.entries()) {
      try {
        const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl)
        if (!match) continue
        const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
        if (!buffer.length || buffer.length > 12 * 1024 * 1024) continue
        const saved = await this.writeImage(session.documentId, `inline-${index + 1}`, buffer)
        mapping.set(dataUrl, `./${saved.relativePath}`)
      } catch (error) {
        logger.warn('documents', '内联图片落盘失败，保留原 data URL', {
          documentId: session.documentId,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (mapping.size) session.applyText(rewriteImageRefs(session.text, mapping))
    return mapping.size
  }

  /** 保存正文；未绑定路径时先选路径，保存前把内联图片转为本地资源。 */
  async save(documentId: string, expectedRevision: number, force = false): Promise<SaveResult> {
    const session = this.getSession(documentId)
    const revisionBeforeSave = session.revision
    if (!session.absPath && !(await this.bindSavePath(session))) {
      return { status: 'failed', snapshot: session.snapshot(), message: '尚未选择保存位置。' }
    }

    if (!force && session.diskFingerprint) {
      const disk = await readTextDocument(session.absPath!).catch(() => null)
      if (disk && disk.fingerprint !== session.diskFingerprint && disk.text !== session.text) {
        const conflict: DiskConflictInfo = {
          documentId,
          diskHash: disk.fingerprint,
          sessionHash: session.contentHash,
          message: '磁盘文件已被外部修改，请选择重新载入或覆盖。'
        }
        this.conflictListener?.(conflict)
        return { status: 'conflict', snapshot: session.snapshot(), message: conflict.message }
      }
    }

    const convertedImages = await this.persistInlineImages(session)
    const textAtSave = session.text
    const revisionAtSave = session.revision
    try {
      const buffer = toDiskText(textAtSave, session.eol, session.hasBom)
      await atomicWriteFile(session.absPath!, buffer)
      session.markSaved(sha256(buffer))
      this.emit(session, 'save')
      if (session.dirty) this.scheduleRecovery(session)
      else await this.clearRecovery(documentId)
      return {
        status: 'saved',
        snapshot: session.snapshot(),
        convertedImages: convertedImages || undefined,
        message:
          expectedRevision !== revisionBeforeSave || session.revision !== revisionAtSave
            ? '已保存当时的版本，但保存期间又有新的修改尚未写入。'
            : undefined
      }
    } catch (error) {
      logger.error('documents', '保存失败', {
        documentId,
        message: error instanceof Error ? error.message : String(error)
      })
      return {
        status: 'failed',
        snapshot: session.snapshot(),
        message: error instanceof Error ? error.message : '保存失败。'
      }
    }
  }

  /** 让用户选择新路径并将当前文稿写入所选位置。 */
  async saveAs(documentId: string): Promise<SaveResult | null> {
    const session = this.getSession(documentId)
    if (!(await this.bindSavePath(session))) return null
    try {
      const convertedImages = await this.persistInlineImages(session)
      const target = session.absPath!
      const buffer = toDiskText(session.text, session.eol, session.hasBom)
      await atomicWriteFile(target, buffer)
      session.markSaved(sha256(buffer))
      await this.clearRecovery(documentId)
      this.emit(session, 'save')
      return {
        status: 'saved',
        snapshot: session.snapshot(),
        convertedImages: convertedImages || undefined
      }
    } catch (error) {
      return {
        status: 'failed',
        snapshot: session.snapshot(),
        message: error instanceof Error ? error.message : '另存为失败。'
      }
    }
  }

  /** 资源目录：文稿所在目录优先，其次工作区根目录；目录名来自设置 */
  private assetsTarget(session: DocumentSession | null): { dir: string; root: string } {
    const folder = this.settings.get().storage.assetsFolder || 'assets'
    const segments = folder.split('/').filter(Boolean)
    if (session) {
      // 未保存的文稿没有可靠目录，写入后相对路径无法解析，直接提示先保存
      if (!session.absPath) {
        throw new AppError('INVALID_INPUT', '请先保存文稿，图片会放在文稿同级的资源目录。')
      }
      const root = dirname(session.absPath)
      return { dir: join(root, ...segments), root }
    }
    const workspace = this.workspace.getCurrent()
    if (workspace) return { dir: join(workspace.rootPath, ...segments), root: workspace.rootPath }
    throw new AppError('INVALID_INPUT', '请先保存文稿或打开工作区，再插入图片。')
  }

  /**
   * 把图片写入文稿同级的资源目录，返回相对文稿的 POSIX 路径。
   * 文件名带内容哈希前缀，重复粘贴同一张图不会产生多份副本。
   */
  async saveImage(documentId: string | null, name: string, bytes: ArrayBuffer): Promise<InsertedImage> {
    return this.writeImage(documentId, name, Buffer.from(bytes))
  }

  private async writeImage(documentId: string | null, name: string, buffer: Buffer): Promise<InsertedImage> {
    if (buffer.length === 0) throw new AppError('INVALID_INPUT', '图片内容为空。')
    if (buffer.length > 12 * 1024 * 1024) throw new AppError('INVALID_INPUT', '图片超过 12MB 限制。')
    const info = sniffImage(buffer)
    if (!info) throw new AppError('INVALID_INPUT', '仅支持 PNG、JPEG、WebP、GIF 图片。')
    const session = documentId ? this.getSession(documentId) : null
    const target = this.assetsTarget(session)
    await mkdir(target.dir, { recursive: true })
    const fileName = `${sha256(buffer).slice(0, 8)}-${sanitizeImageName(name)}.${info.extension}`
    const abs = join(target.dir, fileName)
    if (!(await pathExists(abs))) await writeFile(abs, buffer, { flag: 'wx' })
    const alt = basename(name, extname(name)).replace(/[[\]]/g, ' ').trim() || '图片'
    return {
      relativePath: toPosix(relative(target.root, abs)),
      alt,
      name: fileName,
      size: buffer.length
    }
  }

  /** 弹出图片文件选择器，返回原始字节供落盘或内嵌使用。 */
  private async pickImageFile(): Promise<{ name: string; buffer: Buffer } | null> {
    const result = await dialog.showOpenDialog({
      title: '插入图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const source = result.filePaths[0]
    const info = await stat(source).catch(() => null)
    if (!info?.isFile()) throw new AppError('FILE_NOT_FOUND', '图片文件不存在。')
    if (info.size > 12 * 1024 * 1024) throw new AppError('INVALID_INPUT', '图片超过 12MB 限制。')
    return { name: basename(source), buffer: await readFile(source) }
  }

  /** 弹出文件选择器，复制选中的图片到资源目录 */
  async pickImage(documentId: string): Promise<InsertedImage | null> {
    const session = this.getSession(documentId)
    const picked = await this.pickImageFile()
    if (!picked) return null
    return this.writeImage(session.documentId, picked.name, picked.buffer)
  }

  /** 未保存草稿专用：只返回 base64，等保存时再写入资源目录。 */
  async pickImageData(): Promise<PickedImageData | null> {
    const picked = await this.pickImageFile()
    if (!picked) return null
    const info = sniffImage(picked.buffer)
    if (!info) throw new AppError('INVALID_INPUT', '仅支持 PNG、JPEG、WebP、GIF 图片。')
    return {
      name: picked.name,
      mime: info.mime,
      size: picked.buffer.length,
      dataUrl: `data:${info.mime};base64,${picked.buffer.toString('base64')}`
    }
  }

  /** 关闭文稿会话并清理对应的恢复草稿。 */
  async close(documentId: string): Promise<void> {
    const session = this.sessions.get(documentId)
    if (!session) return
    session.attached = false
    if (!session.dirty) {
      this.sessions.delete(documentId)
      if (session.absPath) this.byPath.delete(this.pathKey(session.absPath))
      await this.clearRecovery(documentId)
    } else {
      this.scheduleRecovery(session)
    }
    this.emit(session, 'reload')
  }

  /** 按用户选择重载磁盘内容、覆盖保存或另存文稿。 */
  async resolveConflict(
    documentId: string,
    choice: 'reload' | 'overwrite' | 'saveAs'
  ): Promise<SaveResult | DocumentSnapshot | null> {
    const session = this.getSession(documentId)
    if (choice === 'reload') {
      if (!session.absPath) throw new AppError('FILE_NOT_FOUND')
      const disk = await readTextDocument(session.absPath)
      session.markReloaded({
        text: disk.text,
        eol: disk.eol,
        hasBom: disk.hasBom,
        fingerprint: disk.fingerprint
      })
      await this.clearRecovery(documentId)
      this.emit(session, 'external')
      return session.snapshot()
    }
    if (choice === 'overwrite') return this.save(documentId, session.revision, true)
    return this.saveAs(documentId)
  }

  /** 读取持久化的最近打开文件列表。 */
  recent(): RecentEntry[] {
    return this.settings.get().recentFiles
  }

  /** 窗口重新聚焦或收到文件变更事件时调用 */
  async checkExternal(documentId: string): Promise<void> {
    const session = this.sessions.get(documentId)
    if (!session?.absPath) return
    const disk = await readTextDocument(session.absPath).catch(() => null)
    if (!disk) {
      if (session.existsOnDisk) {
        session.existsOnDisk = false
        this.emit(session, 'external')
      }
      return
    }
    if (session.diskFingerprint && disk.fingerprint === session.diskFingerprint) return

    if (session.dirty) {
      this.conflictListener?.({
        documentId,
        diskHash: disk.fingerprint,
        sessionHash: session.contentHash,
        message: '检测到外部修改，同时本地有未保存内容。'
      })
      return
    }
    session.markReloaded({
      text: disk.text,
      eol: disk.eol,
      hasBom: disk.hasBom,
      fingerprint: disk.fingerprint
    })
    this.emit(session, 'external')
  }

  /** 根据工作区事件检查已打开文稿的磁盘状态。 */
  async handleWorkspaceEvent(reason: string, relativePath: string): Promise<void> {
    const affected = [...this.sessions.values()].filter((session) => session.relativePath === relativePath)
    for (const session of affected) {
      if (reason === 'change') await this.checkExternal(session.documentId)
      else if (reason === 'unlink') {
        session.existsOnDisk = false
        this.emit(session, 'external')
      }
    }
  }

  /** 工作区文件被重命名后，同步打开中的会话路径 */
  async handleRenamed(fromRel: string, toRel: string): Promise<void> {
    const workspace = this.workspace.getCurrent()
    if (!workspace) return
    for (const session of this.sessions.values()) {
      if (!session.relativePath) continue
      if (session.relativePath === fromRel || session.relativePath.startsWith(`${fromRel}/`)) {
        const nextRel = `${toRel}${session.relativePath.slice(fromRel.length)}`
        const abs = resolve(workspace.rootPath, nextRel)
        if (session.absPath) this.byPath.delete(this.pathKey(session.absPath))
        session.relocate(abs, nextRel, workspace.workspaceId)
        this.byPath.set(this.pathKey(abs), session.documentId)
        this.emit(session, 'external')
      }
    }
  }

  /* ---------------------------- 恢复草稿 ---------------------------- */

  private scheduleRecovery(session: DocumentSession): void {
    const existing = this.recoveryTimers.get(session.documentId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(session.documentId)
      void this.writeRecovery(session).catch(() => undefined)
    }, 700)
    this.recoveryTimers.set(session.documentId, timer)
  }

  private async writeRecovery(session: DocumentSession, includeClean = false): Promise<void> {
    if (!session.dirty && !includeClean) return
    const payload: RecoveryFile = {
      documentId: session.documentId,
      title: session.title,
      absPath: session.absPath,
      relativePath: session.relativePath,
      workspaceId: session.workspaceId,
      text: session.text,
      eol: session.eol,
      hasBom: session.hasBom,
      savedAt: Date.now(),
      revision: session.revision,
      diskFingerprint: session.diskFingerprint
    }
    await atomicWriteFile(
      join(appPaths().sessionsDir, `${session.documentId}.json`),
      JSON.stringify(payload)
    )
  }

  async preserveUpdateSession(version: string): Promise<void> {
    const entries = await Promise.all(this.listOpen().map(async ({ documentId }) => {
      const session = this.getSession(documentId)
      const response = await this.bridge.sync(documentId)
      if (!response?.ok) {
        throw new AppError('SAVE_FAILED', '无法读取更新前的文稿缓冲区。')
      }
      if (typeof response.text === 'string') session.applyText(response.text)
      if (!session.dirty && session.absPath) return { path: session.absPath }
      const timer = this.recoveryTimers.get(documentId)
      if (timer) clearTimeout(timer)
      this.recoveryTimers.delete(documentId)
      await this.writeRecovery(session, true)
      return { recoveryId: documentId }
    }))
    await atomicWriteFile(join(appPaths().sessionsDir, 'update-session'), JSON.stringify({ version, entries }))
  }

  async restoreUpdateSession(version: string): Promise<number> {
    const path = join(appPaths().sessionsDir, 'update-session')
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (!raw) return 0
    let restored = 0
    try {
      const state = JSON.parse(raw) as { version: string; entries: Array<{ path?: string; recoveryId?: string }> }
      if (state.version === version) return 0
      for (const entry of state.entries.slice(0, MAX_OPEN_DOCUMENTS)) {
        try {
          if (entry.recoveryId && /^doc_[a-f0-9]{16}$/.test(entry.recoveryId)) {
            await this.recoveryRestore(entry.recoveryId)
          } else if (entry.path) {
            await this.openPath(entry.path, true)
          } else continue
          restored++
        } catch (error) {
          logger.warn('documents', '恢复更新前的文稿失败', { message: String(error) })
        }
      }
    } catch (error) {
      logger.warn('documents', '更新会话快照无法读取', { message: String(error) })
    }
    await unlink(path).catch(() => undefined)
    return restored
  }

  private async clearRecovery(documentId: string): Promise<void> {
    const timer = this.recoveryTimers.get(documentId)
    if (timer) clearTimeout(timer)
    this.recoveryTimers.delete(documentId)
    await unlink(join(appPaths().sessionsDir, `${documentId}.json`)).catch(() => undefined)
  }

  /** 列出可通过恢复中心处理的本地草稿。 */
  async recoveryList(): Promise<RecoveryEntry[]> {
    const dir = appPaths().sessionsDir
    const files = await readdir(dir).catch(() => [] as string[])
    const entries: RecoveryEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await readFile(join(dir, file), 'utf8').catch(() => null)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as RecoveryFile
        if (this.sessions.get(parsed.documentId)?.attached) continue
        const info = await stat(join(dir, file)).catch(() => null)
        entries.push({
          documentId: parsed.documentId,
          title: parsed.title,
          relativePath: parsed.relativePath,
          savedAt: parsed.savedAt,
          size: info?.size ?? parsed.text.length
        })
      } catch {
        // 忽略损坏的恢复文件
      }
    }
    return entries.sort((a, b) => b.savedAt - a.savedAt)
  }

  /** 从恢复记录重建可打开的文稿会话。 */
  async recoveryRestore(documentId: string): Promise<DocumentSnapshot> {
    const raw = await readFile(join(appPaths().sessionsDir, `${documentId}.json`), 'utf8').catch(() => null)
    if (!raw) throw new AppError('FILE_NOT_FOUND', '恢复草稿不存在。')
    const parsed = JSON.parse(raw) as RecoveryFile
    const existing = this.sessions.get(documentId)
    if (existing) {
      existing.attached = true
      existing.openedAt = Date.now()
      return existing.snapshot()
    }
    const disk = parsed.absPath ? await readTextDocument(parsed.absPath).catch(() => null) : null
    const session = new DocumentSession({
      documentId: parsed.documentId,
      workspaceId: parsed.workspaceId,
      absPath: parsed.absPath,
      relativePath: parsed.relativePath,
      title: parsed.title,
      text: parsed.text,
      eol: parsed.eol,
      hasBom: parsed.hasBom,
      diskFingerprint: parsed.diskFingerprint === undefined ? (disk?.fingerprint ?? null) : parsed.diskFingerprint,
      existsOnDisk: Boolean(disk),
      attached: true
    })
    session.revision = Math.max(parsed.revision, 1)
    session.lastSavedHash = disk ? sha256(normalizeToLf(disk.text)) : ''
    session.dirty = true
    this.sessions.set(session.documentId, session)
    if (session.absPath) this.byPath.set(this.pathKey(session.absPath), session.documentId)
    return session.snapshot()
  }

  /** 删除指定文稿对应的恢复草稿。 */
  async recoveryDiscard(documentId: string): Promise<void> {
    await this.clearRecovery(documentId)
  }

  /** 修改已打开文档的文本，并返回新快照（供变更执行器调用） */
  async applyTextFromAgent(documentId: string, text: string): Promise<DocumentSnapshot> {
    const session = this.getSession(documentId)
    session.applyText(text)
    this.scheduleRecovery(session)
    this.emit(session, 'agent')
    return session.snapshot()
  }
}
