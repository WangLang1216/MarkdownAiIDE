/**
 * 预览渲染：markdown-it + GFM 表格/任务列表 + KaTeX + Mermaid + highlight.js。
 * 扩展语法（高亮、上下标、标题 ID、定义列表、目录、Emoji）在此集中实现，
 * 保证预览、即时渲染与导出对同一份 Markdown 给出一致的成稿效果。
 * 所有原始 HTML 默认转义；图片路径按文档授权解析为 mdres://。
 */

import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import katex from 'katex'
import { hljs, resolveLanguage } from './highlight'
import { emojiFor } from './emoji'
import { definitionPrefixLength, findHeadingId, isTocLine, slugifyHeading } from '@shared/markdown/extended'
import mermaid from 'mermaid'
import 'katex/dist/katex.min.css'

/** 为 Markdown 渲染提供文稿图片解析上下文和导出标志。 */
export interface RenderEnv {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 控制该渲染场景是否加载远程图片。 */
  loadRemoteImages: boolean
  /** 指示当前渲染用于导出，便于采用导出专用的资源处理。 */
  forExport?: boolean
}

interface MarkdownEnv extends RenderEnv {}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function isRemote(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

function isData(src: string): boolean {
  return /^data:/i.test(src)
}

/** 把 Markdown 中的图片地址解析为可访问 URL；不可用时返回 null */
export function resolveImageSrc(src: string, env: MarkdownEnv): string | null {
  const value = src.trim().replace(/^<|>$/g, '')
  if (!value) return null
  if (isData(value) || value.startsWith('mdres://')) return value
  if (isRemote(value)) return env.loadRemoteImages || env.forExport ? value : null
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('file:')) return null
  if (!env.documentId) return null
  const cleaned = value.replace(/^\.\//, '')
  return `mdres://${env.documentId}/${cleaned.split('/').map(encodeURIComponent).join('/')}`
}

function mathHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml'
    })
  } catch {
    return `<code class="math-error">${escapeHtml(tex)}</code>`
  }
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false
})
md.use(footnote)

/* --------------------------- 下划线 --------------------------- */
/* Markdown 没有原生下划线，仅放行 <u>…</u> 这一对标签，其余 HTML 仍然转义 */
md.inline.ruler.before('html_inline', 'underline_tag', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x3c) return false
  const match = /^<u>([\s\S]+?)<\/u>/.exec(state.src.slice(state.pos))
  if (!match) return false
  if (!silent) {
    const token = state.push('underline', 'u', 0)
    token.content = match[1]
  }
  state.pos += match[0].length
  return true
})

md.renderer.rules.underline = (tokens, idx, _options, env) =>
  `<u>${md.renderInline(tokens[idx].content, env as MarkdownEnv)}</u>`

/* ------------------------ 高亮、上下标 ------------------------ */

md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x3d || state.src.charCodeAt(start + 1) !== 0x3d) return false
  if (state.src.charCodeAt(start + 2) === 0x3d) return false
  let end = start + 2
  while (end < state.src.length) {
    const next = state.src.indexOf('==', end)
    if (next === -1) return false
    if (state.src[next - 1] !== '\\') {
      end = next
      break
    }
    end = next + 2
  }
  const content = state.src.slice(start + 2, end)
  if (!content.trim() || content.includes('\n')) return false
  if (!silent) {
    const token = state.push('mark', 'mark', 0)
    token.content = content
  }
  state.pos = end + 2
  return true
})

md.renderer.rules.mark = (tokens, idx, _options, env) =>
  `<mark>${md.renderInline(tokens[idx].content, env as MarkdownEnv)}</mark>`

md.inline.ruler.before('emphasis', 'superscript', (state, silent) => {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x5e) return false
  if (start > 0 && state.src[start - 1] === '\\') return false
  const close = state.src.indexOf('^', start + 1)
  if (close === -1) return false
  const content = state.src.slice(start + 1, close)
  if (!content.trim() || /\s/.test(content) || content.includes('\n')) return false
  if (!silent) {
    const token = state.push('sup', 'sup', 0)
    token.content = content
  }
  state.pos = close + 1
  return true
})

md.renderer.rules.sup = (tokens, idx, _options, env) =>
  `<sup>${md.renderInline(tokens[idx].content, env as MarkdownEnv)}</sup>`

md.inline.ruler.before('strikethrough', 'subscript', (state, silent) => {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x7e) return false
  // 双波浪号交给删除线，单波浪号才是下标
  if (state.src.charCodeAt(start + 1) === 0x7e) return false
  if (start > 0 && state.src[start - 1] === '~') return false
  const close = state.src.indexOf('~', start + 1)
  if (close === -1) return false
  const content = state.src.slice(start + 1, close)
  if (!content.trim() || /\s/.test(content) || content.includes('\n')) return false
  if (!silent) {
    const token = state.push('sub', 'sub', 0)
    token.content = content
  }
  state.pos = close + 1
  return true
})

md.renderer.rules.sub = (tokens, idx, _options, env) =>
  `<sub>${md.renderInline(tokens[idx].content, env as MarkdownEnv)}</sub>`

/* ------------------------ Emoji 简码 ------------------------ */

md.inline.ruler.before('emphasis', 'emoji', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x3a) return false
  const match = /^:([a-z0-9_+-]{2,32}):/i.exec(state.src.slice(state.pos, state.pos + 36))
  if (!match) return false
  const emoji = emojiFor(match[1])
  if (!emoji) return false
  if (!silent) {
    const token = state.push('text', '', 0)
    token.content = emoji
  }
  state.pos += match[0].length
  return true
})

/* ------------------------ 自定义标题 ID ------------------------ */

md.core.ruler.before('inline', 'heading_ids', (state) => {
  for (let i = 0; i < state.tokens.length; i += 1) {
    const token = state.tokens[i]
    if (token.type !== 'heading_open') continue
    if (token.map && !(state.env as MarkdownEnv).forExport) token.attrSet('data-source-line', String(token.map[0]))
    const inline = state.tokens[i + 1]
    if (!inline || inline.type !== 'inline') continue
    const found = findHeadingId(inline.content)
    if (!found) continue
    token.attrSet('id', found.id)
    inline.content = inline.content.slice(0, found.index)
  }
})

/* ------------------------ 定义列表 ------------------------ */

md.block.ruler.before('paragraph', 'definition_list', (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const termStart = state.bMarks[startLine] + state.tShift[startLine]
  const termEnd = state.eMarks[startLine]
  const term = state.src.slice(termStart, termEnd)
  if (!term.trim()) return false
  if (startLine + 1 >= endLine) return false
  const nextStart = state.bMarks[startLine + 1] + state.tShift[startLine + 1]
  const nextEnd = state.eMarks[startLine + 1]
  if (!definitionPrefixLength(state.src.slice(nextStart, nextEnd))) return false
  if (silent) return true

  state.push('dl_open', 'dl', 1)

  state.push('dt_open', 'dt', 1)
  const termToken = state.push('inline', '', 0)
  termToken.content = term.trim()
  termToken.map = [startLine, startLine + 1]
  termToken.children = []
  state.push('dt_close', 'dt', -1)

  let line = startLine + 1
  while (line < endLine) {
    const from = state.bMarks[line] + state.tShift[line]
    const to = state.eMarks[line]
    const raw = state.src.slice(from, to)
    const prefix = definitionPrefixLength(raw)
    if (!prefix) break
    state.push('dd_open', 'dd', 1)
    const defToken = state.push('inline', '', 0)
    defToken.content = raw.slice(prefix).trim()
    defToken.map = [line, line + 1]
    defToken.children = []
    state.push('dd_close', 'dd', -1)
    line += 1
  }

  state.push('dl_close', 'dl', -1)
  state.line = line
  return true
})

/* --------------------------- 数学公式 --------------------------- */

md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  const start = state.pos
  if (state.src[start] !== '$' || state.src[start + 1] === '$') return false
  if (start > 0 && state.src[start - 1] === '\\') return false
  let end = start + 1
  while (end < state.src.length) {
    const next = state.src.indexOf('$', end)
    if (next === -1) return false
    if (state.src[next - 1] !== '\\') {
      end = next
      break
    }
    end = next + 1
  }
  if (end <= start + 1) return false
  const content = state.src.slice(start + 1, end)
  if (!content.trim() || content.includes('\n') || content.startsWith('$')) return false
  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.content = content
    token.markup = '$'
  }
  state.pos = end + 1
  return true
})

md.renderer.rules.math_inline = (tokens, idx) => mathHtml(tokens[idx].content, false)

md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  const firstLine = state.src.slice(start, max).trim()
  if (!firstLine.startsWith('$$')) return false

  let content = firstLine.slice(2)
  let closingLine = -1
  if (content.trim().endsWith('$$') && content.trim().length > 2) {
    content = content.trim().slice(0, -2)
    closingLine = startLine
  } else {
    let line = startLine + 1
    const buffer: string[] = [content]
    while (line < endLine) {
      const lineStart = state.bMarks[line] + state.tShift[line]
      const lineEnd = state.eMarks[line]
      const value = state.src.slice(lineStart, lineEnd)
      if (value.trim().endsWith('$$')) {
        buffer.push(value.replace(/\$\$\s*$/, ''))
        closingLine = line
        break
      }
      buffer.push(value)
      line += 1
    }
    content = buffer.join('\n')
  }
  if (closingLine === -1) return false
  if (silent) return true
  state.line = closingLine + 1
  const token = state.push('math_block', 'math', 0)
  token.content = content.trim()
  token.map = [startLine, closingLine + 1]
  token.markup = '$$'
  return true
})

md.renderer.rules.math_block = (tokens, idx) =>
  `<div class="math-block">${mathHtml(tokens[idx].content, true)}</div>`

/* --------------------------- 任务列表 --------------------------- */

interface TaskToken {
  type: string
  content: string
  children: Array<{ type: string; content: string }> | null
  attrJoin(name: string, value: string): void
}

md.core.ruler.after('inline', 'task_lists', (state) => {
  const tokens = state.tokens as unknown as TaskToken[]
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'inline' || !token.children?.length) continue
    const first = token.children[0]
    if (first.type !== 'text') continue
    const match = /^\[([ xX])\]\s+/.exec(first.content)
    if (!match) continue
    const checked = match[1].toLowerCase() === 'x'
    first.content = first.content.slice(match[0].length)
    // 向上找到 list_item_open 并标记
    for (let j = i - 1; j >= 0; j -= 1) {
      if (tokens[j].type === 'list_item_open') {
        tokens[j].attrJoin('class', 'task-list-item')
        break
      }
      if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') break
    }
    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成' : '未完成'}">`
    token.children.unshift({ type: 'html_inline', content: checkbox.content })
  }
})

/* --------------------------- 代码块与 Mermaid --------------------------- */

md.renderer.rules.fence = (tokens, idx, _options, _env) => {
  const token = tokens[idx]
  const info = token.info.trim().split(/\s+/)[0] ?? ''
  const code = token.content
  if (info.toLowerCase() === 'mermaid') {
    return `<div class="mermaid-block" data-mermaid="1"><pre class="mermaid-source">${escapeHtml(code)}</pre></div>`
  }
  let highlighted: string
  let language = ''
  const resolved = info ? resolveLanguage(info) : ''
  if (resolved && hljs.getLanguage(resolved)) {
    language = resolved
    highlighted = hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
  } else {
    highlighted = escapeHtml(code)
  }
  const label = language || info || 'text'
  return `<pre class="code-block" data-lang="${escapeHtml(label)}"><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`
}

/* --------------------------- 图片与链接 --------------------------- */

md.renderer.rules.image = (tokens, idx, _options, env: MarkdownEnv) => {
  const token = tokens[idx]
  const rawSrc = token.attrGet('src') ?? ''
  const alt = token.content || token.attrGet('alt') || ''
  const title = token.attrGet('title') ?? ''
  const resolved = resolveImageSrc(rawSrc, env)
  if (!resolved) {
    const reason = isRemote(rawSrc) ? '已阻止加载远程图片（可在设置中开启）' : '图片路径无法解析'
    return `<span class="image-placeholder">${escapeHtml(reason)}：${escapeHtml(rawSrc)}</span>`
  }
  return `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`
}

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]
  const href = token.attrGet('href') ?? ''
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return self.renderToken(tokens, idx, options)
}

/* --------------------------- Front Matter --------------------------- */

md.block.ruler.before('hr', 'front_matter', (state, startLine, _endLine, silent) => {
  if (startLine !== 0) return false
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (state.src.slice(start, max).trim() !== '---') return false
  let line = startLine + 1
  while (line < state.lineMax) {
    const lineStart = state.bMarks[line] + state.tShift[line]
    const lineEnd = state.eMarks[line]
    const value = state.src.slice(lineStart, lineEnd).trim()
    if (value === '---' || value === '...') {
      if (silent) return true
      const token = state.push('front_matter', 'div', 0)
      token.content = state.src
        .split('\n')
        .slice(startLine + 1, line)
        .join('\n')
      token.map = [startLine, line + 1]
      state.line = line + 1
      return true
    }
    line += 1
  }
  return false
})

md.renderer.rules.front_matter = (tokens, idx) =>
  `<pre class="front-matter">${escapeHtml(tokens[idx].content)}</pre>`

/* --------------------------- 渲染入口 --------------------------- */

/**
 * 为标题补齐锚点 ID，并把 `[TOC]` 段落替换为目录。
 * 只在文档含目录或页内链接时解析 DOM，避免每次预览都多一次整树解析。
 */
function enhanceOutline(html: string): string {
  if (typeof document === 'undefined') return html
  if (!html.includes('[TOC]') && !/href="#/.test(html)) return html

  const holder = document.createElement('div')
  holder.innerHTML = html
  const headings = [...holder.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
  if (headings.length) {
    const used = new Set<string>()
    for (const heading of headings) {
      const base = heading.id || slugifyHeading(heading.textContent ?? '')
      let candidate = base
      let index = 2
      while (used.has(candidate)) candidate = `${base}-${index++}`
      used.add(candidate)
      heading.id = candidate
    }
  }

  for (const paragraph of [...holder.querySelectorAll('p')]) {
    if (!isTocLine(paragraph.textContent ?? '')) continue
    const nav = document.createElement('nav')
    nav.className = 'md-toc'
    const title = document.createElement('div')
    title.className = 'md-toc-title'
    title.textContent = '目录'
    nav.append(title)
    if (headings.length) {
      const list = document.createElement('ul')
      for (const heading of headings) {
        const item = document.createElement('li')
        item.style.paddingLeft = `${(Number(heading.tagName.slice(1)) - 1) * 12}px`
        const link = document.createElement('a')
        link.href = `#${heading.id}`
        link.textContent = heading.textContent ?? ''
        item.append(link)
        list.append(item)
      }
      nav.append(list)
    } else {
      nav.append(document.createTextNode('（还没有标题）'))
    }
    paragraph.replaceWith(nav)
  }

  return holder.innerHTML
}

/** 将 Markdown 源码渲染为 HTML，图表随后再异步处理。 */
export function renderMarkdown(text: string, env: RenderEnv): string {
  try {
    return enhanceOutline(md.render(text, env))
  } catch (error) {
    return `<p class="render-error">渲染失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`
  }
}

let mermaidInitialized = false
let mermaidDark = false
let mermaidSeq = 0

async function ensureMermaid(dark: boolean): Promise<void> {
  if (mermaidInitialized && mermaidDark === dark) return
  mermaidDark = dark
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: "'Segoe UI', 'Microsoft YaHei', sans-serif",
    themeVariables: dark
      ? {
          background: '#252825',
          primaryColor: '#33402f',
          primaryTextColor: '#d4dad3',
          primaryBorderColor: '#5c7057',
          lineColor: '#8ba089',
          secondaryColor: '#2d342b',
          tertiaryColor: '#2a3029',
          fontSize: '13px'
        }
      : {
          background: '#ffffff',
          primaryColor: '#eef3ef',
          primaryTextColor: '#282b2f',
          primaryBorderColor: '#b9cabb',
          lineColor: '#8a9d8c',
          secondaryColor: '#f4f6f2',
          tertiaryColor: '#fbfbf9',
          fontSize: '13px'
        },
    flowchart: { htmlLabels: false, curve: 'basis' },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true }
  })
  mermaidInitialized = true
}

/** 以指定配色渲染单个 Mermaid 图表并返回 SVG 字符串。 */
export async function renderMermaidToSvg(code: string, dark: boolean): Promise<string> {
  await ensureMermaid(dark)
  const id = `mermaid-${Date.now()}-${mermaidSeq++}`
  try {
    const { svg } = await mermaid.render(id, code)
    return svg
  } finally {
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

/** 把渲染后的 mermaid 占位替换为 SVG */
export async function hydrateMermaid(container: ParentNode, dark: boolean): Promise<void> {
  const blocks = [...container.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid]')]
  for (const block of blocks) {
    if (block.dataset.rendered === '1') continue
    const source = block.querySelector('pre')?.textContent ?? ''
    try {
      const svg = await renderMermaidToSvg(source, dark)
      block.innerHTML = svg
      block.dataset.rendered = '1'
    } catch (error) {
      block.innerHTML = `<div class="mermaid-error">图表渲染失败：${escapeHtml(
        error instanceof Error ? error.message : String(error)
      )}</div>`
      block.dataset.rendered = '1'
    }
  }
}

/** 导出前在离屏容器中完成渲染，并返回内联后的 HTML */
export async function renderForExport(text: string, env: RenderEnv, dark = false): Promise<string> {
  const html = renderMarkdown(text, { ...env, forExport: true })
  const holder = document.createElement('div')
  holder.innerHTML = html
  await hydrateMermaid(holder, dark)
  return holder.innerHTML
}

/** 重导出 HTML 文本转义函数供渲染调用方复用。 */
export { escapeHtml }

/** 渲染单行 Markdown 内联内容，不创建段落包装。 */
export function renderInlineMarkdown(text: string): string {
  try {
    return md.renderInline(text, { documentId: null, loadRemoteImages: false })
  } catch {
    return escapeHtml(text)
  }
}
