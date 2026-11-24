/**
 * 查找命中高亮。
 *
 * CodeMirror 自带的 searchHighlighter 只在它自己的查找面板展开时才着色
 * （内部 `if (!panel) return Decoration.none`），而本项目用的是自绘查找条，
 * 因此需要这套独立装饰：所有命中标黄，当前命中的那一段换成另一种颜色。
 */

import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { getSearchQuery } from '@codemirror/search'

const MATCH = Decoration.mark({ class: 'cm-searchMatch' })
const CURRENT = Decoration.mark({ class: 'cm-searchMatch-selected' })

/** 相邻可视区的合并阈值，与 CodeMirror 内部保持一致 */
const RANGE_MARGIN = 250

function build(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state)
  if (!query.search) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  const ranges = view.visibleRanges
  const selection = view.state.selection.ranges
  for (let index = 0; index < ranges.length; index += 1) {
    let { from, to } = ranges[index]
    // 相邻可视区挨得很近时并成一段，避免同一个命中被切到两个区间
    while (index < ranges.length - 1 && to > ranges[index + 1].from - 2 * RANGE_MARGIN) {
      index += 1
      to = ranges[index].to
    }
    const cursor = query.getCursor(view.state, from, to)
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      const hit = next.value
      const current = selection.some((range) => range.from === hit.from && range.to === hit.to)
      builder.add(hit.from, hit.to, current ? CURRENT : MATCH)
    }
  }
  return builder.finish()
}

const searchMatchHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = build(view)
    }

    update(update: ViewUpdate): void {
      const queryChanged = getSearchQuery(update.state) !== getSearchQuery(update.startState)
      if (update.docChanged || update.selectionSet || update.viewportChanged || queryChanged) {
        this.decorations = build(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

/** 注册到编辑器，与 search() 一起使用。 */
export const searchHighlight = searchMatchHighlighter
