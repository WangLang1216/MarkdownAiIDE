import { describe, expect, it } from 'vitest'
import { popModal, pushModal } from '@shared/modal'

describe('弹窗层级', () => {
  it('关闭子弹窗只退一层，回到上一个弹窗', () => {
    let stack: string[] = []
    stack = pushModal(stack, 'about')
    stack = pushModal(stack, 'shortcuts')
    expect(stack).toEqual(['about', 'shortcuts'])

    stack = popModal(stack)
    expect(stack).toEqual(['about'])

    stack = popModal(stack)
    expect(stack).toEqual([])
  })

  it('重复打开同一弹窗不会堆叠层级', () => {
    let stack: string[] = []
    stack = pushModal(stack, 'about')
    stack = pushModal(stack, 'about')
    expect(stack).toEqual(['about'])
    expect(popModal(stack)).toEqual([])
  })

  it('已在下层的弹窗再次打开时截断回该层', () => {
    let stack: string[] = ['about', 'shortcuts']
    stack = pushModal(stack, 'about')
    expect(stack).toEqual(['about'])
  })

  it('空栈关闭后仍为空', () => {
    expect(popModal([])).toEqual([])
  })
})
