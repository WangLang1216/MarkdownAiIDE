import { describe, expect, it } from 'vitest'
import {
  assertValidTable,
  countUncertainCells,
  escapeCell,
  normalizeTableCells,
  renderTable,
  serializeTable,
  tableAlignMarker
} from '@shared/markdown/table'

const baseTable = {
  columnCount: 2,
  totalRows: 4,
  header: [
    { text: '项目', status: 'recognized' as const },
    { text: '说明', status: 'recognized' as const }
  ],
  rows: [
    [
      { text: 'A', status: 'recognized' as const },
      { text: 'a', status: 'recognized' as const }
    ],
    [
      { text: 'B', status: 'recognized' as const },
      { text: '', status: 'uncertain' as const }
    ],
    [
      { text: 'C', status: 'recognized' as const },
      { text: '', status: 'empty' as const }
    ]
  ]
}

describe('GFM 表格生成与校验', () => {
  it('生成含表头的 4×2 标准表格', () => {
    const md = renderTable(baseTable)
    const lines = md.split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('| 项目 | 说明 |')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines[4]).toBe('| C |  |')
  })

  it('totalRows 必须等于 rows.length + 1', () => {
    expect(() => assertValidTable({ ...baseTable, totalRows: 3 })).toThrowError(/总行数/)
    expect(() => assertValidTable({ ...baseTable, totalRows: 5 })).toThrowError(/总行数/)
  })

  it('列数不一致时拒绝，不静默截断模型数据', () => {
    expect(() =>
      assertValidTable({ ...baseTable, header: [{ text: '只有一列', status: 'recognized' }] })
    ).toThrowError(/表头列数/)
    expect(() =>
      assertValidTable({
        ...baseTable,
        rows: [[{ text: 'A', status: 'recognized' }], ...baseTable.rows.slice(1)]
      })
    ).toThrowError(/列数/)
  })

  it('竖线与换行被安全转义', () => {
    expect(escapeCell('a | b')).toBe('a \\| b')
    expect(escapeCell('第一行\n第二行')).toBe('第一行<br>第二行')
    expect(escapeCell('  ')).toBe('')
  })

  it('待核对单元格不会被伪造为空值', () => {
    const md = renderTable(baseTable)
    expect(md).toContain('待核对')
    expect(countUncertainCells(baseTable)).toBe(1)
  })

  it('宽容归一化只用于补齐声明列数', () => {
    const cells = normalizeTableCells([{ text: '唯一', status: 'recognized' }], 3)
    expect(cells).toHaveLength(3)
    expect(cells[1].status).toBe('empty')
  })
})

/** 可视表格编辑器把单元格写回 GFM，形状和转义必须和源码手写一致。 */
describe('可视表格回写', () => {
  it('按对齐方式生成分隔行', () => {
    expect(tableAlignMarker('left')).toBe('---')
    expect(tableAlignMarker('center')).toBe(':---:')
    expect(tableAlignMarker('right')).toBe('---:')
  })

  it('重建标准表格并保留对齐', () => {
    const md = serializeTable(
      ['项目', '说明'],
      [
        ['A', 'a'],
        ['B', 'b']
      ],
      ['left', 'center']
    )
    expect(md.split('\n')).toEqual(['| 项目 | 说明 |', '| --- | :---: |', '| A | a |', '| B | b |'])
  })

  it('竖线与换行按单元格规则转义', () => {
    const md = serializeTable(['列'], [['a | b'], ['第一行\n第二行']], ['left'])
    expect(md).toContain('| a \\| b |')
    expect(md).toContain('| 第一行<br>第二行 |')
  })

  it('列数以表头为准，缺列补齐、多列截断', () => {
    const md = serializeTable(['A', 'B', 'C'], [['1'], ['1', '2', '3', '4']], [])
    expect(md.split('\n')[2]).toBe('| 1 |  |  |')
    expect(md.split('\n')[3]).toBe('| 1 | 2 | 3 |')
  })

  it('只剩表头时也输出合法表格', () => {
    const md = serializeTable(['唯一列'], [], ['right'])
    expect(md).toBe('| 唯一列 |\n| ---: |')
  })

  it('空表头按一列处理，避免写出无法解析的空表', () => {
    const md = serializeTable([], [['内容']], [])
    expect(md).toBe('|  |\n| --- |\n| 内容 |')
  })
})
