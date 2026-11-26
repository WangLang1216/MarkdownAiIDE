/**
 * 「最近」列表的共享规则：合并工作区文稿与关闭后未保存的草稿，
 * 按最近一次编辑时间排序。主进程与渲染进程共用这里的有效期判断。
 */

import type { FileNode } from './types'

/** 关闭后未保存的草稿在「最近」中的保留时长：三天。 */
export const RECENT_DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000

/** 「最近」中单条记录。 */
export interface RecentItem {
  /** 列表键：同一路径的磁盘文稿与草稿会合并为一条。 */
  key: string
  /** 磁盘上已保存的文稿，或关闭后仍未保存的草稿。 */
  kind: 'file' | 'draft'
  /** 供列表显示的标题。 */
  title: string
  /** 相对工作区的父目录；位于根目录或草稿未关联目录时为空串。 */
  parent: string
  /** 相对于工作区根目录的路径；未落盘的草稿可能为空。 */
  relativePath: string | null
  /** 草稿对应的文稿会话标识；磁盘文稿为 null。 */
  documentId: string | null
  /** 最近一次编辑（或保存）的 Unix 毫秒时间戳。 */
  editedAt: number
  /** 是否存在尚未写盘的修改。 */
  unsaved: boolean
}

/** 参与「最近」排序的草稿元信息，结构上与恢复中心条目一致。 */
export interface RecentDraft {
  documentId: string
  title: string
  relativePath: string | null
  /** 最近一次写入草稿（即最近一次编辑）的 Unix 毫秒时间戳。 */
  savedAt: number
}

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt'])
const DEFAULT_LIMIT = 40

/**
 * 判断一份未保存草稿是否仍在「最近」的有效期内。
 * 时间戳缺失或明显异常时按过期处理，避免脏数据长期占据列表。
 */
export function isRecentDraft(savedAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return false
  return now - savedAt <= RECENT_DRAFT_TTL_MS
}

/**
 * 构建「最近」列表：工作区文本文稿按磁盘修改时间排序，
 * 关闭后未保存的草稿以草稿写入时间参与同一次排序。
 */
export function buildRecentItems(input: {
  /** 工作区内的全部文件节点（可含目录，内部会忽略）。 */
  files: FileNode[]
  /** 关闭后仍未保存的草稿。 */
  drafts: RecentDraft[]
  /** 已打开标签的最近真实编辑时间，按工作区相对路径索引。 */
  editedAtByPath?: Map<string, number>
  now?: number
  limit?: number
}): RecentItem[] {
  const now = input.now ?? Date.now()
  const limit = input.limit ?? DEFAULT_LIMIT
  const items = new Map<string, RecentItem>()

  for (const file of input.files) {
    if (file.kind !== 'file' || !TEXT_EXTENSIONS.has(file.ext ?? '')) continue
    items.set(file.relativePath, {
      key: `file:${file.relativePath}`,
      kind: 'file',
      title: file.name,
      parent: parentOf(file.relativePath),
      relativePath: file.relativePath,
      documentId: null,
      // 标签里尚未落盘的编辑比磁盘时间更新，取两者较晚的一个
      editedAt: Math.max(file.updatedAt ?? 0, input.editedAtByPath?.get(file.relativePath) ?? 0),
      unsaved: false
    })
  }

  for (const draft of input.drafts) {
    if (!isRecentDraft(draft.savedAt, now)) continue
    const existing = draft.relativePath ? items.get(draft.relativePath) : undefined
    if (existing) {
      // 同一路径既有磁盘文件又有未保存草稿：合成一行，展示更新的草稿内容
      existing.kind = 'draft'
      existing.key = `draft:${draft.documentId}`
      existing.documentId = draft.documentId
      existing.unsaved = true
      existing.editedAt = Math.max(existing.editedAt, draft.savedAt)
      if (draft.title) existing.title = draft.title
      continue
    }
    const key = `draft:${draft.documentId}`
    if (items.has(key)) continue
    items.set(key, {
      key,
      kind: 'draft',
      title: draft.title,
      parent: draft.relativePath ? parentOf(draft.relativePath) : '',
      relativePath: draft.relativePath,
      documentId: draft.documentId,
      editedAt: draft.savedAt,
      unsaved: true
    })
  }

  return [...items.values()]
    .sort((a, b) => b.editedAt - a.editedAt || a.title.localeCompare(b.title, 'zh-Hans-CN'))
    .slice(0, limit)
}

/** 把时间戳格式化为「刚刚 / 12 分钟前 / 昨天 / 11月20日」等短标签。 */
export function formatRecentTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const diff = now - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 2 * 86_400_000) return '昨天'
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(timestamp)
  const month = date.getMonth() + 1
  const day = date.getDate()
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${month}月${day}日`
    : `${date.getFullYear()}/${month}/${day}`
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index === -1 ? '' : relativePath.slice(0, index)
}
