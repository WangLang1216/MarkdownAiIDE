import { describe, expect, it } from 'vitest'
import { applyEditsToText } from '@shared/markdown/edits'
import { buildDiff } from '@shared/diff'
import {
  assessRisk,
  assertNoOverlap,
  isLargeEdit,
  planOperation,
  type DocumentContext
} from '../../src/main/changes/engine'

import { resolveAgentScope } from '@shared/agentScope'
import { shouldAutoApply } from '../../src/main/agent/approval'
import type { ReviewFile } from '@shared/types'

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

describe('AI 修改审批', () => {
  it('自动范围按权限启用工作区，同时尊重用户明确选择的范围', () => {
    expect(resolveAgentScope('auto', 'ask', true)).toBe('document')
    expect(resolveAgentScope('auto', 'assisted', true)).toBe('workspace')
    expect(resolveAgentScope('auto', 'full_access', true)).toBe('workspace')
    expect(resolveAgentScope('auto', 'full_access', false)).toBe('document')
    expect(resolveAgentScope('document', 'full_access', true)).toBe('document')
    expect(resolveAgentScope('selection', 'assisted', true)).toBe('selection')
    expect(resolveAgentScope('workspace', 'ask', true)).toBe('workspace')
  })

  const file: ReviewFile = {
    key: 'doc_1', title: '说明.md', relativePath: '说明.md', documentId: 'doc_1',
    kind: 'replace_range', summary: '', additions: 1, deletions: 0, diff: [], issues: []
  }
  const small = { autoApplicable: true, files: [file] }
  const important = { autoApplicable: false, files: [file] }

  it('请求批准要求手动确认所有修改', () => {
    expect(shouldAutoApply('ask', small, 'doc_1')).toBe(false)
    expect(shouldAutoApply('ask', important, 'doc_1')).toBe(false)
  })

  it('帮我批准只自动应用当前文档的小幅低风险修改', () => {
    expect(shouldAutoApply('assisted', small, 'doc_1')).toBe(true)
    expect(shouldAutoApply('assisted', important, 'doc_1')).toBe(false)
    expect(shouldAutoApply('assisted', small, 'doc_2')).toBe(false)
    expect(shouldAutoApply('assisted', small, null)).toBe(false)
  })

  it('完全访问不因修改规模或结构风险进入审批', () => {
    expect(shouldAutoApply('full_access', important, null)).toBe(true)
  })

  it('识别大范围增删，同时忽略替换内容中保留的前缀和后缀', () => {
    const before = '甲'.repeat(1500) + '旧' + '乙'.repeat(1500)
    expect(isLargeEdit(before, [{ from: 0, to: before.length, insert: before.replace('旧', '新') }], 1)).toBe(false)
    expect(isLargeEdit('', [{ from: 0, to: 0, insert: '甲'.repeat(1200) }], 1)).toBe(true)
    expect(isLargeEdit('', [{ from: 0, to: 0, insert: '甲\\n'.repeat(20) }], 20)).toBe(true)
    expect(isLargeEdit(before, [{ from: 0, to: 800, insert: '' }, { from: 900, to: 1700, insert: '' }], 1)).toBe(true)
    expect(isLargeEdit('甲'.repeat(300), [{ from: 0, to: 151, insert: '' }], 1)).toBe(true)
  })
})
