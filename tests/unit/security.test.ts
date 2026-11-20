import { describe, expect, it } from 'vitest'
import { isPathInside, resolveInside } from '../../src/main/utils/fs'
import { extractHtml, isBlockedAddress } from '../../src/main/references/web'
import { buildLiveOverride, missingALevel, scopeCss } from '@shared/theme/scoping'

describe('路径与网络边界', () => {
  it('工作区相对路径拒绝穿越与绝对路径', () => {
    const root = process.platform === 'win32' ? 'C://workspace//docs' : '/workspace/docs'
    expect(resolveInside(root, 'notes/a.md')).toMatch(/a\.md$/)
    expect(() => resolveInside(root, '../secret.md')).toThrowError(/超出工作区/)
    expect(() => resolveInside(root, '..\\secret.md')).toThrowError(/超出工作区/)
    expect(() => resolveInside(root, 'C://Windows//win.ini')).toThrowError(/相对路径/)
  })

  it('同名前缀目录不被误判为子路径', () => {
    const root = process.platform === 'win32' ? 'C://work//docs' : '/work/docs'
    const sibling = process.platform === 'win32' ? 'C://work//docs-other//a.md' : '/work/docs-other/a.md'
    expect(isPathInside(root, sibling)).toBe(false)
  })

  it('拒绝本机、内网与云元数据地址', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1'
    ]) {
      expect(isBlockedAddress(address)).toBe(true)
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
    expect(isBlockedAddress('1.1.1.1')).toBe(false)
  })

  it('网页正文提取忽略脚本与导航并保留标题', () => {
    const html = `<html><head><title>示例文章</title><style>body{color:red}</style></head>
      <body><nav>菜单</nav><article><h1>标题</h1><p>第一段&nbsp;内容。</p>
      <script>alert(1)</script><p>第二段<br>换行。</p></article><footer>页脚</footer></body></html>`
    const result = extractHtml(html)
    expect(result.title).toBe('示例文章')
    expect(result.text).toContain('第一段 内容。')
    expect(result.text).toContain('第二段')
    expect(result.text).not.toContain('菜单')
    expect(result.text).not.toContain('alert')
    expect(result.text).not.toContain('页脚')
  })
})

describe('Typora 主题隔离', () => {
  const css = `#write { font-family: Georgia, serif; font-size: 16px; }
#write h1 { font-size: 30px; color: #333; }
#write p { margin: 10px 0; }
#write table { border-collapse: collapse; }
#write blockquote { color: #777; }
@import url("https://example.com/remote.css");
@media (max-width: 600px) { #write h2 { font-size: 20px; } }
body { background: #fff; }`

  it('所有规则被限定到主题作用域，@import 被移除', () => {
    const result = scopeCss(css, 'doc-theme_1')
    expect(result.css).not.toContain('@import')
    expect(result.css).toContain('[data-doc-theme="doc-theme_1"]')
    expect(result.css).toContain('@media')
    expect(result.css).toContain('#333')
    expect(result.warnings.join()).toContain('@import')
  })

  it('生成 A 级兼容报告', () => {
    const result = scopeCss(css, 'scope')
    expect(result.aLevelCovered).toEqual(expect.arrayContaining(['标题', '正文', '表格', '引用']))
    expect(missingALevel(result.aLevelCovered)).toContain('任务列表')
  })

  it('提取正文排版映射到实时渲染类', () => {
    const live = buildLiveOverride(css, 'scope')
    expect(live).toContain('.cm-content[data-doc-theme="scope"]')
    expect(live).toContain('font-family:Georgia')
    expect(live).toContain('.cm-md-h1{font-size:30px')
  })
})
