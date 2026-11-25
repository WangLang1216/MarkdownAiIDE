/**
 * 链接定位：双击选中与删除时使用的纯函数。
 */

import { describe, expect, it } from 'vitest'
import { findLinkAt, findLinkByTextRange, wrapLinkSource } from '../../src/shared/markdown/links'

describe('findLinkAt', () => {
  it('locates both the whole markdown link and its text', () => {
    const text = '前缀 [链接文字](https://example.com "标题") 后缀'
    const link = findLinkAt(text, text.indexOf('链接'))
    expect(link).toEqual({
      from: 3,
      to: text.indexOf(' 后缀'),
      textFrom: 4,
      textTo: 8
    })
  })

  it('matches the link marker as well, but never treats an image as a link', () => {
    const text = '[文字](https://a.com)'
    expect(findLinkAt(text, 0)?.from).toBe(0)
    expect(findLinkAt(text, text.length)?.to).toBe(text.length)
    expect(findLinkAt('![图片](./a.png)', 3)).toBeNull()
  })

  it('handles auto links and bare URLs', () => {
    expect(findLinkAt('见 <https://a.com> 哦', 5)).toEqual({
      from: 2,
      to: 17,
      textFrom: 2,
      textTo: 17
    })
    const bare = findLinkAt('打开 www.a.com 看看', 7)
    expect(bare?.from).toBe(3)
    expect(bare?.textTo).toBe(bare?.to)
  })

  it('returns null outside any link', () => {
    expect(findLinkAt('普通文字', 2)).toBeNull()
  })
})

describe('findLinkByTextRange', () => {
  it('only accepts a selection covering exactly the link text', () => {
    const text = '[链接文字](https://a.com)'
    expect(findLinkByTextRange(text, 1, 5)?.from).toBe(0)
    expect(findLinkByTextRange(text, 1, 4)).toBeNull()
    expect(findLinkByTextRange(text, 0, text.length)).toBeNull()
  })
})

describe('wrapLinkSource', () => {
  it('keeps the selected text and points at the url placeholder', () => {
    const wrapped = wrapLinkSource('选中文字', 'https://')
    expect(wrapped.insert).toBe('[选中文字](https://)')
    expect(wrapped.insert.slice(wrapped.textFrom, wrapped.textTo)).toBe('选中文字')
    expect(wrapped.insert.slice(wrapped.hrefFrom, wrapped.hrefFrom + 'https://'.length)).toBe('https://')
  })
})
