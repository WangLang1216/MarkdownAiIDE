import { describe, expect, it } from 'vitest'
import { splitParagraphs } from '@shared/markdown/paragraphs'

describe('splitParagraphs', () => {
  it('按回车拆段：连续三行得到三个段落', () => {
    expect(
      splitParagraphs('多事件连贯\n语言事件提示（如是否进入景中景、切换地图）\n事件优先级')
    ).toEqual(['多事件连贯', '语言事件提示（如是否进入景中景、切换地图）', '事件优先级'])
  })

  it('段落内部没有回车时不拆开（自动折行仍算一段）', () => {
    expect(splitParagraphs('很长的一段话，渲染时被编辑器折成了好几行显示，但源码里只有一个回车')).toEqual([
      '很长的一段话，渲染时被编辑器折成了好几行显示，但源码里只有一个回车'
    ])
  })

  it('末尾回车与连续空行不产生空段落', () => {
    expect(splitParagraphs('第一段\n\n第二段\n')).toEqual(['第一段', '第二段'])
    expect(splitParagraphs('\n\n甲\n\n\n乙\n\n')).toEqual(['甲', '乙'])
  })

  it('兼容 CRLF 换行', () => {
    expect(splitParagraphs('甲\r\n乙')).toEqual(['甲', '乙'])
  })

  it('剥离已有的行首标记，重复套用不会叠加', () => {
    expect(splitParagraphs('- 多事件连贯\n1. 语言事件提示\n> 事件优先级\n## 标题\n- [x] 已完成')).toEqual([
      '多事件连贯',
      '语言事件提示',
      '事件优先级',
      '标题',
      '已完成'
    ])
  })

  it('行内标记保持原样，只剥掉行首块级标记', () => {
    expect(splitParagraphs('**重点**内容')).toEqual(['**重点**内容'])
  })
})
