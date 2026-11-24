/**
 * 斜杠快捷插入：在行首输入 `/` 弹出元素菜单，继续输入即按名称过滤，
 * ↑↓ 选择、Enter 插入、Esc 取消。菜单只负责挑元素，插入动作交给调用方，
 * 保证和左侧元素面板走同一套 snippet 逻辑。
 */

import { Prec } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view'
import { ELEMENT_SNIPPETS, EXTENDED_SNIPPETS, type SnippetDefinition } from './snippets'

/** 选中某个元素后的回调；range 是 `/` 到光标的源码区间，插入前先删掉。 */
export interface SlashMenuOptions {
  onPick: (id: string, range: { from: number; to: number }) => void
}

/** 菜单左侧的短标记；缺省时取名称首字。 */
const GLYPHS: Record<string, string> = {
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  paragraph: '¶',
  quote: '”',
  list: '•',
  ordered: '1.',
  tasks: '☑',
  code: '</>',
  table: '▦',
  link: '↗',
  hr: '—',
  callout: '!',
  mermaid: '◇',
  math: '∑',
  footnote: '¹',
  mark: '==',
  sup: 'x²',
  sub: 'x₂',
  strike: '~~',
  underline: 'U',
  'heading-id': '#',
  'anchor-link': '↧',
  deflist: 'dl',
  toc: '☰',
  emoji: '☺'
}

/** 图片要拉起文件选择器，仍走左侧面板的插入流程。 */
const ITEMS: SnippetDefinition[] = [...ELEMENT_SNIPPETS, ...EXTENDED_SNIPPETS].filter(
  (item) => item.id !== 'image'
)

const menus = new WeakMap<EditorView, SlashMenu>()

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;'
  )
}

/** 没有 description 的元素用源码首行当说明，避免菜单里出现空白行 */
function hintFor(item: SnippetDefinition): string {
  if (item.description) return item.description
  const first = item.markdown.split('\n')[0].trim()
  return first || item.label
}

/** 按名称、标识和说明做不区分大小写的包含匹配。 */
export function matchSnippets(query: string, items: SnippetDefinition[] = ITEMS): SnippetDefinition[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return items
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(keyword) ||
      item.id.toLowerCase().includes(keyword) ||
      (item.description ?? '').toLowerCase().includes(keyword)
  )
}

class SlashMenu {
  private dom: HTMLDivElement | null = null
  private list: SnippetDefinition[] = []
  private active = 0
  private from = 0
  private to = 0
  private query = ''
  private open = false
  private readonly onScroll = (): void => {
    this.close()
  }

  constructor(
    private readonly view: EditorView,
    private readonly options: SlashMenuOptions
  ) {
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.close()
  }

  update(update: ViewUpdate): void {
    if (!this.open) {
      this.detect(update)
      return
    }
    if (update.docChanged || update.selectionSet) this.follow(update)
    else if (update.geometryChanged || update.viewportChanged) this.position()
  }

  /** 只在用户敲入 `/`、且 `/` 前面没有其他正文时触发。 */
  private detect(update: ViewUpdate): void {
    if (!update.docChanged) return
    const typed = update.transactions.some((tr) => tr.docChanged && tr.isUserEvent('input'))
    if (!typed) return
    const head = update.state.selection.main.head
    const line = update.state.doc.lineAt(head)
    const before = line.text.slice(0, head - line.from)
    if (!before.endsWith('/')) return
    if (before.slice(0, -1).trim()) return
    this.show(head - 1, head)
  }

  /** 跟随输入：光标跑出行内、出现空格或 `/` 被删掉时收起。 */
  private follow(update: ViewUpdate): void {
    const head = update.state.selection.main.head
    if (this.from > update.state.doc.length || head < this.from + 1) {
      this.close()
      return
    }
    const line = update.state.doc.lineAt(this.from)
    if (head > line.to) {
      this.close()
      return
    }
    const text = update.state.doc.sliceString(this.from, head)
    if (!text.startsWith('/')) {
      this.close()
      return
    }
    const query = text.slice(1)
    if (/\s/.test(query)) {
      this.close()
      return
    }
    this.to = head
    this.query = query
    this.render()
  }

  private show(from: number, to: number): void {
    if (this.view.state.readOnly) return
    this.from = from
    this.to = to
    this.query = ''
    this.active = 0
    this.open = true
    this.render()
  }

  /** 重建列表；没有匹配项时直接收起，不显示空面板。 */
  private render(): void {
    const list = matchSnippets(this.query)
    this.list = list
    if (!list.length) {
      this.close()
      return
    }
    this.active = Math.min(this.active, list.length - 1)
    if (!this.dom) {
      const dom = document.createElement('div')
      dom.className = 'slash-menu'
      dom.setAttribute('role', 'listbox')
      dom.setAttribute('aria-label', '插入元素')
      dom.addEventListener('mousedown', (event) => {
        event.preventDefault()
        const button = (event.target as HTMLElement | null)?.closest('.slash-item') as HTMLElement | null
        if (!button) return
        const index = Number(button.dataset.index)
        if (Number.isNaN(index)) return
        this.active = index
        this.accept()
      })
      // 悬停同样接管高亮：否则初始 active=0 的第一项会一直亮着，与鼠标下的项同时高亮
      dom.addEventListener('mouseover', (event) => {
        const button = (event.target as HTMLElement | null)?.closest('.slash-item') as HTMLElement | null
        if (!button) return
        const index = Number(button.dataset.index)
        if (Number.isNaN(index) || index === this.active) return
        this.setActive(index)
      })
      document.body.appendChild(dom)
      this.dom = dom
    }
    this.dom.innerHTML = list
      .map(
        (item, index) => `
        <button class="slash-item" type="button" role="option" data-index="${index}" data-active="${index === this.active}" aria-selected="${index === this.active}">
          <span class="slash-glyph">${escapeHtml(item.glyph ?? GLYPHS[item.id] ?? item.label.slice(0, 1))}</span>
          <span class="slash-text"><b>${escapeHtml(item.label)}</b><small>${escapeHtml(hintFor(item))}</small></span>
        </button>`
      )
      .join('')
    this.position()
  }

  /**
   * 定位必须走 requestMeasure：CodeMirror 不允许在 update 阶段读取布局，
   * 直接调 coordsAtPos 会抛 "Reading the editor layout isn't allowed during an update"。
   */
  private position(): void {
    const dom = this.dom
    if (!dom) return
    const from = this.from
    this.view.requestMeasure<{ left: number; top: number; bottom: number } | null>({
      read: (view) => {
        const coords = view.coordsAtPos(from)
        return coords ? { left: coords.left, top: coords.top, bottom: coords.bottom } : null
      },
      write: (coords) => {
        if (this.dom !== dom) return
        if (!coords) {
          this.close()
          return
        }
        const margin = 10
        const width = dom.offsetWidth
        const height = dom.offsetHeight
        let left = coords.left
        if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin
        let top = coords.bottom + 6
        if (top + height > window.innerHeight - margin && coords.top - height - 6 > margin) {
          top = coords.top - height - 6
        }
        dom.style.left = `${Math.max(margin, left)}px`
        dom.style.top = `${Math.max(margin, top)}px`
        dom.querySelector('.slash-item[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
      }
    })
  }

  /** 只切换高亮，不重建 DOM：悬停时重建 innerHTML 会闪一下，还会把滚动位置重置。 */
  private setActive(index: number): void {
    const dom = this.dom
    if (!dom) return
    const items = dom.querySelectorAll<HTMLElement>('.slash-item')
    if (!items.length) return
    const next = Math.max(0, Math.min(index, items.length - 1))
    this.active = next
    items.forEach((item, itemIndex) => {
      const on = String(itemIndex === next)
      if (item.dataset.active !== on) item.dataset.active = on
      if (item.getAttribute('aria-selected') !== on) item.setAttribute('aria-selected', on)
    })
    items[next]?.scrollIntoView({ block: 'nearest' })
  }

  /** ↑↓ 在同一条列表内循环移动。 */
  move(delta: number): boolean {
    if (!this.open || !this.list.length) return false
    this.setActive((this.active + delta + this.list.length) % this.list.length)
    return true
  }

  /** Enter 或点击：先收起菜单，再把待插入区间交给调用方。 */
  accept(): boolean {
    if (!this.open) return false
    const item = this.list[this.active]
    if (!item) return false
    const range = { from: this.from, to: this.to }
    this.close()
    this.options.onPick(item.id, range)
    return true
  }

  close(): boolean {
    if (!this.open) return false
    this.open = false
    this.dom?.remove()
    this.dom = null
    this.list = []
    this.active = 0
    return true
  }
}

/** 安装斜杠菜单；只在实时预览模式下启用。 */
export function slashMenu(options: SlashMenuOptions) {
  const plugin = ViewPlugin.fromClass(
    class {
      private readonly menu: SlashMenu

      constructor(view: EditorView) {
        this.menu = new SlashMenu(view, options)
        menus.set(view, this.menu)
      }

      update(update: ViewUpdate): void {
        this.menu.update(update)
      }

      destroy(): void {
        this.menu.destroy()
      }
    }
  )
  // 最高优先级：菜单展开时先吃掉方向键/回车/ESC，其余情况一律放行
  const keys = Prec.highest(
    keymap.of([
      { key: 'ArrowDown', run: (view) => menus.get(view)?.move(1) ?? false },
      { key: 'ArrowUp', run: (view) => menus.get(view)?.move(-1) ?? false },
      { key: 'Enter', run: (view) => menus.get(view)?.accept() ?? false },
      { key: 'Escape', run: (view) => menus.get(view)?.close() ?? false }
    ])
  )
  return [plugin, keys]
}
