/**
 * GFM 表格构造与校验。
 * 形状由代码保证：totalRows 含表头、不含分隔行，且必须等于 rows.length + 1。
 */

import { AppError } from '../errors'
import type { TableCell, TablePayload } from '../types'

/** 单元格文本转义：竖线、换行与多余空白 */
export function escapeCell(text: string): string {
  const normalized = (text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return ''
  return normalized
    .split('\n')
    .map((line) => line.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim())
    .join('<br>')
}

/** 未识别内容必须显式标注，禁止伪造数值 */
function renderCell(cell: TableCell): string {
  const escaped = escapeCell(cell.text)
  if (escaped) return escaped
  if (cell.status === 'uncertain') return '待核对'
  return ''
}

/** 检验声明尺寸与实际表格形状一致；不一致时抛出应用错误。 */
export function assertValidTable(table: TablePayload): void {
  const { columnCount, totalRows, header, rows } = table
  if (!Number.isInteger(columnCount) || columnCount < 1) {
    throw new AppError('INVALID_PROPOSAL', '表格列数必须为正整数。')
  }
  if (!Number.isInteger(totalRows) || totalRows < 1) {
    throw new AppError('INVALID_PROPOSAL', '表格总行数必须为正整数（含表头）。')
  }
  if (totalRows !== rows.length + 1) {
    throw new AppError(
      'INVALID_PROPOSAL',
      `表格总行数 ${totalRows} 与数据行数 ${rows.length} 不一致（总行数含表头）。`
    )
  }
  if (header.length !== columnCount) {
    throw new AppError('INVALID_PROPOSAL', `表头列数为 ${header.length}，与声明的 ${columnCount} 列不一致。`)
  }
  rows.forEach((row, index) => {
    if (row.length !== columnCount) {
      throw new AppError(
        'INVALID_PROPOSAL',
        `第 ${index + 1} 行数据列数为 ${row.length}，与声明的 ${columnCount} 列不一致。`
      )
    }
  })
}

/** 生成标准 GFM 表格文本（不带首尾空行） */
export function renderTable(table: TablePayload): string {
  assertValidTable(table)
  const header = table.header.map(renderCell)
  const divider = Array.from({ length: table.columnCount }, () => '---')
  const body = table.rows.map((row) => row.map(renderCell))
  return [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n')
}

/** 将多余列截断、缺少列补齐，保证输出合法；仅用于模型返回数据的宽容归一化 */
export function normalizeTableCells(cells: TableCell[], columnCount: number): TableCell[] {
  const result = cells.slice(0, columnCount)
  while (result.length < columnCount) result.push({ text: '', status: 'empty' })
  return result
}

/** 统计待核对单元格数量，用于 Review 提示 */
export function countUncertainCells(table: TablePayload): number {
  const all = [...table.header, ...table.rows.flat()]
  return all.filter((cell) => cell.status === 'uncertain' || (!cell.text.trim() && cell.status !== 'empty'))
    .length
}

/* ------------------------------------------------------------------ */
/* 可视表格编辑器                                                      */
/* ------------------------------------------------------------------ */

/** 表格列对齐方式，与 GFM 分隔行的三种写法一一对应。 */
export type TableAlign = 'left' | 'center' | 'right'

/** 对齐方式对应的分隔行单元格；左对齐用不带冒号的 `---`，与既有表格保持一致。 */
export function tableAlignMarker(align: TableAlign): string {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  return '---'
}

/**
 * 把可视表格编辑器里的表头、数据行写回 GFM 表格。
 * 列数以表头为准：多余单元格截断、缺少补齐，保证写回后形状合法。
 */
export function serializeTable(header: string[], rows: string[][], aligns: TableAlign[] = []): string {
  const columns = Math.max(1, header.length)
  const normalize = (cells: string[]): string[] => {
    const next = cells.slice(0, columns).map(escapeCell)
    while (next.length < columns) next.push('')
    return next
  }
  const head = normalize(header)
  const divider = Array.from({ length: columns }, (_, index) => tableAlignMarker(aligns[index] ?? 'left'))
  return [
    `| ${head.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...rows.map((row) => `| ${normalize(row).join(' | ')} |`)
  ].join('\n')
}
