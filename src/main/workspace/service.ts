/**
 * 工作区服务：目录授权、真实文件树、文本搜索、可恢复删除与外部变更监听。
 * 所有路径校验都基于真实路径，字符串前缀判断不足以阻止目录穿越与符号链接逃逸。
 */

import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename as renameFs,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { shell } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import type {
  FileNode,
  FileOperationResult,
  ImagePreviewData,
  WorkspaceInfo,
  WorkspaceSearchHit,
  WorkspaceTree
} from '@shared/types'
import { AppError } from '@shared/errors'
import {
  assertRealPathInside,
  isPathInside,
  newId,
  pathExists,
  readTextDocument,
  resolveInside,
  toPosix
} from '../utils/fs'
import { appPaths } from '../utils/paths'
import { logger } from '../utils/logger'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  'release',
  '.cache',
  '.workbuddy',
  '$RECYCLE.BIN',
  'System Volume Information'
])

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt'])
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024
const MAX_TREE_ENTRIES = 5000
const MAX_TREE_DEPTH = 10
const MAX_SEARCH_FILES = 800
const MAX_SEARCH_BYTES = 1.5 * 1024 * 1024
const MAX_FILE_BYTES = 20 * 1024 * 1024

/** 表示工作区监听到的增删改或重新扫描通知。 */
export interface WorkspaceChangeEvent {
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId: string
  /** 表示监听事件类型或需要整体刷新文件树的信号。 */
  reason: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'reset'
  /** 发生变化的工作区相对路径；整体刷新时不一定提供。 */
  relativePath: string
}

/** 管理工作区根目录、文件树、监听、搜索及受工作区边界约束的文件操作。 */
export class WorkspaceService {
  private current: WorkspaceInfo | null = null
  private watcher: FSWatcher | null = null
  private changeTimer: NodeJS.Timeout | null = null
  private pendingReason: WorkspaceChangeEvent['reason'] = 'reset'
  private onChange: ((event: WorkspaceChangeEvent) => void) | null = null

  /** 读取当前工作区；未打开时返回 null。 */
  getCurrent(): WorkspaceInfo | null {
    return this.current
  }

  /** 获取已打开的工作区；不存在时抛出应用错误。 */
  requireCurrent(): WorkspaceInfo {
    if (!this.current) throw new AppError('OUT_OF_SCOPE', '尚未打开工作区。')
    return this.current
  }

  /** 注册工作区文件系统事件的监听回调。 */
  onWorkspaceChange(listener: (event: WorkspaceChangeEvent) => void): void {
    this.onChange = listener
  }

  /** 切换到指定工作区根目录并启动文件监听。 */
  async open(rootPath: string): Promise<WorkspaceInfo> {
    const resolvedRoot = resolve(rootPath)
    const info = await stat(resolvedRoot).catch(() => null)
    if (!info || !info.isDirectory()) throw new AppError('FILE_NOT_FOUND', '工作区目录不存在。')
    const realRoot = await assertRealPathInside(dirname(resolvedRoot), resolvedRoot)
    await this.stopWatcher()

    this.current = {
      workspaceId:
        this.current && this.current.rootPath === realRoot ? this.current.workspaceId : newId('ws'),
      rootPath: realRoot,
      name: basename(realRoot) || realRoot
    }
    await this.startWatcher(realRoot)
    logger.info('workspace', '打开工作区', { workspaceId: this.current.workspaceId })
    return this.current
  }

  /** 关闭当前工作区并停止其文件监听。 */
  async close(): Promise<void> {
    await this.stopWatcher()
    this.current = null
  }

  /** 扫描当前工作区并返回供文件侧栏展示的目录树。 */
  async tree(): Promise<WorkspaceTree> {
    const workspace = this.requireCurrent()
    let count = 0
    const walk = async (absDir: string, relDir: string, depth: number): Promise<FileNode[]> => {
      if (depth > MAX_TREE_DEPTH || count > MAX_TREE_ENTRIES) return []
      let entries: Dirent[]
      try {
        entries = await readdir(absDir, { withFileTypes: true })
      } catch {
        return []
      }
      const nodes: FileNode[] = []
      for (const entry of entries) {
        if (count > MAX_TREE_ENTRIES) break
        if (entry.name.startsWith('.') && entry.isDirectory()) continue
        if (IGNORED_DIRS.has(entry.name)) continue
        const abs = join(absDir, entry.name)
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          const children = await walk(abs, rel, depth + 1)
          nodes.push({
            name: entry.name,
            relativePath: rel,
            kind: 'directory',
            children,
            childCount: children.length
          })
          count += 1
        } else if (entry.isFile()) {
          const info = await stat(abs).catch(() => null)
          if (!info || info.size > MAX_FILE_BYTES) continue
          nodes.push({
            name: entry.name,
            relativePath: rel,
            kind: 'file',
            ext: extname(entry.name).replace('.', '').toLowerCase(),
            size: info.size,
            updatedAt: info.mtimeMs
          })
          count += 1
        }
      }
      nodes.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
      return nodes
    }

    const children = await walk(workspace.rootPath, '', 0)
    return {
      workspaceId: workspace.workspaceId,
      root: {
        name: workspace.name,
        relativePath: '',
        kind: 'directory',
        children,
        childCount: children.length
      },
      generatedAt: Date.now()
    }
  }

  /** 展平为 Agent 可用的文件清单（仅文本文件） */
  async listTextFiles(): Promise<Array<{ relativePath: string; name: string; size: number }>> {
    const tree = await this.tree()
    const result: Array<{ relativePath: string; name: string; size: number }> = []
    const walk = (node: FileNode): void => {
      if (node.kind === 'file') {
        if (TEXT_EXTENSIONS.has(`.${node.ext ?? ''}`)) {
          result.push({ relativePath: node.relativePath, name: node.name, size: node.size ?? 0 })
        }
        return
      }
      node.children?.forEach(walk)
    }
    walk(tree.root)
    return result
  }

  /** 在工作区路径约束下读取指定文本文件。 */
  async readText(relativePath: string): Promise<ReadTextResultLite> {
    const workspace = this.requireCurrent()
    const abs = await this.resolveExisting(relativePath)
    if (!isPathInside(workspace.rootPath, abs)) throw new AppError('OUT_OF_SCOPE')
    return readTextDocument(abs)
  }

  /** 在当前工作区新建文件并返回规范化的相对路径。 */
  async createFile(relativePath: string, content = ''): Promise<string> {
    const workspace = this.requireCurrent()
    const abs = resolveInside(workspace.rootPath, relativePath)
    await assertRealPathInside(workspace.rootPath, dirname(abs))
    if (!TEXT_EXTENSIONS.has(extname(abs).toLowerCase())) {
      throw new AppError('INVALID_INPUT', '只支持创建 Markdown 或纯文本文件。')
    }
    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppError('FILE_EXISTS', '同名文件已存在，请更换名称。')
      }
      throw new AppError('SAVE_FAILED', '创建文件失败。')
    }
    return toPosix(relative(workspace.rootPath, abs))
  }

  /** 读取工作区内的图片为 data URL，供文件树与编辑器预览使用 */
  async imagePreview(relativePath: string): Promise<ImagePreviewData> {
    const workspace = this.requireCurrent()
    const abs = await this.resolveExisting(relativePath)
    if (!isPathInside(workspace.rootPath, abs)) throw new AppError('OUT_OF_SCOPE', '图片不在工作区内。')
    const mime = IMAGE_MIME[extname(abs).toLowerCase()]
    if (!mime) throw new AppError('INVALID_INPUT', '不是支持的图片格式。')
    const info = await stat(abs)
    if (!info.isFile()) throw new AppError('FILE_NOT_FOUND', '图片不存在。')
    if (info.size > MAX_PREVIEW_BYTES) throw new AppError('INVALID_INPUT', '图片超过 24MB，无法预览。')
    const buffer = await readFile(abs)
    return {
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      name: basename(abs),
      mime,
      size: info.size
    }
  }

  /** 在当前工作区创建指定目录。 */
  async createFolder(relativePath: string): Promise<void> {
    const workspace = this.requireCurrent()
    const abs = resolveInside(workspace.rootPath, relativePath)
    await assertRealPathInside(workspace.rootPath, dirname(abs))
    await mkdir(abs, { recursive: true })
  }

  /** 在当前工作区内重命名或移动目标，并返回新的相对路径。 */
  async rename(from: string, to: string): Promise<FileOperationResult> {
    const workspace = this.requireCurrent()
    const absFrom = await this.resolveExisting(from)
    const absTo = resolveInside(workspace.rootPath, to)
    if (await pathExists(absTo)) throw new AppError('FILE_EXISTS', '目标名称已存在。')
    await assertRealPathInside(workspace.rootPath, dirname(absTo))
    try {
      await renameFs(absFrom, absTo)
    } catch (error) {
      throw new AppError('SAVE_FAILED', '重命名失败，目标文件可能被占用。', {
        details: error instanceof Error ? error.message : String(error)
      })
    }
    return { ok: true, relativePath: toPosix(relative(workspace.rootPath, absTo)) }
  }

  /**
   * 优先系统回收站；不可用时复制到应用恢复区再删除，绝不静默永久删除。
   */
  async remove(relativePath: string): Promise<FileOperationResult> {
    this.requireCurrent()
    const abs = await this.resolveExisting(relativePath)
    const info = await stat(abs)
    if (info.isDirectory()) {
      return this.removeDirectory(abs, relativePath)
    }
    try {
      await shell.trashItem(abs)
      return { ok: true, trashed: true }
    } catch (error) {
      logger.warn('workspace', '系统回收站不可用，改用应用恢复区', {
        message: error instanceof Error ? error.message : String(error)
      })
      const ticket = await this.copyToRecovery(abs, relativePath)
      await unlink(abs)
      return { ok: true, trashed: false, message: `已移入应用恢复区（${ticket}）` }
    }
  }

  private async removeDirectory(abs: string, relativePath: string): Promise<FileOperationResult> {
    try {
      await shell.trashItem(abs)
      return { ok: true, trashed: true }
    } catch {
      // 目录不递归复制，避免把大体积二进制写入恢复区
      await rmdir(abs).catch(() => undefined)
      if (await pathExists(abs)) {
        throw new AppError('SAVE_FAILED', '目录无法删除（可能非空或没有回收站可用）。')
      }
      return { ok: true, trashed: false, message: `已删除空目录 ${relativePath}` }
    }
  }

  private async copyToRecovery(abs: string, relativePath: string): Promise<string> {
    const ticket = newId('del')
    const dir = join(appPaths().recoveryDir, ticket)
    await mkdir(dir, { recursive: true })
    const target = join(dir, basename(abs))
    await copyFile(abs, target)
    const meta = {
      ticket,
      relativePath,
      originalName: basename(abs),
      deletedAt: Date.now(),
      contentPath: target
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
    return ticket
  }

  /** 恢复被 move 到恢复区的文件；目标存在则拒绝覆盖 */
  async restoreFromRecovery(ticket: string, relativePath?: string): Promise<string> {
    const workspace = this.requireCurrent()
    const dir = join(appPaths().recoveryDir, ticket)
    const metaRaw = await readFile(join(dir, 'meta.json'), 'utf8').catch(() => null)
    if (!metaRaw) throw new AppError('FILE_NOT_FOUND', '恢复记录不存在。')
    const meta = JSON.parse(metaRaw) as { relativePath: string; contentPath: string }
    const targetRel = relativePath ?? meta.relativePath
    const abs = resolveInside(workspace.rootPath, targetRel)
    if (await pathExists(abs)) throw new AppError('RECOVERY_CONFLICT', '原位置已有同名文件，请选择新的名称。')
    await mkdir(dirname(abs), { recursive: true })
    await copyFile(meta.contentPath, abs)
    return toPosix(relative(workspace.rootPath, abs))
  }

  /** 在当前工作区可搜索文本中查找匹配，返回有上限的行级结果。 */
  async search(query: string, limit = 40): Promise<WorkspaceSearchHit[]> {
    const trimmed = query.trim()
    if (!trimmed) return []
    const files = await this.listTextFiles()
    const hits: WorkspaceSearchHit[] = []
    const needle = trimmed.toLowerCase()
    for (const file of files.slice(0, MAX_SEARCH_FILES)) {
      if (hits.length >= limit) break
      if (file.size > MAX_SEARCH_BYTES) continue
      const abs = resolveInside(this.requireCurrent().rootPath, file.relativePath)
      const content = await readFile(abs, 'utf8').catch(() => null)
      if (!content) continue
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const index = lines[i].toLowerCase().indexOf(needle)
        if (index === -1) continue
        hits.push({
          relativePath: file.relativePath,
          title: file.relativePath.split('/').pop() ?? file.relativePath,
          line: i + 1,
          excerpt: lines[i].trim().slice(0, 180)
        })
        if (hits.length >= limit) break
      }
    }
    return hits
  }

  /** 在系统文件管理器中显示工作区内的指定条目。 */
  async reveal(relativePath: string): Promise<void> {
    const abs = await this.resolveExisting(relativePath)
    shell.showItemInFolder(abs)
  }

  /** 将工作区相对路径解析为已存在、仍属于工作区的绝对路径。 */
  async resolveExisting(relativePath: string): Promise<string> {
    const workspace = this.requireCurrent()
    const abs = resolveInside(workspace.rootPath, relativePath)
    if (!(await pathExists(abs))) throw new AppError('FILE_NOT_FOUND', `找不到文件：${relativePath}`)
    const real = await assertRealPathInside(workspace.rootPath, abs)
    return real
  }

  /** 判断打开中的文件是否被外部修改，供文档服务调用 */
  async currentDiskFingerprint(absPath: string): Promise<string | null> {
    const exists = await pathExists(absPath)
    if (!exists) return null
    const result = await readTextDocument(absPath).catch(() => null)
    return result?.fingerprint ?? null
  }

  private async startWatcher(root: string): Promise<void> {
    this.watcher = chokidar.watch(root, {
      ignored: (path: string) => {
        const name = basename(path)
        return IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.github')
      },
      ignoreInitial: true,
      depth: MAX_TREE_DEPTH,
      awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 60 }
    })
    const emit = (reason: WorkspaceChangeEvent['reason'], path: string): void => {
      if (!this.current) return
      const rel = toPosix(relative(this.current.rootPath, path))
      if (!rel || rel.startsWith('..')) return
      this.pendingReason = reason
      if (this.changeTimer) clearTimeout(this.changeTimer)
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null
        if (!this.current) return
        this.onChange?.({
          workspaceId: this.current.workspaceId,
          reason: this.pendingReason,
          relativePath: rel
        })
      }, 280)
    }
    this.watcher.on('add', (path) => emit('add', path))
    this.watcher.on('change', (path) => emit('change', path))
    this.watcher.on('unlink', (path) => emit('unlink', path))
    this.watcher.on('addDir', (path) => emit('addDir', path))
    this.watcher.on('unlinkDir', (path) => emit('unlinkDir', path))
    this.watcher.on('error', (error) => logger.warn('workspace', '文件监听异常', { message: String(error) }))
    this.onChange?.({ workspaceId: this.current?.workspaceId ?? '', reason: 'reset', relativePath: '' })
  }

  private async stopWatcher(): Promise<void> {
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null
    const watcher = this.watcher
    this.watcher = null
    if (watcher) await watcher.close().catch(() => undefined)
  }

  /** 应用退出时清理资源 */
  async dispose(): Promise<void> {
    await this.stopWatcher()
  }
}

interface ReadTextResultLite {
  text: string
  hasBom: boolean
  eol: 'lf' | 'crlf' | 'mixed'
  fingerprint: string
  size: number
}
