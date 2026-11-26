import { describe, expect, it } from 'vitest'
import { ELEMENT_SNIPPETS, EXTENDED_SNIPPETS, snippetById } from '../../src/renderer/editor/snippets'
import { snippetToolbarBadge } from '../../src/renderer/editor/elementBadges'
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

/** 顶栏元素条只有图标没有文字，每个元素都必须能给出记号或已注册的图标。 */
describe('顶栏元素记号', () => {
  it('基础与扩展元素都有可见记号，图标均已注册', () => {
    for (const snippet of [...ELEMENT_SNIPPETS, ...EXTENDED_SNIPPETS]) {
      const badge = snippetToolbarBadge(snippet)
      expect(Boolean(badge.glyph || badge.icon), snippet.id).toBe(true)
      if (badge.icon) expect(ICON_PATHS[badge.icon], snippet.id).toBeTruthy()
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
