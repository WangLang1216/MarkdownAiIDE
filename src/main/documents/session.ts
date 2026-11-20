/**
 * 文档会话：内存文本 + 单调递增 revision + 磁盘指纹。
 * Renderer 是交互编辑的拥有者，Main 是跨窗口、文件与 Agent 的协调者。
 */

import { basename } from 'node:path'
import type { DocumentSnapshot, EolStyle } from '@shared/types'
import { detectEol, normalizeToLf, sha256, toPosix } from '../utils/fs'

/** 初始化单个文稿会话的身份、路径、正文及磁盘基线。 */
export interface SessionInit {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId: string | null
  /** 主进程内部使用的磁盘绝对路径；未关联磁盘文件时为 null。 */
  absPath: string | null
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string | null
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 当前记录承载的文本内容。 */
  text: string
  /** 保存时用于恢复磁盘换行风格的标志。 */
  eol: EolStyle
  /** 标记原始文本是否带 UTF-8 BOM，以便保存时保留。 */
  hasBom: boolean
  /** 最近接受的磁盘原始字节指纹；与 LF 正文哈希不同。 */
  diskFingerprint: string | null
  /** 指示会话是否对应一个已存在于磁盘的文件。 */
  existsOnDisk: boolean
  /** 指示会话是否附加到渲染端标签，而不是仅在主进程后台打开。 */
  attached: boolean
}

/** 表示主进程内单个文稿的可变工作副本，维护当前修订和最近保存基线。 */
export class DocumentSession {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  readonly documentId: string
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId: string | null
  /** 主进程内部使用的磁盘绝对路径；未关联磁盘文件时为 null。 */
  absPath: string | null
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string | null
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 当前内存工作副本的 LF 归一化正文。 */
  text: string
  /** 保存时用于恢复磁盘换行风格的标志。 */
  eol: EolStyle
  /** 标记原始文本是否带 UTF-8 BOM，以便保存时保留。 */
  hasBom: boolean
  /** 最近接受的磁盘原始字节指纹；与 LF 正文哈希不同。 */
  diskFingerprint: string | null
  /** 指示会话是否对应一个已存在于磁盘的文件。 */
  existsOnDisk: boolean
  /** 指示会话是否附加到渲染端标签，而不是仅在主进程后台打开。 */
  attached: boolean
  /** 会话的单调递增修订号，初始值为 1。 */
  revision = 1
  /** 当前 LF 正文的哈希，用来断言内容是否仍与规划基线一致。 */
  contentHash: string
  /** 上次保存或重载时的 LF 正文哈希，与当前哈希比较以判断是否有未保存变更。 */
  lastSavedHash: string
  /** 打开时间的 Unix 毫秒时间戳。 */
  openedAt = Date.now()
  /** 指示当前正文是否有尚未保存的变更。 */
  dirty = false

  /** 归一化初始正文，建立修订、内容哈希及未保存状态的基线。 */
  constructor(init: SessionInit) {
    this.documentId = init.documentId
    this.workspaceId = init.workspaceId
    this.absPath = init.absPath
    this.relativePath = init.relativePath
    this.title = init.title
    this.text = normalizeToLf(init.text)
    this.eol = init.eol || detectEol(init.text)
    this.hasBom = init.hasBom
    this.diskFingerprint = init.diskFingerprint
    this.existsOnDisk = init.existsOnDisk
    this.attached = init.attached
    this.contentHash = sha256(this.text)
    this.lastSavedHash = init.existsOnDisk ? this.contentHash : ''
    this.dirty = !init.existsOnDisk && this.text.length > 0
  }

  /** 应用新的完整文本，返回是否产生实际变化 */
  applyText(text: string, options: { markSaved?: boolean } = {}): boolean {
    const normalized = normalizeToLf(text)
    if (normalized === this.text) {
      this.dirty = this.contentHash !== this.lastSavedHash
      return false
    }
    this.text = normalized
    this.contentHash = sha256(normalized)
    this.revision += 1
    if (options.markSaved) this.lastSavedHash = this.contentHash
    this.dirty = this.contentHash !== this.lastSavedHash
    return true
  }

  /** 用成功写入的字节指纹更新磁盘与已保存正文基线。 */
  markSaved(bufferFingerprint: string): void {
    this.diskFingerprint = bufferFingerprint
    this.existsOnDisk = true
    this.lastSavedHash = this.contentHash
    this.dirty = false
  }

  /** 以磁盘读取结果替换内存正文及保存基线，并推进修订号。 */
  markReloaded(init: { text: string; eol: EolStyle; hasBom: boolean; fingerprint: string | null }): void {
    this.text = normalizeToLf(init.text)
    this.contentHash = sha256(this.text)
    this.lastSavedHash = this.contentHash
    this.eol = init.eol
    this.hasBom = init.hasBom
    this.diskFingerprint = init.fingerprint
    this.existsOnDisk = init.fingerprint !== null
    this.dirty = false
    this.revision += 1
  }

  /** 生成不暴露绝对路径的可序列化文稿快照。 */
  snapshot(): DocumentSnapshot {
    return {
      documentId: this.documentId,
      workspaceId: this.workspaceId,
      relativePath: this.relativePath,
      title: this.title,
      revision: this.revision,
      text: this.text,
      contentHash: this.contentHash,
      dirty: this.dirty,
      diskFingerprint: this.diskFingerprint,
      eol: this.eol,
      hasBom: this.hasBom,
      existsOnDisk: this.existsOnDisk,
      attached: this.attached
    }
  }

  /** 工作区根目录变更后同步相对路径与标题 */
  relocate(absPath: string, relativePath: string | null, workspaceId: string | null): void {
    this.absPath = absPath
    this.relativePath = relativePath ? toPosix(relativePath) : null
    this.workspaceId = workspaceId
    this.title = basename(absPath)
    this.revision += 1
  }
}
