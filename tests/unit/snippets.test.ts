import { describe, expect, it } from 'vitest'
import { snippetById } from '../../src/renderer/editor/snippets'
import { ICON_PATHS } from '../../src/renderer/lib/icons'

/** 元素片段插入后需要选中的占位内容，避免用户再去找要改的位置。 */
describe('元素片段默认选区', () => {
  it('链接默认选中括号内的地址，而不是链接文字', () => {
    const link = snippetById('link')!
    expect(link.select).toBeDefined()
    const selected = link.markdown.slice(link.select!.from, link.select!.to)
    expect(selected).toBe('https://example.com')
  })

  it('列表类元素默认选中第一项文本', () => {
    for (const [id, text] of [
      ['list', '第一个想法'],
      ['ordered', '第一步'],
      ['tasks', '整理思路']
    ] as const) {
      const snippet = snippetById(id)!
      expect(snippet.select).toBeDefined()
      expect(snippet.markdown.slice(snippet.select!.from, snippet.select!.to)).toBe(text)
    }
  })
})

/** 内容模板图标需要有各自的图形，且能在图标表中找到。 */
describe('内置内容模板图标', () => {
  it('六个模板各有独立图标且均已注册', () => {
    const icons = [
      snippetById('prompt-template')?.icon,
      snippetById('text-to-image-template')?.icon,
      snippetById('image-to-text-template')?.icon,
      snippetById('meeting-template')?.icon,
      snippetById('daily-template')?.icon,
      snippetById('weekly-template')?.icon
    ]
    expect(icons.every(Boolean)).toBe(true)
    expect(new Set(icons).size).toBe(icons.length)
    for (const icon of icons) expect(ICON_PATHS[icon!]).toBeTruthy()
  })
})
