/**
 * 实时渲染的富内容 Widget：图片、表格、代码块、Mermaid、公式、任务复选框与分隔线。
 * Widget 只在光标离开对应块时出现，点击可回到源码编辑。
 */

import { EditorSelection } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import { resolveImageSrc, renderInlineMarkdown, renderMermaidToSvg } from '../lib/markdown'
import { highlightCode } from '../lib/highlight'

function spacedBlock(content: HTMLElement): HTMLElement {
  const block = document.createElement('div')
  block.className = 'cm-widget-spaced-block'
  block.append(content)
  return block
}

interface ImageSpec {
  documentId: string | null
  raw: string
  alt: string
  block: boolean
  loadRemote: boolean
}

/** 用图片节点替代未编辑的图片语法，并提供失效时的回退显示。 */
export class ImageWidget extends WidgetType {
  /** 保存图片地址、替代文本和源码位置，供图片渲染与交互使用。 */
  constructor(readonly spec: ImageSpec) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    if (!(other instanceof ImageWidget)) return false
    const a = this.spec
    const b = other.spec
    return (
      a.raw === b.raw &&
      a.alt === b.alt &&
      a.block === b.block &&
      a.documentId === b.documentId &&
      a.loadRemote === b.loadRemote
    )
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(): HTMLElement {
    const wrap = document.createElement(this.spec.block ? 'div' : 'span')
    wrap.className = 'cm-widget-image'
    const resolved = resolveImageSrc(this.spec.raw, {
      documentId: this.spec.documentId,
      loadRemoteImages: this.spec.loadRemote
    })
    if (!resolved) {
      const broken = document.createElement('span')
      broken.className = 'broken'
      broken.textContent = /^https?:\/\//i.test(this.spec.raw)
        ? '远程图片已阻止（可在设置中开启）'
        : '图片路径无法解析'
      wrap.append(broken)
    } else {
      const img = document.createElement('img')
      img.src = resolved
      img.alt = this.spec.alt
      img.tabIndex = 0
      img.title = '放大图片'
      img.loading = 'lazy'
      img.addEventListener('error', () => {
        const broken = document.createElement('span')
        broken.className = 'broken'
        broken.textContent = `图片无法加载：${this.spec.raw}`
        img.replaceWith(broken)
      })
      wrap.append(img)
      if (this.spec.block && this.spec.alt) {
        const caption = document.createElement('span')
        caption.className = 'caption'
        caption.textContent = this.spec.alt
        wrap.append(caption)
      }
    }
    return wrap
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 将 Markdown 分隔线呈现为实际水平线。 */
export class HrWidget extends WidgetType {
  /** 记录水平线语法对应的源码起点。 */
  constructor(
    readonly sourcePos: number,
    readonly locked = false
  ) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    return other instanceof HrWidget && other.sourcePos === this.sourcePos && other.locked === this.locked
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-widget-hr'
    wrap.title = '分隔线'
    if (!this.locked) {
      wrap.addEventListener('click', () => {
        view.dispatch({ selection: EditorSelection.cursor(Math.min(this.sourcePos, view.state.doc.length)) })
        view.focus()
      })
    }
    return wrap
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 为表格 Widget 提供表头、数据行、对齐方式和源码起点。 */
export interface TableSpec {
  /** 表格第一行的有序表头单元格。 */
  header: string[]
  /** 表头以外、按原顺序排列的数据行。 */
  rows: string[][]
  /** 与表头列对应的对齐方式。 */
  aligns: Array<'left' | 'center' | 'right'>
  /** 表格在编辑缓冲区中的位置，用于返回源码编辑。 */
  sourcePos: number
  /** 页面锁定：禁用「点击进入表格源码」。 */
  locked?: boolean
}

/** 将表格源码渲染为只读 HTML 表格，并支持回到源码编辑。 */
export class TableWidget extends WidgetType {
  /** 保存表格的解析结果，供渲染及定位源码使用。 */
  constructor(readonly spec: TableSpec) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    if (!(other instanceof TableWidget)) return false
    return (
      other.spec.sourcePos === this.spec.sourcePos &&
      other.spec.locked === this.spec.locked &&
      JSON.stringify(other.spec.header) === JSON.stringify(this.spec.header) &&
      JSON.stringify(other.spec.rows) === JSON.stringify(this.spec.rows) &&
      JSON.stringify(other.spec.aligns) === JSON.stringify(this.spec.aligns)
    )
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-widget-table'
    wrap.title = this.spec.locked ? '页面已锁定' : '点击进入表格源码'
    const table = document.createElement('table')
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.spec.header.forEach((cell, index) => {
      const th = document.createElement('th')
      th.innerHTML = renderInlineMarkdown(cell)
      th.style.textAlign = this.spec.aligns[index] ?? 'left'
      headRow.append(th)
    })
    thead.append(headRow)
    table.append(thead)
    const tbody = document.createElement('tbody')
    for (const row of this.spec.rows) {
      const tr = document.createElement('tr')
      row.forEach((cell, index) => {
        const td = document.createElement('td')
        td.innerHTML = renderInlineMarkdown(cell)
        td.style.textAlign = this.spec.aligns[index] ?? 'left'
        tr.append(td)
      })
      tbody.append(tr)
    }
    table.append(tbody)
    wrap.append(table)
    if (!this.spec.locked) {
      wrap.addEventListener('click', () => {
        view.dispatch({
          selection: EditorSelection.cursor(Math.min(this.spec.sourcePos, view.state.doc.length)),
          scrollIntoView: true
        })
        view.focus()
      })
    }
    return spacedBlock(wrap)
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

interface CodeSpec {
  code: string
  lang: string
  sourcePos: number
  /** 页面锁定：点击不再进入源码，仅保留复制。 */
  locked?: boolean
}

/** 渲染带语言标记和语法高亮的代码块。 */
export class CodeBlockWidget extends WidgetType {
  /** 接收代码块正文、语言及源码定位数据。 */
  constructor(readonly spec: CodeSpec) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    if (!(other instanceof CodeBlockWidget)) return false
    return (
      other.spec.code === this.spec.code &&
      other.spec.lang === this.spec.lang &&
      other.spec.sourcePos === this.spec.sourcePos &&
      other.spec.locked === this.spec.locked
    )
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-widget-code'
    const head = document.createElement('div')
    head.className = 'code-head'
    const label = document.createElement('span')
    label.textContent = this.spec.lang || 'text'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '复制'
    copy.addEventListener('click', async (event) => {
      event.stopPropagation()
      // 渲染进程禁用了所有 Web 权限，navigator.clipboard 会直接 reject，必须走主进程剪贴板
      try {
        await window.api.app.writeClipboardText(this.spec.code)
        copy.textContent = '复制成功'
      } catch {
        copy.textContent = '复制失败'
      }
      window.setTimeout(() => {
        copy.textContent = '复制'
      }, 1600)
    })
    head.append(label, copy)
    // 顶部工具条属于控件而不是正文：拦下 mousedown，
    // 否则浏览器会把光标移进代码块，livePreview 立刻切成源码，按钮还没等到 click 就被销毁了
    head.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.className = 'hljs'
    code.innerHTML = highlightCode(this.spec.code, this.spec.lang)
    pre.append(code)
    wrap.append(head, pre)
    if (!this.spec.locked) {
      wrap.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('.code-head')) return
        view.dispatch({
          selection: EditorSelection.cursor(Math.min(this.spec.sourcePos, view.state.doc.length)),
          scrollIntoView: true
        })
        view.focus()
      })
    }
    return spacedBlock(wrap)
  }

  /**
   * 复制按钮上的事件交给 DOM 自己处理。
   * 否则 CodeMirror 会把这次点击当成"点进代码块"，光标落到 fence 上，
   * 块立刻切成源码形态——看起来就像"点了复制却跳成了源码"。
   */
  override ignoreEvent(event: Event): boolean {
    return Boolean((event.target as HTMLElement | null)?.closest?.('.code-head'))
  }
}

const mermaidCache = new Map<string, string>()

/** 异步渲染 Mermaid 图表，并处理渲染期间的占位与失败状态。 */
export class MermaidWidget extends WidgetType {
  /** 接收图表定义和编辑环境参数，供异步绘制使用。 */
  constructor(
    readonly code: string,
    readonly dark: boolean,
    readonly sourcePos: number,
    readonly locked = false
  ) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidWidget &&
      other.code === this.code &&
      other.dark === this.dark &&
      other.locked === this.locked
    )
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-widget-mermaid'
    const key = `${this.dark ? 'd' : 'l'}:${this.code}`
    const cached = mermaidCache.get(key)
    if (cached) {
      wrap.innerHTML = cached
      const element = wrap.querySelector('svg')
      if (element) {
        element.removeAttribute('height')
        element.style.width = '100%'
        element.style.maxWidth = '100%'
        element.style.height = 'auto'
      }
    } else {
      wrap.textContent = '正在渲染图表…'
      void renderMermaidToSvg(this.code, this.dark)
        .then((svg) => {
          mermaidCache.set(key, svg)
          if (wrap.isConnected) {
            wrap.innerHTML = svg
            const element = wrap.querySelector('svg')
            if (element) {
              element.removeAttribute('height')
              element.style.width = '100%'
              element.style.maxWidth = '100%'
              element.style.height = 'auto'
            }
          }
        })
        .catch((error: unknown) => {
          wrap.innerHTML = `<div class="mermaid-error">图表渲染失败：${
            error instanceof Error ? error.message.replace(/</g, '&lt;') : '未知错误'
          }</div>`
        })
    }
    wrap.addEventListener('click', (event) => {
      if (this.locked) return
      if ((event.target as HTMLElement).closest('svg')) return
      view.dispatch({ selection: EditorSelection.cursor(Math.min(this.sourcePos, view.state.doc.length)) })
      view.focus()
    })
    return wrap
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 用公式渲染器展示 Markdown 中的数学表达式。 */
export class MathWidget extends WidgetType {
  /** 接收公式源码及显示配置。 */
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly sourcePos: number,
    readonly locked = false
  ) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    return (
      other instanceof MathWidget &&
      other.tex === this.tex &&
      other.display === this.display &&
      other.locked === this.locked
    )
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement(this.display ? 'div' : 'span')
    wrap.className = 'cm-widget-math'
    try {
      katex.render(this.tex, wrap, {
        displayMode: this.display,
        throwOnError: false,
        trust: false,
        strict: false
      })
    } catch {
      wrap.textContent = this.tex
    }
    wrap.addEventListener('click', () => {
      if (this.locked) return
      view.dispatch({
        selection: EditorSelection.cursor(Math.min(this.sourcePos, view.state.doc.length)),
        scrollIntoView: true
      })
      view.focus()
    })
    return wrap
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 展示任务项复选框，并将用户切换映射回 Markdown 标记。 */
export class TaskCheckboxWidget extends WidgetType {
  /** 记录复选框的状态和任务标记所在位置。 */
  constructor(
    readonly checked: boolean,
    readonly markerPos: number,
    readonly locked = false
  ) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.markerPos === this.markerPos &&
      other.locked === this.locked
    )
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'cm-task-checkbox'
    input.checked = this.checked
    input.disabled = this.locked
    input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成')
    input.addEventListener('change', () => {
      if (this.locked) return
      const insert = input.checked ? '[x]' : '[ ]'
      view.dispatch({
        changes: { from: this.markerPos, to: this.markerPos + 3, insert }
      })
    })
    input.addEventListener('click', (event) => event.stopPropagation())
    return input
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 把 `:smile:` 这类简码替换为实际表情，仅用于即时渲染。 */
export class EmojiWidget extends WidgetType {
  /** 保存简码对应的 Unicode 表情。 */
  constructor(readonly emoji: string) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    return other instanceof EmojiWidget && other.emoji === this.emoji
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-emoji'
    span.textContent = this.emoji
    return span
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 目录条目：标题层级、纯文本和源码位置。 */
export interface TocEntry {
  level: number
  text: string
  pos: number
}

/**
 * 即时渲染中的 `[TOC]`：按当前文稿标题生成目录，点击可定位到标题。
 * 锁定页面时只滚动，不移动光标，避免回到源码。
 */
export class TocWidget extends WidgetType {
  /** 保存目录条目与锁定状态。 */
  constructor(
    readonly entries: TocEntry[],
    readonly locked = false
  ) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    if (!(other instanceof TocWidget)) return false
    return other.locked === this.locked && JSON.stringify(other.entries) === JSON.stringify(this.entries)
  }

  /** 构造目录卡片；条目点击按锚点位置滚动。 */
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-widget-toc'
    const title = document.createElement('div')
    title.className = 'toc-title'
    title.textContent = '目录'
    wrap.append(title)
    if (!this.entries.length) {
      const empty = document.createElement('div')
      empty.className = 'toc-empty'
      empty.textContent = '还没有标题，写下 ## 二级标题后这里会自动生成。'
      wrap.append(empty)
      return spacedBlock(wrap)
    }
    const list = document.createElement('ul')
    for (const entry of this.entries) {
      const item = document.createElement('li')
      item.style.paddingLeft = `${Math.max(0, entry.level - 1) * 14}px`
      const link = document.createElement('a')
      link.textContent = entry.text
      link.href = '#'
      link.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        view.dom.dispatchEvent(new CustomEvent('moye-outline-jump', { bubbles: true, detail: entry.pos }))
      })
      item.append(link)
      list.append(item)
    }
    wrap.append(list)
    return spacedBlock(wrap)
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 以装饰节点显示尚未写入正文的续写文本。 */
export class GhostTextWidget extends WidgetType {
  /** 保存需要以幽灵文本形式展示的候选。 */
  constructor(readonly text: string) {
    super()
  }

  /** 比较同类装饰实例中影响渲染的数据，供 CodeMirror 判断能否复用 DOM。 */
  override eq(other: WidgetType): boolean {
    return other instanceof GhostTextWidget && other.text === this.text
  }

  /** 构造当前 Markdown 装饰对应的浏览器节点。 */
  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-ghost-text'
    wrap.textContent = this.text
    const hint = document.createElement('span')
    hint.className = 'cm-ghost-hint'
    hint.textContent = 'Tab 接受 · Esc 忽略'
    wrap.append(hint)
    return wrap
  }

  /** 向 CodeMirror 声明是否忽略属于当前装饰的事件。 */
  override ignoreEvent(): boolean {
    return false
  }
}
