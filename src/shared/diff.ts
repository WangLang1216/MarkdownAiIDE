/**
 * 行级差异：供审阅界面与导出共用，限制上下文行数避免超长文档刷屏。
 */

import { diffLines } from 'diff'
import type { DiffLine } from './types'

const MAX_DIFF_LINES = 600

/** 将新旧正文转换为带两侧行号的审阅差异，并按行数上限裁剪。 */
export function buildDiff(before: string, after: string, maxLines = MAX_DIFF_LINES): DiffLine[] {
  const parts = diffLines(before, after)
  const lines: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  for (const part of parts) {
    const content = part.value.replace(/\n$/, '')
    if (content === '') continue
    for (const row of content.split('\n')) {
      if (part.added) {
        lines.push({ type: 'add', text: row, oldNo: null, newNo })
        newNo += 1
      } else if (part.removed) {
        lines.push({ type: 'del', text: row, oldNo, newNo: null })
        oldNo += 1
      } else {
        lines.push({ type: 'context', text: row, oldNo, newNo })
        oldNo += 1
        newNo += 1
      }
    }
  }
  return trimDiff(lines, maxLines)
}

function trimDiff(lines: DiffLine[], maxLines: number): DiffLine[] {
  if (lines.length <= maxLines) return lines
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.type === 'context') return
    for (let offset = -3; offset <= 3; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < lines.length) keep.add(target)
    }
  })
  const result: DiffLine[] = []
  let last = -2
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index - last > 1) result.push({ type: 'context', text: '⋯', oldNo: null, newNo: null })
    result.push(lines[index])
    last = index
    if (result.length > maxLines) break
  }
  return result
}
