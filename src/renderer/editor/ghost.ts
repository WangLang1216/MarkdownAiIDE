/**
 * 预测幽灵文本：装饰层展示，不属于文档正文；Tab 接受、Esc 忽略、继续输入自动消失。
 */

import { Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { GhostTextWidget } from './widgets'

/** 保存幽灵续写的插入偏移和候选文本。 */
export interface GhostState {
  /** 候选在正文中的 UTF-16 插入位置。 */
  pos: number
  /** 尚未写回文稿的预测文本。 */
  text: string
}

/** 声明供事务设置或清除幽灵续写候选的状态效果。 */
export const setGhostEffect = StateEffect.define<GhostState | null>()

/** 在 CodeMirror 中保存候选并提供其显示装饰。 */
export const ghostField = StateField.define<GhostState | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged) return null
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(setGhostEffect)) next = effect.value
    }
    return next
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value): DecorationSet => {
      if (!value) return Decoration.none
      return Decoration.set([
        Decoration.widget({ widget: new GhostTextWidget(value.text), side: 1 }).range(value.pos)
      ])
    })
})

/** 读取编辑视图当前挂载的续写候选。 */
export function getGhost(view: EditorView): GhostState | null {
  return view.state.field(ghostField, false) ?? null
}

/** 清除候选装饰而不改写正文。 */
export function clearGhost(view: EditorView): void {
  if (!getGhost(view)) return
  view.dispatch({ effects: setGhostEffect.of(null) })
}

/** 在指定源码偏移显示续写候选，不立即写入正文。 */
export function showGhost(view: EditorView, text: string, pos?: number): void {
  const target = pos ?? view.state.selection.main.head
  if (!text.trim()) return
  view.dispatch({ effects: setGhostEffect.of({ pos: target, text }) })
}

/** 表格与代码块内保留原生 Tab 行为，不劫持为接受预测 */
function inProtectedContext(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  if (line.text.trimStart().startsWith('|')) return true
  let fence = false
  for (let number = line.number - 1, count = 0; number >= 1 && count < 400; number -= 1, count += 1) {
    const text = view.state.doc.line(number).text.trimStart()
    if (/^(`{3,}|~{3,})/.test(text)) {
      fence = true
      break
    }
  }
  return fence
}

/** 尝试将当前候选写入正文并报告是否完成接受。 */
export function acceptGhost(view: EditorView): boolean {
  const ghost = getGhost(view)
  if (!ghost) return false
  const pos = Math.min(ghost.pos, view.state.doc.length)
  view.dispatch({
    changes: { from: pos, to: pos, insert: ghost.text },
    selection: { anchor: pos + ghost.text.length },
    effects: setGhostEffect.of(null),
    scrollIntoView: true
  })
  return true
}

/**
 * 使用最高优先级的键位映射：Tab 只在存在候选且不在表格/代码块中时接受，
 * 否则原样交给编辑器（缩进、表格跳转等行为不受影响）。
 */
export const ghostKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        if (!getGhost(view) || view.composing || inProtectedContext(view)) return false
        return acceptGhost(view)
      }
    },
    {
      key: 'Escape',
      run: (view) => {
        if (!getGhost(view)) return false
        clearGhost(view)
        return true
      }
    }
  ])
)
