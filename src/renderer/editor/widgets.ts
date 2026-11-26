/**
 * 实时渲染的富内容 Widget：图片、表格、代码块、Mermaid、公式、任务复选框与分隔线。
 * Widget 只在光标离开对应块时出现，点击可回到源码编辑。
 */

import { EditorSelection } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import { serializeTable, type TableAlign } from '@shared/markdown/table'
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

/** 为表格 Widget 提供表头、数据行、对齐方式和源码区间。 */
export interface TableSpec {
  /** 表格第一行的有序表头单元格。 */
  header: string[]
  /** 表头以外、按原顺序排列的数据行。 */
  rows: string[][]
  /** 与表头列对应的对齐方式。 */
  aligns: TableAlign[]
  /** 表格在编辑缓冲区中的起点。 */
  sourcePos: number
  /** 表格最后一行的终点（不含），用于整段回写。 */
  sourceEnd: number
  /** 页面锁定：只读展示，不进入编辑。 */
  locked?: boolean
}

/**
 * 表格 Widget：阅读态渲染成 HTML 表格，点击就地进入类似 Excel 的编辑态。
 *
 * 编辑态用 input 而不是 contenteditable：输入框的 value 不改变 CodeMirror 的文档 DOM，
 * 不会被编辑器的 DOM 观察器当成外部改写而回滚。单元格输入只存在内存里，
 * 点击完成、焦点离开表格或按 Esc 时才整段回写一次 Markdown，一次编辑只占一个撤销步。
 */
export class TableWidget extends WidgetType {
  private header: string[]
  private rows: string[][]
  private aligns: TableAlign[]
  /** 创建时的文档快照：eq 用它判断能否复用 DOM，避免编辑中的改动被重建覆盖 */
  private readonly base: TableSpec
  private wrap: HTMLElement | null = null
  private bar: HTMLElement | null = null
  private tableEl: HTMLTableElement | null = null
  private block: HTMLElement | null = null
  private plus: HTMLButtonElement | null = null
  private editing = false
  private active = { row: -1, col: 0 }
  /** 悬浮加号当前指向的插入点：列边界或行边界 */
  private hoverInsert: { kind: 'col' | 'row'; index: number } | null = null
  private rebuilding = false
  private detachOutside: (() => void) | null = null

  /** 保存表格的解析结果，供渲染、编辑及定位源码使用。 */
  constructor(readonly spec: TableSpec) {
    super()
    this.header = [...spec.header]
    this.rows = spec.rows.map((row) => [...row])
    this.aligns = [...spec.aligns]
    this.base = {
      ...spec,
      header: [...spec.header],
      rows: spec.rows.map((row) => [...row]),
      aligns: [...spec.aligns]
    }
  }

  /** 比较创建时的文档快照，而不是编辑中的缓冲区，避免输入过程中 DOM 被替换。 */
  override eq(other: WidgetType): boolean {
    if (!(other instanceof TableWidget)) return false
    const a = this.base
    const b = other.spec
    return (
      a.sourcePos === b.sourcePos &&
      a.sourceEnd === b.sourceEnd &&
      a.locked === b.locked &&
      JSON.stringify(a.header) === JSON.stringify(b.header) &&
      JSON.stringify(a.rows) === JSON.stringify(b.rows) &&
      JSON.stringify(a.aligns) === JSON.stringify(b.aligns)
    )
  }

  /** 构造阅读态表格，并挂上进入编辑态所需的工具条与键盘事件。 */
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-widget-table'
    wrap.title = this.spec.locked ? '页面已锁定' : '点击编辑表格'

    const bar = document.createElement('div')
    bar.className = 'table-editor-bar'
    bar.hidden = true
    // 工具条属于控件：拦下 mousedown，既不让 CodeMirror 抢事件，也不把焦点从输入框移走
    bar.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    bar.append(
      this.actionButton('insert-row', '插入行', () => this.mutate('insert-row')),
      this.actionButton('insert-col', '插入列', () => this.mutate('insert-col')),
      this.actionButton('delete-row', '删除行', () => this.mutate('delete-row')),
      this.actionButton('delete-col', '删除列', () => this.mutate('delete-col'))
    )
    const spacer = document.createElement('span')
    spacer.className = 'spacer'
    const source = this.actionButton('source', '源码', () => this.commit(view, true))
    source.classList.add('source')
    const done = this.actionButton('done', '完成', () => this.commit(view))
    done.classList.add('done')
    bar.append(spacer, source, done)

    const scroll = document.createElement('div')
    scroll.className = 'table-scroll'
    const table = document.createElement('table')
    const plus = document.createElement('button')
    plus.type = 'button'
    plus.className = 'table-insert'
    plus.textContent = '+'
    plus.hidden = true
    plus.setAttribute('aria-label', '在此处插入')
    // 加号是控件：按下时不抢走输入框焦点，也不把事件交给 CodeMirror
    plus.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    plus.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.insertAtPointer()
    })
    scroll.append(table)
    wrap.append(bar, scroll)

    // 阅读态点击表格：在捕获阶段就拦住，避免 CodeMirror 把光标移进表格块。
    // 只靠 WidgetType.ignoreEvent 在部分点击序列（双击、拖选）下仍可能漏给编辑器，
    // 一旦光标落进 block，即时渲染会立刻把整块切成源码。
    wrap.addEventListener(
      'mousedown',
      (event) => {
        if (this.editing || this.spec.locked) return
        event.preventDefault()
        event.stopPropagation()
        const cell = (event.target as HTMLElement).closest('th, td') as HTMLTableCellElement | null
        const parent = cell?.parentElement as HTMLTableRowElement | null
        const row = parent ? parent.rowIndex - 1 : -1
        this.active = { row: Math.max(-1, row), col: cell?.cellIndex ?? 0 }
        this.beginEdit(view)
      },
      true
    )
    wrap.addEventListener('focusout', (event) => this.onFocusOut(view, event))
    wrap.addEventListener('keydown', (event) => this.onKeydown(view, event))

    // 加号挂在卡片外层：阅读态被 overflow:hidden 裁掉，且要能悬停到表格边缘外侧
    const block = spacedBlock(wrap)
    block.classList.add('table-block')
    block.append(plus)
    block.addEventListener('mousemove', (event) => this.onHover(event))
    block.addEventListener('mouseleave', () => this.hidePlus())

    this.wrap = wrap
    this.bar = bar
    this.tableEl = table
    this.block = block
    this.plus = plus
    this.renderTable()
    return block
  }

  /** 组件被回收时清掉挂在 document 上的监听。 */
  override destroy(): void {
    this.detachOutside?.()
    this.detachOutside = null
    this.editing = false
    this.wrap = null
    this.bar = null
    this.tableEl = null
    this.block = null
    this.plus = null
  }

  /** 表格内部的点击与输入由自己处理，光标不落进表格源码。 */
  override ignoreEvent(): boolean {
    return true
  }

  private actionButton(action: string, label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = action
    button.textContent = label
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      run()
    })
    return button
  }

  /** 按当前模式重建表格 DOM，并同步工具条显隐与按钮可用状态。 */
  private renderTable(): void {
    const table = this.tableEl
    if (!table) return
    this.hidePlus()
    table.textContent = ''
    const thead = document.createElement('thead')
    thead.append(this.buildRow(-1, this.header, 'th'))
    table.append(thead)
    const tbody = document.createElement('tbody')
    this.rows.forEach((cells, index) => tbody.append(this.buildRow(index, cells, 'td')))
    table.append(tbody)
    if (this.bar) this.bar.hidden = !this.editing
    this.wrap?.classList.toggle('editing', this.editing)
    this.syncBar()
  }

  /** 阅读态渲染行内 Markdown，编辑态换成只保留原始文本的输入框。 */
  private buildRow(row: number, cells: string[], tag: 'th' | 'td'): HTMLTableRowElement {
    const tr = document.createElement('tr')
    cells.forEach((text, col) => {
      const cell = document.createElement(tag)
      cell.style.textAlign = this.aligns[col] ?? 'left'
      if (this.editing) {
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'cell-input'
        input.value = text
        input.dataset.cell = `${row}:${col}`
        input.setAttribute('aria-label', `${row === -1 ? '表头' : `第 ${row + 1} 行`}第 ${col + 1} 列`)
        cell.append(input)
      } else {
        cell.innerHTML = renderInlineMarkdown(text)
      }
      tr.append(cell)
    })
    return tr
  }

  private syncBar(): void {
    if (!this.bar) return
    const deleteRow = this.bar.querySelector<HTMLButtonElement>('[data-action="delete-row"]')
    const deleteCol = this.bar.querySelector<HTMLButtonElement>('[data-action="delete-col"]')
    if (deleteRow) deleteRow.disabled = this.active.row < 0 || !this.rows.length
    if (deleteCol) deleteCol.disabled = this.header.length <= 1
  }

  /** 鼠标靠近列/行间隙时，在间隙处浮出圆形加号，点一下就在该位置插入。 */
  private onHover(event: MouseEvent): void {
    if (!this.editing || !this.tableEl || !this.block || !this.plus) return
    const tableRect = this.tableEl.getBoundingClientRect()
    const blockRect = this.block.getBoundingClientRect()
    // 编辑器按 80%–140% 做 CSS zoom：rect 是缩放后的视口像素，
    // 而 style.left/top 用的是未缩放的布局像素，换算时要按宽高比还原
    const scale = this.block.offsetWidth ? blockRect.width / this.block.offsetWidth : 1
    const x = event.clientX
    const y = event.clientY
    const near = 6 * scale
    if (
      x < tableRect.left - near ||
      x > tableRect.right + near ||
      y < tableRect.top - near ||
      y > tableRect.bottom + near
    ) {
      this.hidePlus()
      return
    }

    // 列边界：首列左缘是「插到第 0 列」，之后每列右缘是「插到该列之后」
    const colHits: Array<{ index: number; x: number; distance: number }> = []
    this.tableEl.querySelectorAll('thead th').forEach((cell, index) => {
      const rect = cell.getBoundingClientRect()
      if (index === 0) colHits.push({ index: 0, x: rect.left, distance: Math.abs(x - rect.left) })
      colHits.push({ index: index + 1, x: rect.right, distance: Math.abs(x - rect.right) })
    })

    // 行边界：表头底缘是第 0 条数据行，每条数据行的底缘是它之后的位置
    const headRow = this.tableEl.querySelector('thead tr')
    const rowHits: Array<{ index: number; y: number; distance: number }> = []
    if (headRow) {
      const rect = headRow.getBoundingClientRect()
      rowHits.push({ index: 0, y: rect.bottom, distance: Math.abs(y - rect.bottom) })
    }
    this.tableEl.querySelectorAll('tbody tr').forEach((row, index) => {
      const rect = row.getBoundingClientRect()
      rowHits.push({ index: index + 1, y: rect.bottom, distance: Math.abs(y - rect.bottom) })
    })

    const limit = 7 * scale
    const colHit = colHits.sort((a, b) => a.distance - b.distance)[0]
    const rowHit = rowHits.sort((a, b) => a.distance - b.distance)[0]
    const useCol = Boolean(colHit && colHit.distance <= limit && (!rowHit || colHit.distance <= rowHit.distance))
    const useRow = Boolean(rowHit && rowHit.distance <= limit && !useCol)
    if (!useCol && !useRow) {
      this.hidePlus()
      return
    }

    if (useCol && colHit) {
      // 列：竖直间隙与表格上边缘的交叉点
      this.hoverInsert = { kind: 'col', index: colHit.index }
      this.plus.style.left = `${(colHit.x - blockRect.left) / scale - 8}px`
      this.plus.style.top = `${(tableRect.top - blockRect.top) / scale - 8}px`
      this.plus.title = '在此处插入列'
    } else if (rowHit) {
      // 行：表格左边缘与水平间隙的交叉点
      this.hoverInsert = { kind: 'row', index: rowHit.index }
      this.plus.style.left = `${(tableRect.left - blockRect.left) / scale - 8}px`
      this.plus.style.top = `${(rowHit.y - blockRect.top) / scale - 8}px`
      this.plus.title = '在此处插入行'
    }
    this.plus.hidden = false
  }

  private hidePlus(): void {
    this.hoverInsert = null
    if (this.plus) this.plus.hidden = true
  }

  /** 点击悬浮加号：按它当前的指向插入一行或一列。 */
  private insertAtPointer(): void {
    const target = this.hoverInsert
    this.hidePlus()
    if (!target) return
    this.mutate(target.kind === 'col' ? 'insert-col' : 'insert-row', target.index)
  }

  /** 从阅读态切换到编辑态，并监听组件外的按下事件以便回写。 */
  private beginEdit(view: EditorView): void {
    if (this.editing || this.spec.locked) return
    this.editing = true
    this.renderTable()
    window.requestAnimationFrame(() => this.focusCell(this.active.row, this.active.col))
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node | null
      // 加号挂在卡片外层，判定范围要用整个 block，否则点加号会被当成“点外面”先回写
      if (target && this.block?.contains(target)) return
      this.commit(view)
    }
    document.addEventListener('mousedown', handler, true)
    this.detachOutside = () => document.removeEventListener('mousedown', handler, true)
  }

  private onFocusOut(view: EditorView, event: FocusEvent): void {
    if (!this.editing || this.rebuilding) return
    const next = event.relatedTarget as Node | null
    if (next && this.wrap?.contains(next)) return
    this.commit(view)
  }

  private onKeydown(view: EditorView, event: KeyboardEvent): void {
    if (!this.editing) return
    const target = event.target as HTMLElement | null
    if (!target?.classList.contains('cell-input')) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.cancel()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      this.commit(view)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      this.moveCell(event.shiftKey ? -1 : 1, 0)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      this.moveCell(0, event.shiftKey ? -1 : 1)
    }
  }

  /** 按整张表的顺序移动焦点：Tab 横向循环，Enter 在同一列上下移动。 */
  private moveCell(rowDelta: number, colDelta: number): void {
    const columns = Math.max(1, this.header.length)
    const total = (this.rows.length + 1) * columns
    let index = (this.active.row + 1) * columns + this.active.col
    index += colDelta ? colDelta : rowDelta * columns
    index = Math.max(0, Math.min(total - 1, index))
    this.focusCell(Math.floor(index / columns) - 1, index % columns)
  }

  private focusCell(row: number, col: number): void {
    const input = this.wrap?.querySelector<HTMLInputElement>(`input[data-cell="${row}:${col}"]`)
    if (!input) return
    this.active = { row, col }
    input.focus()
    input.select()
    this.syncBar()
  }

  /** 把输入框里的值收回内存模型，供增删行列后重建不失内容。 */
  private capture(): void {
    if (!this.wrap) return
    for (const input of this.wrap.querySelectorAll<HTMLInputElement>('input[data-cell]')) {
      const [rowText, colText] = (input.dataset.cell ?? '-1:0').split(':')
      const row = Number(rowText)
      const col = Number(colText)
      if (row === -1) {
        if (col < this.header.length) this.header[col] = input.value
        continue
      }
      const cells = this.rows[row]
      if (cells && col < cells.length) cells[col] = input.value
    }
  }

  /** 在活动行下方插入一行；`at` 用于悬浮加号指定的精确插入位置。 */
  private mutate(
    action: 'insert-row' | 'insert-col' | 'delete-row' | 'delete-col',
    at?: number
  ): void {
    if (!this.editing) return
    this.capture()
    const { row, col } = this.active
    if (action === 'insert-row') {
      const index = Math.max(0, Math.min(this.rows.length, at ?? row + 1))
      this.rows.splice(index, 0, new Array(this.header.length).fill(''))
      this.active = { row: index, col }
    } else if (action === 'insert-col') {
      const index = Math.max(0, Math.min(this.header.length, at ?? col + 1))
      this.header.splice(index, 0, '')
      for (const cells of this.rows) cells.splice(index, 0, '')
      this.aligns.splice(index, 0, 'left')
      this.active = { row, col: index }
    } else if (action === 'delete-row') {
      if (row < 0 || row >= this.rows.length) return
      this.rows.splice(row, 1)
      this.active = { row: Math.min(row, this.rows.length - 1), col }
    } else {
      if (this.header.length <= 1) return
      this.header.splice(col, 1)
      for (const cells of this.rows) cells.splice(col, 1)
      this.aligns.splice(col, 1)
      this.active = { row, col: Math.min(col, this.header.length - 1) }
    }
    // 重建 DOM 时焦点会短暂丢失，先标记避免触发回写，重建后立刻交还焦点
    this.rebuilding = true
    this.renderTable()
    window.requestAnimationFrame(() => {
      this.focusCell(this.active.row, this.active.col)
      this.rebuilding = false
    })
  }

  /** 回写表格；`toSource` 为真时把光标放到表格起点，方便继续改源码。 */
  private commit(view: EditorView, toSource = false): void {
    if (!this.editing) return
    this.capture()
    const markdown = serializeTable(this.header, this.rows, this.aligns)
    this.editing = false
    this.detachOutside?.()
    this.detachOutside = null
    const from = this.spec.sourcePos
    const to = this.spec.sourceEnd
    const unchanged = view.state.doc.sliceString(from, to) === markdown
    if (unchanged) {
      this.renderTable()
      if (toSource) {
        view.dispatch({ selection: EditorSelection.cursor(Math.min(from, view.state.doc.length)) })
        view.focus()
      }
      return
    }
    view.dispatch({
      changes: { from, to, insert: markdown },
      ...(toSource ? { selection: EditorSelection.cursor(from) } : {})
    })
    if (toSource) view.focus()
  }

  /** 放弃本次编辑，恢复到进入编辑前的表格内容。 */
  private cancel(): void {
    if (!this.editing) return
    this.editing = false
    this.detachOutside?.()
    this.detachOutside = null
    this.header = [...this.base.header]
    this.rows = this.base.rows.map((row) => [...row])
    this.aligns = [...this.base.aligns]
    this.renderTable()
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
