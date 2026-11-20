import { describe, expect, it } from 'vitest'
import { sanitizeCompletion } from '../../src/main/prediction/service'

describe('预测候选清理', () => {
  it('移除代码围栏与解释前缀', () => {
    expect(sanitizeCompletion('```markdown\n继续写下去。\n```', '')).toBe('继续写下去。')
    expect(sanitizeCompletion('续写：下一句话。', '')).toBe('下一句话。')
    expect(sanitizeCompletion('“引用样式”', '')).toBe('引用样式')
  })

  it('避免重复已有后文', () => {
    expect(sanitizeCompletion('这是下一句。这是后文开头。', '这是后文开头。')).toBe('这是下一句。')
  })

  it('限制候选长度，避免整段替换', () => {
    const long = '字'.repeat(900)
    expect(sanitizeCompletion(long, '').length).toBe(600)
    expect(sanitizeCompletion('   ', '')).toBe('')
  })
})
