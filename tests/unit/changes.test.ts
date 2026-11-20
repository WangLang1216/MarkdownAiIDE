import { describe, expect, it } from 'vitest'
import { applyEditsToText } from '@shared/markdown/edits'
import { buildDiff } from '@shared/diff'
import {
  assessRisk,
  assertNoOverlap,
  planOperation,
  type DocumentContext
} from '../../src/main/changes/engine'

const engineApply = applyEditsToText

const DOC = '# 说明\n\n开场。\n\n## 请求参数\n\n参数说明。\n'
const CONTEXT: DocumentContext = {
  documentId: 'doc_1',
  title: '说明.md',
  revision: 3,
  text: DOC,
  contentHash: 'hash-abc-123'
}

const guard = { documentId: 'doc_1', baseRevision: 3, expectedContentHash: 'hash-abc-123' }
const sectionId = 'sec-1'

describe('变更引擎', () => {
  it('在章节末尾插入表格，保留空行并落在下一个标题之前', () => {
    const planned = planOperation(
      {
        kind: 'insert_table',
        operationId: 'op_1',
        guard,
        anchor: { sectionId, position: 'section_end' },
        table: {
          columnCount: 2,
          totalRows: 2,
          header: [
            { text: '字段', status: 'recognized' },
            { text: '含义', status: 'recognized' }
          ],
          rows: [
            [
              { text: 'id', status: 'recognized' },
              { text: '主键', status: 'recognized' }
            ]
          ]
        }
      },
      CONTEXT
    )
    const result = engineApply(DOC, planned.edits)
    expect(result).toContain('| 字段 | 含义 |')
    expect(result).toContain('| id | 主键 |')
    // 插入位置应位于“参数说明”之后、文档末尾
    expect(result.indexOf('| 字段 |')).toBeGreaterThan(result.indexOf('参数说明'))
    expect(planned.targetLabel).toContain('请求参数')
  })

  it('插入表格时无法识别的单元格写入待核对', () => {
    const planned = planOperation(
      {
        kind: 'insert_table',
        operationId: 'op_2',
        guard,
        anchor: { sectionId, position: 'after_heading' },
        table: {
          columnCount: 1,
          totalRows: 2,
          header: [{ text: '值', status: 'recognized' }],
          rows: [[{ text: '', status: 'uncertain' }]]
        }
      },
      CONTEXT
    )
    const result = engineApply(DOC, planned.edits)
    expect(result).toContain('待核对')
    expect(planned.issues[0]?.code).toBe('IMAGE_UNCERTAIN')
  })

  it('版本或旧文本不一致时拒绝提案', () => {
    expect(() =>
      planOperation(
        {
          kind: 'replace_range',
          operationId: 'op_3',
          guard: { ...guard, baseRevision: 2 },
          from: 0,
          to: 3,
          expectedOldText: '# 说',
          newText: '# 新'
        },
        CONTEXT
      )
    ).toThrowError(/版本|修改/)

    expect(() =>
      planOperation(
        {
          kind: 'replace_range',
          operationId: 'op_4',
          guard,
          from: 0,
          to: 3,
          expectedOldText: '错误原文',
          newText: '# 新'
        },
        CONTEXT
      )
    ).toThrowError(/原文/)
  })

  it('替换范围可用于插入与删除，并按偏移降序应用', () => {
    const insert = planOperation(
      {
        kind: 'replace_range',
        operationId: 'op_5',
        guard,
        from: 2,
        to: 2,
        expectedOldText: '',
        newText: '补充'
      },
      CONTEXT
    )
    expect(engineApply(DOC, insert.edits)).toContain('补充')

    const edits = [
      { from: 0, to: 1, insert: 'A' },
      { from: 4, to: 6, insert: 'B' }
    ]
    expect(applyEditsToText('0123456789', edits)).toBe('A123B6789')
  })

  it('检测重叠范围，避免静默覆盖', () => {
    const first = planOperation(
      {
        kind: 'replace_range',
        operationId: 'a',
        guard,
        from: 0,
        to: 4,
        expectedOldText: '# 说明',
        newText: '# 新说明'
      },
      CONTEXT
    )
    const second = planOperation(
      {
        kind: 'replace_range',
        operationId: 'b',
        guard,
        from: 2,
        to: 6,
        expectedOldText: '说明\n\n',
        newText: '替换'
      },
      CONTEXT
    )
    expect(() => assertNoOverlap([first, second])).toThrowError(/重叠/)
  })

  it('风险分级：删除/创建为高风险，普通插入满足自动应用条件', () => {
    expect(
      assessRisk([
        {
          kind: 'insert_markdown',
          operationId: 'ok',
          guard,
          anchor: { sectionId, position: 'section_end' },
          markdown: '补充一句。'
        }
      ])
    ).toEqual({ risk: 'low', autoApplicable: true })

    expect(
      assessRisk([
        {
          kind: 'delete_document',
          operationId: 'del',
          guard,
          recovery: 'trash_or_recovery'
        }
      ]).risk
    ).toBe('high')
  })

  it('差异输出包含上下文与增删计数', () => {
    const diff = buildDiff('a\nb\n', 'a\nc\n')
    expect(diff.some((line) => line.type === 'del' && line.text === 'b')).toBe(true)
    expect(diff.some((line) => line.type === 'add' && line.text === 'c')).toBe(true)
    expect(diff.filter((line) => line.type === 'context').length).toBeGreaterThan(0)
  })
})
