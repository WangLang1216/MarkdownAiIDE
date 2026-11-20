import { describe, expect, it } from 'vitest'
import {
  countText,
  parseOutline,
  parseSections,
  resolveAnchorOffset,
  scanHeadings,
  splitLines
} from '@shared/markdown/outline'

const DOC = `# 项目说明

开场段落。

## 请求参数

这是一个章节。

### 字段列表

- id
- name

## 响应格式

\`\`\`md
## 这不是标题
\`\`\`

## 请求参数

重复标题的第二个同名章节。
`

describe('Markdown 结构解析', () => {
  it('识别标题层级与章节边界，代码块中的伪标题被忽略', () => {
    const sections = parseSections(DOC)
    expect(sections.map((item) => item.title)).toEqual([
      '项目说明',
      '请求参数',
      '字段列表',
      '响应格式',
      '请求参数'
    ])
    expect(sections.map((item) => item.level)).toEqual([1, 2, 3, 2, 2])

    const firstH2 = sections[1]
    const nextH2 = sections[3]
    expect(firstH2.sectionEnd).toBe(nextH2.headingStart)
    expect(firstH2.sectionEnd).toBeGreaterThan(sections[2].headingStart)
  })

  it('重复标题拥有不同 ID，标题路径可区分位置', () => {
    const sections = parseSections(DOC)
    const duplicates = sections.filter((item) => item.title === '请求参数')
    expect(duplicates).toHaveLength(2)
    expect(duplicates[0].sectionId).not.toBe(duplicates[1].sectionId)
    expect(duplicates[1].headingPath).toEqual(['项目说明', '请求参数'])
  })

  it('章节锚点计算：标题后与章节末尾', () => {
    const sections = parseSections(DOC)
    const target = sections[1]
    const afterHeading = resolveAnchorOffset(DOC, sections, {
      sectionId: target.sectionId,
      position: 'after_heading'
    })
    expect(DOC.slice(afterHeading.offset).startsWith('\n这是一个章节')).toBe(true)

    const end = resolveAnchorOffset(DOC, sections, { sectionId: target.sectionId, position: 'section_end' })
    expect(DOC.slice(end.offset).startsWith('## 响应格式')).toBe(true)

    const docEnd = resolveAnchorOffset(DOC, sections, { sectionId: null, position: 'document_end' })
    expect(docEnd.offset).toBe(DOC.length)
  })

  it('无效章节返回可展示的错误', () => {
    const sections = parseSections(DOC)
    expect(() =>
      resolveAnchorOffset(DOC, sections, { sectionId: 'sec-missing', position: 'section_end' })
    ).toThrowError(/目标章节/)
  })

  it('支持 Setext 标题与 CRLF 文本', () => {
    const text = '旧式标题\r\n====\r\n\r\n正文\r\n\r\n次级标题\r\n----\r\n'
    const headings = scanHeadings(text)
    expect(headings.map((item) => [item.level, item.title])).toEqual([
      [1, '旧式标题'],
      [2, '次级标题']
    ])
  })

  it('Front Matter 不被当作标题或分隔线', () => {
    const text = '---\ntitle: 示例\n---\n\n# 正文标题\n'
    const sections = parseSections(text)
    expect(sections).toHaveLength(1)
    expect(sections[0].title).toBe('正文标题')
  })

  it('目录节点包含偏移与序号', () => {
    const outline = parseOutline(DOC)
    expect(outline[0].from).toBe(0)
    expect(outline[0].to).toBeGreaterThan(0)
    expect(outline.find((item) => item.title === '字段列表')?.ordinalAtLevel).toBe(1)
  })

  it('中英混排字数统计与行切分', () => {
    const stats = countText('你好 world, 这是 3 个词。')
    expect(stats.cjkCharacters).toBe(6)
    expect(stats.words).toBe(8)
    expect(stats.characters).toBeGreaterThan(0)
    const lines = splitLines('a\r\nb\nc')
    expect(lines.map((line) => line.text)).toEqual(['a', 'b', 'c'])
  })
})
