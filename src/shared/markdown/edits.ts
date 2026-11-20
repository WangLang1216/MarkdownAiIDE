/**
 * 文本局部编辑工具：主进程与渲染进程共用，保证偏移应用顺序一致。
 */

/** 基于编辑前正文坐标、用于局部替换的一次源码编辑。 */
export interface TextEdit {
  /** 区间起点，使用 JavaScript 字符串的 UTF-16 码元偏移。 */
  from: number
  /** 区间终点（不含），使用 UTF-16 码元偏移。 */
  to: number
  /** 替换该区间的文本；非空区间用空串替换时即为删除。 */
  insert: string
}

/** 按偏移降序应用，避免前面的偏移被破坏 */
export function applyEditsToText(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from || b.to - a.to)
  let output = text
  for (const edit of sorted) {
    if (edit.from < 0 || edit.to > output.length || edit.from > edit.to) continue
    output = output.slice(0, edit.from) + edit.insert + output.slice(edit.to)
  }
  return output
}
