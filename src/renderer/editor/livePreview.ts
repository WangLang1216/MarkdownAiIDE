/**
 * 实时渲染装饰：把 Markdown 源码排版成接近成稿的视觉，但不改变文档文本。
 * 光标所在行/块显示源码以便编辑；离开后显示标题、表格、图片、公式与图表。
 *
 * 注意：CodeMirror 6 规定 block 级替换装饰必须由 StateField 提供，
 * 因此表格/代码块/公式/图表等整块 Widget 放在 StateField 中，
 * 行内标记与行样式仍由 ViewPlugin 按可视区域计算。
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
  type WidgetType
} from '@codemirror/view'
import { EditorSelection, StateEffect, StateField, type EditorState, type Range, type Text } from '@codemirror/state'
import { definitionPrefixLength, findHeadingId, isTocLine, parseHeadingLine } from '@shared/markdown/extended'
import { emojiFor } from '../lib/emoji'
import {
  CodeBlockWidget,
  EmojiWidget,
  HrWidget,
  ImageWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  TaskCheckboxWidget,
  TocWidget,
  type TableSpec,
  type TocEntry
} from './widgets'

/** 触发实时预览装饰的重新计算，无需修改源码。 */
export const liveRefreshEffect = StateEffect.define<null>()

type BlockType =
  | 'text'
  | 'heading'
  | 'quote'
  | 'list'
  | 'task'
  | 'fence'
  | 'table'
  | 'hr'
  | 'frontmatter'
  | 'math'
  | 'deflist'

interface LiveBlock {
  type: BlockType
  fromLine: number
  toLine: number
  level?: number
  lang?: string
  prefixLength?: number
  markerPos?: number
  markerStart?: number
  markerLength?: number
  ordered?: boolean
  checked?: boolean
}

interface BlockIndex {
  blocks: LiveBlock[]
  byLine: Array<LiveBlock | null>
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>[ \t]?/
const LIST = /^(\s*)([-*+]|\d+[.)])[ \t]+/
const IMAGE_ONLY = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/

function buildIndex(doc: Text): BlockIndex {
  const byLine: Array<LiveBlock | null> = new Array(doc.lines + 1).fill(null)
  const blocks: LiveBlock[] = []

  const register = (block: LiveBlock): void => {
    blocks.push(block)
    for (let line = block.fromLine; line <= block.toLine; line += 1) byLine[line] = block
  }

  let lineNo = 1
  if (doc.lines > 1 && doc.line(1).text.trim() === '---') {
    for (let line = 2; line <= Math.min(doc.lines, 60); line += 1) {
      const value = doc.line(line).text.trim()
      if (value === '---' || value === '...') {
        register({ type: 'frontmatter', fromLine: 1, toLine: line })
        lineNo = line + 1
        break
      }
    }
  }

  while (lineNo <= doc.lines) {
    const line = doc.line(lineNo)
    const text = line.text

    const fence = FENCE.exec(text)
    if (fence) {
      const marker = fence[1]
      let closing = doc.lines
      for (let next = lineNo + 1; next <= doc.lines; next += 1) {
        const candidate = doc.line(next).text.trim()
        if (
          /^(`{3,}|~{3,})$/.test(candidate) &&
          candidate[0] === marker[0] &&
          candidate.length >= marker.length
        ) {
          closing = next
          break
        }
      }
      register({
        type: 'fence',
        fromLine: lineNo,
        toLine: closing,
        lang: fence[2].trim().split(/\s+/)[0] ?? ''
      })
      lineNo = closing + 1
      continue
    }

    if (text.trimStart().startsWith('$$')) {
      let closing = lineNo
      const firstContent = text.trimStart().slice(2)
      if (!(firstContent.trim().endsWith('$$') && firstContent.trim().length > 2)) {
        for (let next = lineNo + 1; next <= doc.lines; next += 1) {
          if (doc.line(next).text.trim().endsWith('$$')) {
            closing = next
            break
          }
        }
      }
      register({ type: 'math', fromLine: lineNo, toLine: closing })
      lineNo = closing + 1
      continue
    }

    if (text.trimStart().startsWith('|') && lineNo < doc.lines) {
      const nextLine = doc.line(lineNo + 1).text
      if (/^\s*\|?[\s:|-]+\|/.test(nextLine) && nextLine.includes('-')) {
        let closing = lineNo + 1
        while (
          closing < doc.lines &&
          doc
            .line(closing + 1)
            .text.trimStart()
            .startsWith('|')
        )
          closing += 1
        register({ type: 'table', fromLine: lineNo, toLine: closing })
        lineNo = closing + 1
        continue
      }
    }

    const heading = ATX.exec(text)
    if (heading) {
      const prefix = /^( {0,3}#{1,6}[ \t]+)/.exec(text)?.[1].length ?? heading[1].length
      register({
        type: 'heading',
        fromLine: lineNo,
        toLine: lineNo,
        level: heading[1].length,
        prefixLength: prefix
      })
      lineNo += 1
      continue
    }

    if (HR.test(text)) {
      register({ type: 'hr', fromLine: lineNo, toLine: lineNo })
      lineNo += 1
      continue
    }

    const quote = QUOTE.exec(text)
    if (quote) {
      register({ type: 'quote', fromLine: lineNo, toLine: lineNo, prefixLength: quote[0].length })
      lineNo += 1
      continue
    }

    const list = LIST.exec(text)
    if (list) {
      const markerStart = list[1].length
      const spacing = text.slice(markerStart + list[2].length).match(/^[ \t]+/)?.[0].length ?? 0
      const markerEnd = markerStart + list[2].length + spacing
      const taskMatch = /^\[([ xX])\](?=[ \t])/.exec(text.slice(markerEnd))
      if (taskMatch) {
        register({
          type: 'task',
          fromLine: lineNo,
          toLine: lineNo,
          markerPos: line.from + markerEnd,
          markerStart: line.from + markerStart,
          markerLength: markerEnd - markerStart,
          checked: taskMatch[1].toLowerCase() === 'x'
        })
      } else {
        register({
          type: 'list',
          fromLine: lineNo,
          toLine: lineNo,
          markerStart: line.from + markerStart,
          markerLength: markerEnd - markerStart,
          ordered: /\d/.test(list[2])
        })
      }
      lineNo += 1
      continue
    }

    // 定义列表：术语行 + 连续以 ": " 开头的定义行
    if (lineNo < doc.lines && definitionPrefixLength(doc.line(lineNo + 1).text) > 0) {
      let closing = lineNo + 1
      while (closing < doc.lines && definitionPrefixLength(doc.line(closing + 1).text) > 0) closing += 1
      register({ type: 'deflist', fromLine: lineNo, toLine: closing })
      lineNo = closing + 1
      continue
    }

    register({ type: 'text', fromLine: lineNo, toLine: lineNo })
    lineNo += 1
  }

  return { blocks, byLine }
}

/* ------------------------------------------------------------------ */
/* 整块 Widget（StateField 提供，符合 block decoration 规则）            */
/* ------------------------------------------------------------------ */

/** 提供实时预览计算使用的文稿上下文、配色和图片加载偏好。 */
export interface LivePreviewOptions {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: () => string | null
  /** 控制该渲染场景是否加载远程图片。 */
  loadRemoteImages: () => boolean
  /** 控制公式、图表或页面使用深色渲染模式。 */
  dark: () => boolean
  /** 页面锁定时始终保持渲染形态，不因光标或点击回退到源码。 */
  locked: () => boolean
}

function shouldShowSource(state: EditorState, block: LiveBlock, locked: boolean): boolean {
  // 锁定：无论光标、选区或点击，都把块保留为渲染形态
  if (locked) return false
  const headLine = state.doc.lineAt(state.selection.main.head).number
  if (headLine >= block.fromLine && headLine <= block.toLine) return true
  const from = state.doc.line(block.fromLine).from
  const to = state.doc.line(block.toLine).to
  return state.selection.ranges.some(
    (range) => range.from !== range.to && range.from <= to && range.to >= from
  )
}

/** 收集文稿标题，供即时渲染的目录卡片使用。 */
function headingEntries(state: EditorState, blocks: LiveBlock[]): TocEntry[] {
  const entries: TocEntry[] = []
  for (const block of blocks) {
    if (block.type !== 'heading') continue
    const line = state.doc.line(block.fromLine)
    const { text } = parseHeadingLine(line.text)
    if (!text) continue
    entries.push({ level: block.level ?? 1, text, pos: line.from })
  }
  return entries
}

function widgetForBlock(
  block: LiveBlock,
  state: EditorState,
  options: LivePreviewOptions,
  locked: boolean,
  blocks: LiveBlock[]
): WidgetType | null {
  const from = state.doc.line(block.fromLine).from
  const dark = options.dark()

  if (block.type === 'table') {
    const lines: string[] = []
    for (let number = block.fromLine; number <= block.toLine; number += 1)
      lines.push(state.doc.line(number).text)
    const spec = parseTableLines(lines)
    spec.sourcePos = from
    spec.locked = locked
    return new TableWidget(spec)
  }

  if (block.type === 'fence') {
    const content: string[] = []
    for (let number = block.fromLine + 1; number < block.toLine; number += 1)
      content.push(state.doc.line(number).text)
    const code = content.join('\n')
    return block.lang?.toLowerCase() === 'mermaid'
      ? new MermaidWidget(code, dark, from, locked)
      : new CodeBlockWidget({ code, lang: block.lang ?? '', sourcePos: from, locked })
  }

  if (block.type === 'math') {
    const lines: string[] = []
    for (let number = block.fromLine; number <= block.toLine; number += 1)
      lines.push(state.doc.line(number).text)
    let tex: string
    if (lines.length === 1) {
      tex = lines[0].trim().replace(/^\$\$/, '').replace(/\$\$$/, '')
    } else {
      const parts = [...lines]
      parts[0] = parts[0].replace(/^\s*\$\$/, '')
      parts[parts.length - 1] = parts[parts.length - 1].replace(/\$\$\s*$/, '')
      tex = parts.join('\n')
    }
    return new MathWidget(tex.trim(), true, from, locked)
  }

  if (block.type === 'hr') return new HrWidget(from, locked)

  if (block.type === 'text') {
    const line = state.doc.line(block.fromLine)
    if (isTocLine(line.text)) return new TocWidget(headingEntries(state, blocks), locked)
    const match = IMAGE_ONLY.exec(line.text)
    if (match) {
      return new ImageWidget({
        documentId: options.documentId(),
        raw: match[2],
        alt: match[1],
        block: true,
        loadRemote: options.loadRemoteImages()
      })
    }
  }
  return null
}

function buildBlockDecorations(state: EditorState, options: LivePreviewOptions): DecorationSet {
  const index = buildIndex(state.doc)
  const locked = options.locked()
  const ranges: Range<Decoration>[] = []
  for (const block of index.blocks) {
    if (
      block.type !== 'table' &&
      block.type !== 'fence' &&
      block.type !== 'math' &&
      block.type !== 'hr' &&
      block.type !== 'text'
    ) {
      continue
    }
    if (shouldShowSource(state, block, locked)) continue
    const widget = widgetForBlock(block, state, options, locked, index.blocks)
    if (!widget) continue
    const from = state.doc.line(block.fromLine).from
    const to = state.doc.line(block.toLine).to
    ranges.push(Decoration.replace({ widget, block: true }).range(from, to))
  }
  return Decoration.set(ranges, true)
}

function blockDecorationField(options: LivePreviewOptions) {
  return StateField.define<DecorationSet>({
    create: (state) => buildBlockDecorations(state, options),
    update(value, transaction) {
      const refresh = transaction.effects.some((effect) => effect.is(liveRefreshEffect))
      if (transaction.docChanged || transaction.selection !== undefined || refresh) {
        return buildBlockDecorations(transaction.state, options)
      }
      return value
    },
    provide: (field) => EditorView.decorations.from(field)
  })
}

/* ------------------------------------------------------------------ */
/* 行内装饰与行样式                                                    */
/* ------------------------------------------------------------------ */

interface InlineContext {
  ranges: Array<Range<Decoration>>
  lineFrom: number
  hideMarkers: boolean
  documentId: string | null
  loadRemote: boolean
}

function overlaps(masked: Array<[number, number]>, from: number, to: number): boolean {
  return masked.some(([start, end]) => from < end && to > start)
}

function addMark(
  context: InlineContext,
  from: number,
  to: number,
  className: string,
  attrs?: Record<string, string>
): void {
  if (to <= from) return
  context.ranges.push(
    Decoration.mark({ class: className, ...(attrs ? { attributes: attrs } : {}) }).range(
      context.lineFrom + from,
      context.lineFrom + to
    )
  )
}

function addHide(context: InlineContext, from: number, to: number): void {
  if (!context.hideMarkers || to <= from) return
  context.ranges.push(Decoration.replace({}).range(context.lineFrom + from, context.lineFrom + to))
}

function addWidget(context: InlineContext, from: number, to: number, widget: WidgetType): void {
  context.ranges.push(Decoration.replace({ widget }).range(context.lineFrom + from, context.lineFrom + to))
}

/** 行内语法：代码、公式、图片、链接、粗体、斜体、删除线 */
function inlineDecorations(text: string, context: InlineContext): void {
  const masked: Array<[number, number]> = []

  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    masked.push([start, end])
    addMark(context, start + 1, end - 1, 'cm-md-inline-code')
    addHide(context, start, start + 1)
    addHide(context, end - 1, end)
  }

  for (const match of text.matchAll(/\$([^$\n]+)\$/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    if (context.hideMarkers)
      addWidget(context, start, end, new MathWidget(match[1], false, context.lineFrom + start))
  }

  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    if (!context.hideMarkers) continue
    addWidget(
      context,
      start,
      end,
      new ImageWidget({
        documentId: context.documentId,
        raw: match[2],
        alt: match[1],
        block: false,
        loadRemote: context.loadRemote
      })
    )
  }

  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    addMark(context, start + 1, start + 1 + match[1].length, 'cm-md-link', { 'data-href': match[2] })
    addHide(context, start, start + 1)
    addHide(context, start + 1 + match[1].length, end)
  }

  for (const pattern of [/\*\*([^*\n]+)\*\*/g, /__([^_\n]+)__/g]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (overlaps(masked, start, end)) continue
      masked.push([start, end])
      addMark(context, start + 2, end - 2, 'cm-md-strong')
      addHide(context, start, start + 2)
      addHide(context, end - 2, end)
    }
  }

  for (const match of text.matchAll(/~~([^~\n]+)~~/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    addMark(context, start + 2, end - 2, 'cm-md-strike')
    addHide(context, start, start + 2)
    addHide(context, end - 2, end)
  }

  for (const match of text.matchAll(/==([^=\n]+)==/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    addMark(context, start + 2, end - 2, 'cm-md-mark')
    addHide(context, start, start + 2)
    addHide(context, end - 2, end)
  }

  for (const match of text.matchAll(/(?<![\\^])\^([^\^\n\s]+)\^/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    addMark(context, start + 1, end - 1, 'cm-md-sup')
    addHide(context, start, start + 1)
    addHide(context, end - 1, end)
  }

  for (const match of text.matchAll(/(?<!~)~([^~\n\s]+)~(?!~)/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    addMark(context, start + 1, end - 1, 'cm-md-sub')
    addHide(context, start, start + 1)
    addHide(context, end - 1, end)
  }

  if (context.hideMarkers) {
    for (const match of text.matchAll(/:([a-z0-9_+-]+):/g)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (overlaps(masked, start, end)) continue
      const emoji = emojiFor(match[1])
      if (!emoji) continue
      masked.push([start, end])
      addWidget(context, start, end, new EmojiWidget(emoji))
    }
  }

  for (const match of text.matchAll(/<u>([^<\n]+)<\/u>/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    addMark(context, start + 3, end - 4, 'cm-md-underline')
    addHide(context, start, start + 3)
    addHide(context, end - 4, end)
  }

  for (const match of text.matchAll(/(?<![*\w])\*([^*\n]+)\*(?![*])/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(masked, start, end)) continue
    masked.push([start, end])
    addMark(context, start + 1, end - 1, 'cm-md-em')
    addHide(context, start, start + 1)
    addHide(context, end - 1, end)
  }
}

function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

/** 从 Markdown 表格行构造表头、对齐方式和数据行模型。 */
export function parseTableLines(lines: string[]): TableSpec {
  const rows = lines.map(splitRow)
  const divider = rows[1] ?? []
  const aligns = divider.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    return left && right ? 'center' : right ? 'right' : 'left'
  })
  return {
    header: rows[0] ?? [],
    rows: rows.slice(2),
    aligns,
    sourcePos: 0
  }
}

function buildInlineDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
  const state = view.state
  const doc = state.doc
  if (!view.visibleRanges.length) return Decoration.none
  const index = buildIndex(doc)
  const cursorLine = doc.lineAt(state.selection.main.head).number
  const firstVisible = doc.lineAt(view.visibleRanges[0].from).number
  const lastVisible = doc.lineAt(view.visibleRanges[view.visibleRanges.length - 1].to).number
  const ranges: Array<Range<Decoration>> = []
  const documentId = options.documentId()
  const loadRemote = options.loadRemoteImages()
  const locked = options.locked()

  const pushLine = (lineNo: number, className: string): void => {
    ranges.push(Decoration.line({ class: className }).range(doc.line(lineNo).from))
  }

  for (const block of index.blocks) {
    if (block.toLine < firstVisible - 1 || block.fromLine > lastVisible + 1) continue
    const blockIsWidget =
      ((block.type === 'table' || block.type === 'fence' || block.type === 'math' || block.type === 'hr') &&
        !shouldShowSource(state, block, locked)) ||
      (block.type === 'text' &&
        (IMAGE_ONLY.test(doc.line(block.fromLine).text) || isTocLine(doc.line(block.fromLine).text)) &&
        !shouldShowSource(state, block, locked))
    if (blockIsWidget) continue

    for (
      let lineNo = Math.max(block.fromLine, firstVisible - 1);
      lineNo <= Math.min(block.toLine, lastVisible + 1);
      lineNo += 1
    ) {
      const line = doc.line(lineNo)
      // 锁定后所有行都按成稿显示标记隐藏，不随光标位置回退
      const hideMarkers = locked || lineNo !== cursorLine
      const context: InlineContext = { ranges, lineFrom: line.from, hideMarkers, documentId, loadRemote }

      switch (block.type) {
        case 'frontmatter':
          pushLine(lineNo, 'cm-md-frontmatter')
          continue
        case 'heading': {
          pushLine(lineNo, `cm-md-h${block.level ?? 1}`)
          if (hideMarkers && block.prefixLength) {
            ranges.push(
              Decoration.replace({}).range(line.from, Math.min(line.from + block.prefixLength, line.to))
            )
          }
          // 自定义标题 ID 只在源码中保留，成稿形态下隐藏
          const headingId = findHeadingId(line.text)
          if (hideMarkers && headingId) {
            ranges.push(Decoration.replace({}).range(line.from + headingId.index, line.to))
          }
          inlineDecorations(line.text, context)
          continue
        }
        case 'quote':
          pushLine(lineNo, 'cm-md-quote')
          if (hideMarkers && block.prefixLength) {
            ranges.push(
              Decoration.replace({}).range(line.from, Math.min(line.from + block.prefixLength, line.to))
            )
          }
          inlineDecorations(line.text, context)
          continue
        case 'list':
          pushLine(lineNo, block.ordered ? 'cm-md-list cm-md-ordered' : 'cm-md-list cm-md-bullet')
          if (hideMarkers && block.markerStart !== undefined && block.markerLength && !block.ordered) {
            ranges.push(
              Decoration.replace({}).range(
                block.markerStart,
                Math.min(block.markerStart + block.markerLength, line.to)
              )
            )
          }
          inlineDecorations(line.text, context)
          continue
        case 'task':
          if (block.markerPos !== undefined) {
            if (hideMarkers) {
              ranges.push(
                Decoration.replace({
                  widget: new TaskCheckboxWidget(Boolean(block.checked), block.markerPos, locked)
                }).range(block.markerPos, Math.min(block.markerPos + 3, line.to))
              )
              if (block.markerStart !== undefined && block.markerLength) {
                ranges.push(
                  Decoration.replace({}).range(
                    block.markerStart,
                    Math.min(block.markerStart + block.markerLength, line.to)
                  )
                )
              }
            } else {
              pushLine(lineNo, 'cm-md-list')
            }
          }
          inlineDecorations(line.text, context)
          continue
        case 'fence':
          pushLine(
            lineNo,
            `cm-md-code-line${lineNo === block.fromLine ? ' cm-md-code-first' : ''}${
              lineNo === block.toLine ? ' cm-md-code-last' : ''
            }`
          )
          continue
        case 'table':
          pushLine(lineNo, 'cm-md-table-source')
          continue
        case 'math':
          pushLine(lineNo, 'cm-md-code-line')
          continue
        case 'deflist': {
          const prefix = definitionPrefixLength(line.text)
          if (lineNo === block.fromLine) {
            pushLine(lineNo, 'cm-md-dt')
          } else if (prefix) {
            pushLine(lineNo, 'cm-md-dd')
            if (hideMarkers) addHide(context, 0, prefix)
          }
          inlineDecorations(line.text, context)
          continue
        }
        case 'hr':
          pushLine(lineNo, 'cm-md-hr-line')
          continue
        default:
          inlineDecorations(line.text, context)
      }
    }
  }

  return Decoration.set(ranges, true)
}

// Chromium can locate the text under the pointer even when wrapped inline decorations
// make CodeMirror's coordinate scan choose a different visual row of an ordered item.
function orderedListTextHit(view: EditorView, event: MouseEvent) {
  const line = (event.target as Element | null)?.closest('.cm-md-ordered')
  if (!line || !view.contentDOM.contains(line)) return null

  const range = view.dom.ownerDocument.caretRangeFromPoint(event.clientX, event.clientY)
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !line.contains(range.startContainer)) {
    return null
  }

  const pos = view.posAtDOM(range.startContainer, range.startOffset)
  const before = view.coordsAtPos(pos, -1)
  const after = view.coordsAtPos(pos, 1)
  if (after && event.clientY >= after.top && event.clientY <= after.bottom) {
    return { pos, assoc: 1 as const }
  }
  if (before && event.clientY >= before.top && event.clientY <= before.bottom) {
    return { pos, assoc: -1 as const }
  }
  return null
}

const orderedListMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    return null
  }
  const hit = orderedListTextHit(view, event)
  if (!hit || hit.pos === view.posAtCoords({ x: event.clientX, y: event.clientY })) return null

  let anchor = hit.pos
  return {
    get(current) {
      const { pos, assoc } = current === event
        ? { pos: anchor, assoc: hit.assoc }
        : orderedListTextHit(view, current) ?? view.posAndSideAtCoords({ x: current.clientX, y: current.clientY }, false)
      return EditorSelection.create([EditorSelection.range(anchor, pos, assoc)])
    },
    update(update) {
      if (update.docChanged) anchor = update.changes.mapPos(anchor)
    }
  }
})

/** 主题或设置变化时重建行内装饰 */
export function livePreviewExtension(options: LivePreviewOptions) {
  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildInlineDecorations(view, options)
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(liveRefreshEffect))
          )
        ) {
          this.decorations = buildInlineDecorations(update.view, options)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
  return [blockDecorationField(options), inlinePlugin, orderedListMouseSelection]
}

/** 建立 Markdown 实时预览块的索引，供装饰构造定位源码范围。 */
export { buildIndex }
/** 描述实时预览块的类型、源码区间及渲染所需数据。 */
export type { LiveBlock }
