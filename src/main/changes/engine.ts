/**
 * 变更引擎：把语义操作转换为精确的局部文本编辑。
 * 插入点由章节解析与文档结构计算，模型的 offset 从不被直接信任。
 */

import { AppError } from '@shared/errors'
import { countUncertainCells, renderTable } from '@shared/markdown/table'
import { parseSections, resolveAnchorOffset } from '@shared/markdown/outline'
import type { ChangeOperation, ProposalIssue, TargetAnchor } from '@shared/types'
import type { TextEdit } from '@shared/markdown/edits'

/** 为纯变更规划提供目标文稿正文及版本基线。 */
export interface DocumentContext {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 当前文稿的修订号；用于识别基于旧内容的请求。 */
  revision: number
  /** 当前记录承载的文本内容。 */
  text: string
  /** 当前 LF 正文的哈希，用来断言内容是否仍与规划基线一致。 */
  contentHash: string
}

/** 保存已定位的源码编辑、原始操作和审阅所需信息。 */
export interface PlannedOperation {
  /** 待执行计划对应的原始结构化操作。 */
  operation: ChangeOperation
  /** 以规划时正文为基准的具体区间编辑。 */
  edits: TextEdit[]
  /** 插入/替换后的目标描述，用于 Review */
  targetLabel: string
  /** 可用于审阅预览与摘要的插入内容。 */
  insertedMarkdown: string
  /** 规划或校验得到的错误与警告列表。 */
  issues: ProposalIssue[]
}

function assertGuard(operation: ChangeOperation & { guard?: unknown }, context: DocumentContext): void {
  const guard = (
    operation as { guard: { documentId: string; baseRevision: number; expectedContentHash: string } }
  ).guard
  if (!guard) return
  if (guard.documentId !== context.documentId) {
    throw new AppError('INVALID_PROPOSAL', '提案目标文档与读取的快照不一致。')
  }
  if (guard.baseRevision !== context.revision || guard.expectedContentHash !== context.contentHash) {
    throw new AppError('REVISION_CONFLICT', '文档在提案生成后已被修改，请重新读取并生成提案。')
  }
}

/** 计算插入文本，保证前后空行符合 Markdown 段落分隔 */
function buildInsertion(text: string, offset: number, block: string): string {
  const body = block.replace(/^\n+/, '').replace(/\n+$/, '')
  if (!body) throw new AppError('INVALID_PROPOSAL', '插入内容为空。')
  const before = text.slice(0, offset)
  const after = text.slice(offset)
  const lead = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  let trail: string
  if (after.length === 0) trail = '\n'
  else if (after.startsWith('\n\n')) trail = ''
  else if (after.startsWith('\n')) trail = '\n'
  else trail = '\n\n'
  return `${lead}${body}${trail}`
}

function describeAnchor(text: string, anchor: TargetAnchor): string {
  if (anchor.position === 'document_end') return '文档末尾'
  const sections = parseSections(text)
  const section = sections.find((item) => item.sectionId === anchor.sectionId)
  const path = section ? [...section.headingPath].join(' › ') : '未知章节'
  return `${path} · ${anchor.position === 'after_heading' ? '标题后' : '章节末尾'}`
}

/** 规划单个文档操作；create/delete 的副作用由执行器处理 */
export function planOperation(operation: ChangeOperation, context: DocumentContext): PlannedOperation {
  if (operation.kind === 'create_document' || operation.kind === 'delete_document') {
    return {
      operation,
      edits: [],
      targetLabel: operation.kind === 'create_document' ? '新建文档' : '删除文档',
      insertedMarkdown: '',
      issues: []
    }
  }

  assertGuard(operation, context)
  const sections = parseSections(context.text)
  const issues: ProposalIssue[] = []

  if (operation.kind === 'insert_table') {
    const { offset } = resolveAnchorOffset(context.text, sections, operation.anchor)
    const table = renderTable(operation.table)
    const uncertain = countUncertainCells(operation.table)
    if (uncertain > 0) {
      issues.push({
        operationId: operation.operationId,
        code: 'IMAGE_UNCERTAIN',
        message: `表格中有 ${uncertain} 个单元格标记为「待核对」，应用后请人工确认。`,
        severity: 'warning'
      })
    }
    const block = operation.caption ? `${operation.caption}\n\n${table}` : table
    const insert = buildInsertion(context.text, offset, block)
    return {
      operation,
      edits: [{ from: offset, to: offset, insert }],
      targetLabel: describeAnchor(context.text, operation.anchor),
      insertedMarkdown: block,
      issues
    }
  }

  if (operation.kind === 'insert_markdown') {
    const { offset } = resolveAnchorOffset(context.text, sections, operation.anchor)
    const insert = buildInsertion(context.text, offset, operation.markdown)
    return {
      operation,
      edits: [{ from: offset, to: offset, insert }],
      targetLabel: describeAnchor(context.text, operation.anchor),
      insertedMarkdown: operation.markdown,
      issues
    }
  }

  // replace_range：严格校验版本、范围与旧文本
  const { from, to, expectedOldText, newText } = operation
  if (from > to || to > context.text.length) {
    throw new AppError('INVALID_PROPOSAL', '替换范围超出文档边界。')
  }
  const actual = context.text.slice(from, to)
  if (actual !== expectedOldText) {
    throw new AppError('REVISION_CONFLICT', '待替换的原文与当前文档不一致，提案已失效。')
  }
  if (!newText && !expectedOldText) {
    throw new AppError('INVALID_PROPOSAL', '替换操作没有实际变化。')
  }
  return {
    operation,
    edits: [{ from, to, insert: newText }],
    targetLabel: `位置 ${from}–${to}`,
    insertedMarkdown: newText,
    issues
  }
}

/** 同一文档内的编辑不得重叠；同一插入点也存在顺序歧义，直接拒绝 */
export function assertNoOverlap(planned: PlannedOperation[]): void {
  const edits = planned.flatMap((item) => item.edits)
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    if (curr.from < prev.to || (curr.from === prev.from && curr.to === prev.to)) {
      throw new AppError('INVALID_PROPOSAL', '提案中的多个操作范围重叠，请拆分为独立提案。')
    }
  }
}

/** 评估风险与是否满足当前文档低风险自动应用条件 */
export function assessRisk(operations: ChangeOperation[]): { risk: 'low' | 'high'; autoApplicable: boolean } {
  const kinds = new Set(operations.map((operation) => operation.kind))
  const documentIds = new Set(
    operations
      .map((operation) => ('guard' in operation ? operation.guard.documentId : null))
      .filter((value): value is string => Boolean(value))
  )
  const hasStructural = kinds.has('create_document') || kinds.has('delete_document')
  const hasUncertain = operations.some(
    (operation) =>
      operation.kind === 'insert_table' &&
      [...operation.table.header, ...operation.table.rows.flat()].some((cell) => cell.status === 'uncertain')
  )
  const risk: 'low' | 'high' = hasStructural || documentIds.size > 1 ? 'high' : 'low'
  const autoApplicable = risk === 'low' && documentIds.size <= 1 && !hasUncertain
  return { risk, autoApplicable }
}

/** 判断编辑是否超过辅助审批允许的行数、字符数或正文改写比例。 */
export function isLargeEdit(before: string, edits: TextEdit[], changedLines: number): boolean {
  if (changedLines >= 20) return true
  let changedCharacters = 0
  let removedCharacters = 0
  for (const edit of edits) {
    const removed = before.slice(edit.from, edit.to)
    const inserted = edit.insert
    let head = 0
    let removedEnd = removed.length
    let insertedEnd = inserted.length
    while (head < removedEnd && head < insertedEnd && removed[head] === inserted[head]) head++
    while (removedEnd > head && insertedEnd > head && removed[removedEnd - 1] === inserted[insertedEnd - 1]) {
      removedEnd--
      insertedEnd--
    }
    changedCharacters += Math.max(removedEnd, insertedEnd) - head
    removedCharacters += removedEnd - head
    if (changedCharacters >= 1200) return true
  }
  return before.length >= 200 && removedCharacters >= before.length / 2
}

/** 生成插入内容的纯文本摘要，用于任务面板提示 */
export function summarizeInsertion(markdown: string, maxLength = 90): string {
  const firstLine =
    markdown
      .split('\n')
      .map((line) => line.replace(/^[#>\-\s]+/, '').trim())
      .find((line) => line.length > 0) ?? ''
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine
}
