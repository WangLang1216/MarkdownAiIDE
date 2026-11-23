/**
 * 导出 HTML 构造：内联样式与图片，保证离线可打开；PDF 复用同一份 HTML。
 */

import tokensCss from '../styles/tokens.css?raw'
import markdownCss from '../styles/markdown.css?raw'
import printCss from '../styles/print.css?raw'
import katexCss from 'katex/dist/katex.min.css?raw'
import { escapeHtml, renderForExport } from './markdown'

/** 指定导出 HTML 的正文、资源范围、主题和样式选项。 */
export interface BuildHtmlOptions {
  /** 写入导出页面 title 元素的文稿标题。 */
  title: string
  /** 用于生成导出 HTML 的完整 Markdown 正文。 */
  markdown: string
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 控制该渲染场景是否加载远程图片。 */
  loadRemoteImages: boolean
  /** 决定导出时是否加入选定文稿主题。 */
  includeTheme: boolean
  /** 可注入导出文档的隔离主题样式。 */
  themeCss: string
  /** 限制主题 CSS 生效的文稿容器标识。 */
  themeScope: string | null
  /** 控制公式、图表或页面使用深色渲染模式。 */
  dark: boolean
  /** 决定输出是否采用应用提供的页面排版样式。 */
  styled: boolean
  /** 将导出 HTML 中的本地引用映射为可离线查看的地址。 */
  inlineImages: (urls: string[]) => Promise<Record<string, string>>
}

function collectLocalImages(html: string): string[] {
  const urls = new Set<string>()
  const pattern = /src="(mdres:\/\/[^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) urls.add(match[1])
  return [...urls]
}

/** 渲染正文并组装含文档标题、样式及主题作用域的完整 HTML。 */
export async function buildExportHtml(options: BuildHtmlOptions): Promise<string> {
  let body = await renderForExport(
    options.markdown,
    { documentId: options.documentId, loadRemoteImages: options.loadRemoteImages },
    options.dark
  )

  const localImages = collectLocalImages(body)
  if (localImages.length) {
    const inline = await options.inlineImages(localImages)
    for (const [url, dataUrl] of Object.entries(inline)) {
      body = body.split(`src="${url}"`).join(`src="${dataUrl}"`)
    }
  }

  const scopeAttr = options.themeScope ? ` data-doc-theme="${escapeHtml(options.themeScope)}"` : ''
  const baseCss = options.styled
    ? `:root { color-scheme: light; }\n${tokensCss}\n${markdownCss}\n${katexCss}\n${
        options.includeTheme ? options.themeCss : ''
      }\n${printCss}`
    : `body{margin:0;padding:32px;font:14px/1.8 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#282b2f}
       img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}pre{overflow:auto;background:#f5f6f5;padding:12px}
       @media print{body{padding:0}}`

  const csp =
    "default-src 'none'; img-src data: file: https:; style-src 'unsafe-inline'; font-src data: file:"

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(options.title)}</title>
<style>${baseCss}</style>
</head>
<body>
<article class="markdown-body"${scopeAttr}>
${body}
</article>
</body>
</html>`
}
