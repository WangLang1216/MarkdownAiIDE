import { describe, expect, it } from 'vitest'
import { buildRecentItems, formatRecentTime, isRecentDraft, RECENT_DRAFT_TTL_MS } from '@shared/recent'
import type { FileNode } from '@shared/types'

const NOW = new Date('2026-11-26T10:00:00+08:00').getTime()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function file(relativePath: string, updatedAt: number, ext = 'md'): FileNode {
  return {
    name: relativePath.split('/').pop() ?? relativePath,
    relativePath,
    kind: 'file',
    ext,
    size: 128,
    updatedAt
  }
}

function directory(relativePath: string, children: FileNode[] = []): FileNode {
  return { name: relativePath, relativePath, kind: 'directory', children, childCount: children.length }
}

describe('buildRecentItems', () => {
  it('按最近编辑排序，并忽略目录与非文本文稿', () => {
    const items = buildRecentItems({
      files: [
        directory('产品设计'),
        file('README.md', NOW - 3 * DAY),
        file('产品设计/交互设计笔记.md', NOW - 2 * HOUR),
        file('产品设计/需求.markdown', NOW - 30 * MINUTE),
        file('assets/cover.png', NOW, 'png')
      ],
      drafts: [],
      now: NOW
    })

    expect(items.map((item) => item.relativePath)).toEqual([
      '产品设计/需求.markdown',
      '产品设计/交互设计笔记.md',
      'README.md'
    ])
    expect(items[0]).toMatchObject({
      key: 'file:产品设计/需求.markdown',
      kind: 'file',
      parent: '产品设计',
      unsaved: false,
      documentId: null
    })
    expect(items[2].parent).toBe('')
  })

  it('已打开标签的未落盘编辑比磁盘时间更新时参与排序', () => {
    const editedAtByPath = new Map([['README.md', NOW - MINUTE]])
    const items = buildRecentItems({
      files: [file('README.md', NOW - 5 * DAY), file('笔记.md', NOW - HOUR)],
      drafts: [],
      editedAtByPath,
      now: NOW
    })

    expect(items[0].relativePath).toBe('README.md')
    expect(items[0].editedAt).toBe(NOW - MINUTE)
  })

  it('同一路径的未保存草稿替换磁盘记录，只保留一行', () => {
    const items = buildRecentItems({
      files: [file('README.md', NOW - 4 * DAY)],
      drafts: [
        {
          documentId: 'doc_0000000000000001',
          title: 'README.md',
          relativePath: 'README.md',
          savedAt: NOW - HOUR
        }
      ],
      now: NOW
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: 'draft:doc_0000000000000001',
      kind: 'draft',
      documentId: 'doc_0000000000000001',
      unsaved: true,
      relativePath: 'README.md'
    })
    expect(items[0].editedAt).toBe(NOW - HOUR)
  })

  it('关闭超过三天的未保存草稿不再展示，三天内仍保留', () => {
    const items = buildRecentItems({
      files: [],
      drafts: [
        { documentId: 'doc_fresh', title: '刚关掉的.md', relativePath: null, savedAt: NOW - 2 * DAY },
        {
          documentId: 'doc_edge',
          title: '刚好三天.md',
          relativePath: null,
          savedAt: NOW - RECENT_DRAFT_TTL_MS
        },
        {
          documentId: 'doc_stale',
          title: '很久以前.md',
          relativePath: null,
          savedAt: NOW - RECENT_DRAFT_TTL_MS - 1000
        }
      ],
      now: NOW
    })

    expect(items.map((item) => item.documentId)).toEqual(['doc_fresh', 'doc_edge'])
    expect(items[0].parent).toBe('')
  })

  it('先排序再截断，保留最新的若干条', () => {
    const files = Array.from({ length: 6 }, (_, index) => file(`第${index}篇.md`, NOW - index * HOUR))
    const items = buildRecentItems({ files, drafts: [], now: NOW, limit: 3 })

    expect(items).toHaveLength(3)
    expect(items.map((item) => item.title)).toEqual(['第0篇.md', '第1篇.md', '第2篇.md'])
  })
})

describe('isRecentDraft', () => {
  it('边界为满三天，超过即过期', () => {
    expect(isRecentDraft(NOW - RECENT_DRAFT_TTL_MS, NOW)).toBe(true)
    expect(isRecentDraft(NOW - RECENT_DRAFT_TTL_MS - 1, NOW)).toBe(false)
  })

  it('无效时间戳按过期处理', () => {
    expect(isRecentDraft(0, NOW)).toBe(false)
    expect(isRecentDraft(Number.NaN, NOW)).toBe(false)
  })
})

describe('formatRecentTime', () => {
  it('按间隔给出短标签', () => {
    expect(formatRecentTime(NOW - 20 * 1000, NOW)).toBe('刚刚')
    expect(formatRecentTime(NOW - 12 * MINUTE, NOW)).toBe('12 分钟前')
    expect(formatRecentTime(NOW - 5 * HOUR, NOW)).toBe('5 小时前')
    expect(formatRecentTime(NOW - 30 * HOUR, NOW)).toBe('昨天')
    expect(formatRecentTime(NOW - 3 * DAY, NOW)).toBe('3 天前')
  })

  it('超过一周显示日期，跨年补全年份', () => {
    const timestamp = new Date('2026-11-10T09:00:00+08:00').getTime()
    expect(formatRecentTime(timestamp, NOW)).toBe('11月10日')
    const lastYear = new Date('2025-12-31T09:00:00+08:00').getTime()
    expect(formatRecentTime(lastYear, NOW)).toBe('2025/12/31')
  })

  it('空时间戳返回空串', () => {
    expect(formatRecentTime(0, NOW)).toBe('')
  })
})
