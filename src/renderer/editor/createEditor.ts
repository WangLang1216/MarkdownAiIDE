/**
 * CodeMirror 6 编辑器控制器：单文档状态、三种模式共用撤销栈、事务化应用与查找替换。
 * 文档文本是唯一事实来源，实时渲染只是装饰层。
 */

import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  lineNumbers,
  placeholder,
  scrollPastEnd,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import { GFM } from '@lezer/markdown'
import { HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery
} from '@codemirror/search'
import { ViewPlugin } from '@codemirror/view'
import type { EditorMode } from '../types'
import type { EditorCallbacks, EditorFacade } from '../lib/editorApi'
import { splitParagraphs } from '@shared/markdown/paragraphs'
import { livePreviewExtension, liveRefreshEffect } from './livePreview'
import { slashMenu } from './slashMenu'
import { pickCodeLanguage } from './codeLanguageMenu'
import { detectCodeLanguage } from './codeLanguage'
import { searchHighlight } from './searchHighlight'
import { acceptGhost, clearGhost, getGhost, ghostField, ghostKeymap, showGhost } from './ghost'
import { snippetById } from './snippets'

/** 描述创建编辑器时的文稿标识、显示模式和编辑偏好。 */
export interface EditorOptions {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 初始编辑模式，决定是否显示实时预览装饰。 */
  mode: EditorMode
  /** 控制公式、图表或页面使用深色渲染模式。 */
  dark: boolean
  /** 控制该渲染场景是否加载远程图片。 */
  loadRemoteImages: boolean
  /** 决定编辑器是否显示行号栏。 */
  lineNumbers: boolean
  /** 决定编辑时是否启用打字机滚动。 */
  typewriter: boolean
  /** 决定编辑输入是否启用拼写检查。 */
  spellcheck: boolean
  /** 限制主题 CSS 生效的文稿容器标识。 */
  themeScope: string | null
  /** 锁定页面时只读，且实时渲染不再因点击回到源码。 */
  locked: boolean
}

/** 上次使用的代码块语言，未设置时按纯文本处理 */
const CODE_LANGUAGE_KEY = 'moye.codeLanguage'

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '650', color: 'var(--accent)' },
  {
    tag: [tags.heading2, tags.heading3],
    fontWeight: '600',
    color: 'color-mix(in srgb, var(--accent) 80%, var(--text))'
  },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '600', color: 'var(--soft)' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--link)', textDecorationColor: 'color-mix(in srgb, var(--link) 40%, transparent)', textDecoration: 'underline' },
  { tag: [tags.monospace], color: 'color-mix(in srgb, var(--accent) 70%, var(--text))' },
  { tag: [tags.comment, tags.quote], color: 'var(--muted)' },
  { tag: tags.processingInstruction, color: 'var(--muted)' },
  { tag: tags.contentSeparator, color: 'var(--muted)' }
])

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--page)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--article-font)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-gutters': { backgroundColor: 'var(--page)', color: 'var(--muted)', border: 'none' }
})

const flashSection = StateEffect.define<{ from: number; to: number } | null>()
const sectionFlash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = Decoration.none
    for (const effect of transaction.effects) {
      if (!effect.is(flashSection)) continue
      const range = effect.value
      if (!range) {
        value = Decoration.none
        continue
      }
      const doc = transaction.state.doc
      const first = doc.lineAt(range.from).number
      const last = doc.lineAt(Math.max(range.from, range.to - 1)).number
      const lines = []
      for (let number = first; number <= last; number++) {
        lines.push(Decoration.line({ class: 'cm-outline-flash' }).range(doc.line(number).from))
      }
      value = Decoration.set(lines)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field)
})

function endHeading(view: EditorView): boolean {
  const { state } = view
  if (view.composing || state.readOnly || state.selection.ranges.length !== 1) return false
  const range = state.selection.main
  const line = state.doc.lineAt(range.head)
  if (!range.empty || range.head !== line.to) return false
  let node = syntaxTree(state).resolveInner(line.to, -1)
  while (node.parent && !/^ATXHeading[1-6]$/.test(node.name)) node = node.parent
  if (!/^ATXHeading[1-6]$/.test(node.name) || node.from !== line.from) return false
  view.dispatch(state.replaceSelection('\n\n'), { scrollIntoView: true, userEvent: 'input' })
  return true
}

function typewriterExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate): void {
        if (!update.selectionSet || update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(flashSection)))) return
        const head = update.state.selection.main.head
        window.requestAnimationFrame(() => {
          if (!this.view.dom.isConnected) return
          if (this.view.state.selection.main.head !== head) return
          this.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) })
        })
      }
    }
  )
}

/** 封装 CodeMirror 编辑视图、命令、预览模式和续写候选。 */
export class EditorController implements EditorFacade {
  /** 底层 CodeMirror 视图，用于读取状态及派发编辑事务。 */
  readonly view: EditorView
  private mode: EditorMode
  private documentId: string | null
  private dark: boolean
  private loadRemote: boolean
  private lineNumbersVisible: boolean
  private typewriter: boolean
  private spellcheck: boolean
  private themeScope: string | null
  private locked: boolean
  private readonly modeCompartment = new Compartment()
  private readonly selectionCompartment = new Compartment()
  private readonly attrCompartment = new Compartment()
  private readonly typewriterCompartment = new Compartment()
  private readonly editableCompartment = new Compartment()
  private readonly callbacks: EditorCallbacks
  private readonly scrollListener: () => void
  /** 锁定期间临时摘下的 CodeMirror 选区观察器，避免它把原生选区改写回光标 */
  private selectionObserver: ((event: Event) => void) | null = null
  private suppressChange = false
  private outlineTimer = 0
  /** 每个文稿离开时的光标与滚动位置，切回标签时据此恢复 */
  private readonly viewStates = new Map<string, { anchor: number; head: number; scrollTop: number }>()

  /** 创建 CodeMirror 视图，安装编辑扩展及宿主回调。 */
  constructor(parent: HTMLElement, options: EditorOptions, callbacks: EditorCallbacks) {
    this.callbacks = callbacks
    this.mode = options.mode
    this.documentId = options.documentId
    this.dark = options.dark
    this.loadRemote = options.loadRemoteImages
    this.lineNumbersVisible = options.lineNumbers
    this.typewriter = options.typewriter
    this.spellcheck = options.spellcheck
    this.themeScope = options.themeScope
    this.locked = options.locked
    this.view = new EditorView({
      state: EditorState.create({ doc: '', extensions: this.buildExtensions(this.spellcheck) }),
      parent
    })
    this.scrollListener = () => this.callbacks.onScroll(this.getScrollRatio())
    this.view.scrollDOM.addEventListener('scroll', this.scrollListener, { passive: true })
    // 若创建时就处于锁定态（例如恢复会话），同样让出原生选区
    if (this.locked) this.detachSelectionObserver()
  }

  private buildExtensions(spellcheck: boolean): Extension[] {
    const isLocked = (): boolean => this.locked
    return [
      history(),
      sectionFlash,
      scrollPastEnd(),
      // 锁定态改用浏览器原生选区：自绘选区会隐藏并重写 DOM 选区，导致无法选中复制
      this.selectionCompartment.of(this.locked ? [] : drawSelection()),
      dropCursor(),
      indentOnInput(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, extensions: [GFM] }),
      keymap.of([{ key: 'Enter', run: endHeading }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      search({ top: false }),
      searchHighlight,
      ghostField,
      ghostKeymap,
      placeholder('从这里开始书写，或让 AI 帮你整理想法…'),
      editorTheme,
      this.attrCompartment.of(
        EditorView.contentAttributes.of({
          spellcheck: spellcheck ? 'true' : 'false',
          'aria-label': 'Markdown 编辑区',
          ...(this.themeScope ? { 'data-doc-theme': this.themeScope } : {})
        })
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.suppressChange) {
          this.callbacks.onTextChange(update.state.doc.toString())
        }
        if (update.docChanged || update.selectionSet) {
          const selection = update.state.selection.main
          const line = update.state.doc.lineAt(selection.head)
          this.callbacks.onSelection(
            { from: selection.from, to: selection.to },
            line.number,
            line.text,
            update.docChanged
          )
        }
      }),
      this.modeCompartment.of(this.modeExtensions()),
      this.typewriterCompartment.of(this.typewriter ? typewriterExtension() : []),
      this.editableCompartment.of([
        EditorView.editable.of(!this.locked),
        EditorState.readOnly.of(this.locked)
      ]),
      EditorView.domEventHandlers({
        click(event) {
          if (isLocked()) return false
          const target = (event.target as HTMLElement | null)?.closest('.cm-md-link') as HTMLElement | null
          if (!target) return false
          if (!(event.ctrlKey || event.metaKey)) return false
          const href = target.dataset.href
          if (href && /^https?:\/\//i.test(href)) {
            event.preventDefault()
            void window.api.app.openExternal(href)
            return true
          }
          return false
        }
      })
    ]
  }

  private modeExtensions(): Extension[] {
    if (this.mode === 'live') {
      return [
        livePreviewExtension({
          documentId: () => this.documentId,
          loadRemoteImages: () => this.loadRemote,
          dark: () => this.dark,
          locked: () => this.locked
        }),
        slashMenu({ onPick: (id, range) => this.insertSnippetAt(id, range) })
      ]
    }
    return [
      syntaxHighlighting(markdownHighlight),
      ...(this.lineNumbersVisible ? [lineNumbers()] : []),
      EditorView.theme({
        '.cm-scroller': { fontFamily: 'var(--mono-font)' },
        '.cm-content': { fontFamily: 'var(--mono-font)' }
      })
    ]
  }

  private refreshLive(): void {
    if (this.mode !== 'live') return
    this.view.dispatch({ effects: liveRefreshEffect.of(null) })
  }

  /** 记下当前文稿的光标与滚动位置，供下次切回时恢复 */
  private rememberViewState(): void {
    if (!this.documentId) return
    const range = this.view.state.selection.main
    this.viewStates.set(this.documentId, {
      anchor: range.anchor,
      head: range.head,
      scrollTop: this.view.scrollDOM.scrollTop
    })
  }

  /**
   * 换文档后行高还没量完就赋值可能被夹回顶部，所以先直接写一次拿到即时效果，
   * 等 CodeMirror 量完高度再对齐一次（切走后不再回写，避免和用户滚动打架）。
   */
  private restoreScroll(top: number): void {
    const documentId = this.documentId
    this.view.scrollDOM.scrollTop = top
    this.view.requestMeasure<number>({
      read: () => top,
      write: (value) => {
        if (this.documentId !== documentId) return
        this.view.scrollDOM.scrollTop = value
      }
    })
  }

  /** 加载指定文稿正文并切换编辑器的文稿上下文。 */
  loadDocument(text: string, documentId: string | null): void {
    this.rememberViewState()
    this.documentId = documentId
    this.suppressChange = true
    try {
      this.view.setState(EditorState.create({ doc: text, extensions: this.buildExtensions(this.spellcheck) }))
    } finally {
      this.suppressChange = false
    }
    const max = this.view.state.doc.length
    const saved = documentId ? this.viewStates.get(documentId) : undefined
    if (saved) {
      // 切回打开过的文稿：回到上次的光标与滚动位置
      this.view.dispatch({
        selection: {
          anchor: Math.min(saved.anchor, max),
          head: Math.min(saved.head, max)
        }
      })
      this.restoreScroll(saved.scrollTop)
      return
    }
    // 首次打开：把光标放在首行之后，避免标题标记因"光标所在行"而暴露
    const anchor =
      this.view.state.doc.lines > 1
        ? Math.min(this.view.state.doc.line(1).to + 1, max)
        : 0
    this.view.dispatch({ selection: { anchor } })
    this.restoreScroll(0)
  }

  /** 更新编辑器当前文稿标识，供预览图片解析使用。 */
  setDocumentId(documentId: string | null): void {
    this.documentId = documentId
    this.refreshLive()
  }

  /** 读取当前编辑缓冲区的完整 Markdown。 */
  getText(): string {
    return this.view.state.doc.toString()
  }

  /** 读取主选区的起止偏移。 */
  getSelection(): { from: number; to: number } {
    const range = this.view.state.selection.main
    return { from: range.from, to: range.to }
  }

  /** 外部载入（如磁盘冲突重载）：重置状态以清空旧撤销栈 */
  setText(text: string): void {
    if (text === this.getText()) return
    const head = Math.min(this.view.state.selection.main.head, text.length)
    const scrollTop = this.view.scrollDOM.scrollTop
    this.suppressChange = true
    try {
      this.view.setState(EditorState.create({ doc: text, extensions: this.buildExtensions(this.spellcheck) }))
    } finally {
      this.suppressChange = false
    }
    this.view.dispatch({ selection: { anchor: head } })
    // 整体替换正文时保持当前阅读位置，不要跳回顶部
    this.restoreScroll(scrollTop)
  }

  /** 按编辑前坐标批量应用源码编辑，并按需要定位变更区间。 */
  applyEdits(
    edits: Array<{ from: number; to: number; insert: string }>,
    reveal?: { from: number; to: number }
  ): void {
    const changes = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
    let revealOffset = reveal?.from ?? null
    if (revealOffset !== null) {
      for (const edit of changes) {
        if (edit.to <= revealOffset) revealOffset += edit.insert.length - (edit.to - edit.from)
      }
    }
    this.view.dispatch({
      changes,
      ...(revealOffset !== null
        ? { effects: EditorView.scrollIntoView(revealOffset, { y: 'center' }), scrollIntoView: false }
        : {})
    })
  }

  private buildInsertion(block: string): {
    change: { from: number; to: number; insert: string }
    bodyOffset: number
  } {
    const range = this.view.state.selection.main
    const doc = this.view.state.doc
    const before = doc.sliceString(0, range.from)
    const after = doc.sliceString(range.to)
    const body = block.replace(/^\n+/, '').replace(/\n+$/, '')
    const lead =
      before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    const trail =
      after.length === 0 ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    return {
      change: { from: range.from, to: range.to, insert: `${lead}${body}${trail}` },
      bodyOffset: lead.length
    }
  }

  /** 斜杠菜单选中元素：先删掉 `/关键字`，再按现有 snippet 流程插入 */
  private insertSnippetAt(id: string, range: { from: number; to: number }): void {
    if (this.locked) return
    const max = this.view.state.doc.length
    const from = Math.max(0, Math.min(range.from, max))
    const to = Math.max(from, Math.min(range.to, max))
    this.view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } })
    this.insertSnippet(id)
  }

  /** 弹语言选择层，确认后再把围栏写进正文 */
  private pickCodeLanguageThenInsert(): void {
    const { from, to } = this.getSelection()
    const selected = this.view.state.doc.sliceString(from, to)
    const detected = selected.trim() ? detectCodeLanguage(selected) : null
    pickCodeLanguage({
      view: this.view,
      anchor: to,
      detected,
      current: window.localStorage.getItem(CODE_LANGUAGE_KEY) ?? 'txt',
      onPick: (language) => {
        window.localStorage.setItem(CODE_LANGUAGE_KEY, language)
        this.insertCodeFence(language, selected, from, to)
      }
    })
  }

  /** 用选定语言把选区（或插入点）包成围栏代码块；空块把光标留在中间那一行 */
  private insertCodeFence(language: string, selected: string, from: number, to: number): void {
    if (this.locked) return
    const doc = this.view.state.doc
    const start = Math.max(0, Math.min(from, doc.length))
    const end = Math.max(start, Math.min(to, doc.length))
    const hasContent = Boolean(selected.trim())
    const body = hasContent ? `\`\`\`${language}\n${selected}\n\`\`\`` : `\`\`\`${language}\n\n\`\`\``
    const before = doc.sliceString(0, start)
    const after = doc.sliceString(end)
    const lead = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    const trail = after.length === 0 ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    const caret = hasContent
      ? start + lead.length + body.length
      : start + lead.length + 3 + language.length + 1
    this.view.dispatch({
      changes: { from: start, to: end, insert: `${lead}${body}${trail}` },
      selection: { anchor: caret },
      scrollIntoView: true
    })
    this.view.focus()
  }

  /** 插入元素片段；标题等带占位文字的片段会直接选中占位文字，方便一键替换或删除 */
  insertSnippet(elementId: string): boolean {
    if (this.locked) return false
    const snippet = snippetById(elementId)
    if (!snippet || !snippet.markdown) return false
    // 代码块先确认语言：有选区时给出自动识别结果，没有选区时沿用上次用过的语言
    if (elementId === 'code') {
      this.pickCodeLanguageThenInsert()
      return true
    }
    const { from, to } = this.getSelection()
    const selected = this.view.state.doc.sliceString(from, to)
    if (selected && elementId === 'link') {
      this.wrapLink()
      return true
    }
    const wrappers: Record<string, [string, string]> = {
      mark: ['==', '=='], sup: ['^', '^'], sub: ['~', '~'], strike: ['~~', '~~'],
      underline: ['<u>', '</u>'], 'anchor-link': ['[', '](#section-id)'],
      footnote: ['', '[^1]\n\n[^1]: 在这里写脚注内容。']
    }
    const markers = wrappers[elementId]
    if (selected && markers) {
      this.wrapWith(markers[0], markers[1])
      return true
    }
    if (this.formatParagraphs(elementId)) return true
    if (selected) {
      const block = elementId === 'code' || elementId === 'mermaid'
        ? `\`\`\`${elementId === 'mermaid' ? 'mermaid' : ''}\n${selected}\n\`\`\``
        : elementId === 'math' ? `$$\n${selected}\n$$`
          : elementId === 'deflist' ? `${selected}\n: 定义内容`
            : `${selected}\n\n${snippet.markdown}`
      const { change } = this.buildInsertion(block)
      this.replaceRange(change.from, change.to, change.insert)
      return true
    }
    const { change, bodyOffset } = this.buildInsertion(snippet.markdown)
    const selection = snippet.select
      ? {
          anchor: change.from + bodyOffset + snippet.select.from,
          head: change.from + bodyOffset + snippet.select.to
        }
      : {
          anchor: Math.max(change.from, change.from + change.insert.length - (snippet.cursorBack ?? 0))
        }
    this.view.dispatch({ changes: change, selection, scrollIntoView: true })
    // 表情插入后把源码区间交给宿主，就地弹出可搜索、可切换的表情面板
    if (elementId === 'emoji') {
      const from = change.from + bodyOffset
      this.callbacks.onEmojiInserted?.({ from, to: from + snippet.markdown.length })
    }
    this.view.focus()
    return true
  }

  private formatParagraphs(id: string): boolean {
    if (!/^(h[123]|heading-id|paragraph|quote|callout|list|ordered|tasks)$/.test(id)) return false
    const { doc } = this.view.state
    const { from, to } = this.getSelection()
    const start = doc.lineAt(from)
    const end = doc.lineAt(from === to ? to : to - 1)
    // 段落边界取文本里的回车，而不是可视行：自动折行的长段落仍是一段。
    // 范围只到选区覆盖到的最后一行，不会把下面的段落一起吸进来。
    const selected = doc.sliceString(doc.line(start.number).from, doc.line(end.number).to)
    const paragraphs = splitParagraphs(selected)
    if (!paragraphs.length) return false
    const prefixes: Record<string, string> = {
      h1: '# ', h2: '## ', h3: '### ', 'heading-id': '## ', quote: '> ',
      callout: '> 提示：', list: '- ', tasks: '- [ ] '
    }
    const body = paragraphs.map((content, index) => {
      const prefix = id === 'ordered' ? `${index + 1}. ` : (prefixes[id] ?? '')
      const suffix = id === 'heading-id' ? ` {#section-${start.number + index}}` : ''
      return prefix + content + suffix
    }).join(/^(list|ordered|tasks)$/.test(id) ? '\n' : '\n\n')
    const begin = doc.line(start.number).from
    const finish = doc.line(end.number).to
    this.view.dispatch({
      changes: { from: begin, to: finish, insert: body },
      selection: from === to ? { anchor: begin + body.length } : { anchor: begin, head: begin + body.length },
      scrollIntoView: true
    })
    this.view.focus()
    return true
  }

  /** 用新内容替换指定源码区间，并把光标放到替换后的末尾。 */
  replaceRange(from: number, to: number, insert: string): void {
    if (this.locked) return
    const max = this.view.state.doc.length
    const start = Math.max(0, Math.min(from, max))
    const end = Math.max(start, Math.min(to, max))
    this.view.dispatch({
      changes: { from: start, to: end, insert },
      selection: { anchor: start + insert.length },
      scrollIntoView: true
    })
    this.view.focus()
  }

  /** 用给定纯文本替换当前选区。 */
  insertText(text: string): void {
    if (this.locked) return
    const range = this.view.state.selection.main
    this.view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + text.length },
      scrollIntoView: true
    })
  }

  /** 在选区前后包裹 Markdown 标记。 */
  wrapSelection(kind: 'bold' | 'italic' | 'code' | 'strike' | 'underline' | 'mark'): void {
    if (this.locked) return
    const markers: Record<typeof kind, [string, string]> = {
      bold: ['**', '**'],
      italic: ['*', '*'],
      code: ['`', '`'],
      strike: ['~~', '~~'],
      underline: ['<u>', '</u>'],
      mark: ['==', '==']
    }
    const [open, close] = markers[kind]
    this.wrapWith(open, close)
  }

  private wrapWith(open: string, close: string): void {
    const { from, to } = this.getSelection()
    const selected = this.view.state.doc.sliceString(from, to)
    if (selected) {
      this.view.dispatch({
        changes: { from, to, insert: `${open}${selected}${close}` },
        selection: { anchor: from + open.length, head: to + open.length }
      })
    } else {
      this.view.dispatch({
        changes: { from, insert: `${open}${close}` },
        selection: { anchor: from + open.length }
      })
    }
    this.view.focus()
  }

  /** 把选区包成链接；有选中文字时选中 URL 占位，可直接覆盖 */
  wrapLink(): void {
    if (this.locked) return
    const { from, to } = this.getSelection()
    const selected = this.view.state.doc.sliceString(from, to)
    const text = selected || '链接文字'
    const href = 'https://'
    const insert = `[${text}](${href})`
    const hrefFrom = from + text.length + 3
    this.view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: hrefFrom, head: hrefFrom + href.length }
    })
    this.view.focus()
  }

  /** 清除选区的行内标记；只处理成对包裹与选区内部的常见标记 */
  clearInlineFormat(): void {
    if (this.locked) return
    const { from, to } = this.getSelection()
    if (from === to) return
    const doc = this.view.state.doc
    let start = from
    let end = to
    const pairs: Array<[string, string]> = [
      ['**', '**'],
      ['~~', '~~'],
      ['==', '=='],
      ['<u>', '</u>'],
      ['*', '*'],
      ['`', '`']
    ]
    for (const [open, close] of pairs) {
      const before = doc.sliceString(Math.max(0, start - open.length), start)
      const after = doc.sliceString(end, Math.min(doc.length, end + close.length))
      if (before === open && after === close) {
        start -= open.length
        end += close.length
        break
      }
    }
    const raw = doc.sliceString(start, end)
    const cleaned = raw
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/==(.+?)==/g, '$1')
      .replace(/<u>(.+?)<\/u>/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
    this.view.dispatch({
      changes: { from: start, to: end, insert: cleaned },
      selection: { anchor: start, head: start + cleaned.length }
    })
    this.view.focus()
  }

  /** 撤销最近一次可撤销的编辑事务。 */
  undo(): boolean {
    if (this.locked) return false
    return undo(this.view)
  }

  /** 重做最近一次撤销的编辑事务。 */
  redo(): boolean {
    if (this.locked) return false
    return redo(this.view)
  }

  /** 选择整个文稿的正文。 */
  selectAll(): void {
    this.view.dispatch({ selection: { anchor: 0, head: this.view.state.doc.length } })
  }

  /** 将主选区移动到指定源码偏移范围。 */
  setSelection(from: number, to: number): void {
    const max = this.view.state.doc.length
    const anchor = Math.max(0, Math.min(from, max))
    const head = Math.max(0, Math.min(to, max))
    this.view.dispatch({ selection: { anchor, head } })
  }

  /** 将键盘焦点交给当前编辑器视图。 */
  focus(): void {
    this.view.focus()
  }

  /** 滚动到指定源码范围并在编辑器中定位。 */
  revealOffset(offset: number, sectionEnd?: number): void {
    const target = Math.max(0, Math.min(offset, this.view.state.doc.length))
    if (sectionEnd === undefined) {
      this.view.dispatch({ selection: { anchor: target }, scrollIntoView: true })
      this.view.focus()
      return
    }
    window.clearTimeout(this.outlineTimer)
    this.view.dispatch({ effects: flashSection.of(null) })
    this.view.dispatch({
      ...(this.locked ? {} : { selection: { anchor: target } }),
      effects: [
        EditorView.scrollIntoView(target, { y: 'start', yMargin: 12 }),
        flashSection.of({ from: target, to: Math.min(this.view.state.doc.length, sectionEnd) })
      ]
    })
    this.outlineTimer = window.setTimeout(() => this.view.dispatch({ effects: flashSection.of(null) }), 1000)
  }

  /** 更新查找词、替换词及查找选项。 */
  setSearch(query: string, caseSensitive: boolean, replacement: string): void {
    this.view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query,
          caseSensitive,
          replace: replacement,
          literal: true,
          regexp: false
        })
      )
    })
  }

  /** 按指定方向跳转到下一个查找匹配项。 */
  findNext(backwards = false): void {
    if (backwards) findPrevious(this.view)
    else findNext(this.view)
  }

  /** 替换当前查找命中项。 */
  replaceCurrent(): boolean {
    if (this.locked) return false
    return replaceNext(this.view)
  }

  /** 替换当前查找条件的全部匹配项。 */
  replaceAllMatches(): number {
    if (this.locked) return 0
    const total = this.searchCounts().total
    replaceAll(this.view)
    return total
  }

  /** 返回当前匹配项的位置和总命中数。 */
  searchCounts(): { index: number; total: number } {
    const query = getSearchQuery(this.view.state)
    if (!query.search) return { index: 0, total: 0 }
    const head = this.view.state.selection.main.head
    let total = 0
    let index = 0
    const cursor = query.getCursor(this.view.state)
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      total += 1
      if (next.value.from <= head) index = total
    }
    return { index, total }
  }

  /** 读取编辑器在可滚动范围内的位置比例。 */
  getScrollRatio(): number {
    const scroller = this.view.scrollDOM
    const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight)
    return Math.min(1, Math.max(0, scroller.scrollTop / max))
  }

  /** 按比例设置编辑器滚动位置，用于分屏同步。 */
  setScrollRatio(ratio: number): void {
    const scroller = this.view.scrollDOM
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = max * Math.min(1, Math.max(0, ratio))
  }

  /** 在指定偏移显示不写入正文的续写候选。 */
  showGhost(text: string): void {
    showGhost(this.view, text)
  }

  /** 清除当前续写候选而不改写正文。 */
  clearGhost(): void {
    clearGhost(this.view)
  }

  /** 检查编辑器是否存在可接受的续写候选。 */
  hasGhost(): boolean {
    return Boolean(getGhost(this.view))
  }

  /** 接受当前续写候选并报告是否已插入正文。 */
  acceptGhost(): boolean {
    return acceptGhost(this.view)
  }

  /** 检查编辑器是否处于输入法组合输入阶段。 */
  isComposing(): boolean {
    return this.view.composing
  }

  /** 切换编辑显示模式并更新相应的预览扩展。 */
  setMode(mode: EditorMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.view.dispatch({ effects: this.modeCompartment.reconfigure(this.modeExtensions()) })
  }

  /** 更新预览和图表所使用的配色模式。 */
  setDark(dark: boolean): void {
    if (this.dark === dark) return
    this.dark = dark
    this.refreshLive()
  }

  /** 更新编辑器实时预览中的远程图片加载偏好。 */
  setLoadRemoteImages(value: boolean): void {
    if (this.loadRemote === value) return
    this.loadRemote = value
    this.refreshLive()
  }

  /** 更新编辑器输入相关的 DOM 属性。 */
  setTextAttributes(scope: string | null): void {
    if (this.themeScope === scope) return
    this.themeScope = scope
    this.view.dispatch({
      effects: this.attrCompartment.reconfigure(
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          'aria-label': 'Markdown 编辑区',
          ...(scope ? { 'data-doc-theme': scope } : {})
        })
      )
    })
    this.refreshLive()
  }

  /** 控制编辑器行号栏是否可见。 */
  setLineNumbers(visible: boolean): void {
    if (this.lineNumbersVisible === visible) return
    this.lineNumbersVisible = visible
    if (this.mode !== 'live') {
      this.view.dispatch({ effects: this.modeCompartment.reconfigure(this.modeExtensions()) })
    }
  }

  /** 切换打字机滚动行为。 */
  setTypewriter(enabled: boolean): void {
    if (this.typewriter === enabled) return
    this.typewriter = enabled
    this.view.dispatch({
      effects: this.typewriterCompartment.reconfigure(enabled ? typewriterExtension() : [])
    })
  }

  /** 切换当前编辑器是否允许编辑。 */
  setEditable(editable: boolean): void {
    this.view.dispatch({
      effects: this.editableCompartment.reconfigure([
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable)
      ])
    })
  }

  /**
   * 锁定页面：只读且保持渲染形态。
   * 锁定时实时渲染不再按光标/选区回退到源码，Widget 的“点击进入源码”也会禁用。
   */
  setLocked(locked: boolean): void {
    if (this.locked === locked) return
    this.locked = locked
    this.setEditable(!locked)
    this.view.dispatch({
      effects: this.selectionCompartment.reconfigure(locked ? [] : drawSelection())
    })
    if (locked) {
      this.detachSelectionObserver()
    } else {
      this.attachSelectionObserver()
      window.getSelection()?.removeAllRanges()
    }
    this.refreshLive()
  }

  /** 锁定态摘掉 CodeMirror 的 selectionchange 观察器，让浏览器原生选区得以保留 */
  private detachSelectionObserver(): void {
    const observer = (
      this.view as unknown as { observer?: { onSelectionChange?: (event: Event) => void } }
    ).observer
    const handler = observer?.onSelectionChange
    if (!handler) return
    this.selectionObserver = handler
    document.removeEventListener('selectionchange', handler)
  }

  private attachSelectionObserver(): void {
    if (!this.selectionObserver) return
    document.addEventListener('selectionchange', this.selectionObserver)
    this.selectionObserver = null
  }

  /** 销毁 CodeMirror 视图并释放其监听和资源。 */
  destroy(): void {
    window.clearTimeout(this.outlineTimer)
    this.view.scrollDOM.removeEventListener('scroll', this.scrollListener)
    this.view.destroy()
  }
}

/** 重导出 CodeMirror 装饰构造器供编辑模块使用。 */
export { Decoration }
