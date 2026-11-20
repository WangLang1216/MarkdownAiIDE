/**
 * 编辑器能力注册表：Vue 组件与 Store 通过它访问 CodeMirror 实例，
 * 避免把编辑器对象塞进响应式状态。
 */

/** 表示编辑器主选区的半开源码区间；空区间即光标位置。 */
export interface EditorSelectionRange {
  /** 区间起点，使用 JavaScript 字符串的 UTF-16 码元偏移。 */
  from: number
  /** 区间终点（不含），使用 UTF-16 码元偏移。 */
  to: number
}

/** 定义编辑器向宿主发出的正文、选区与滚动回调。 */
export interface EditorCallbacks {
  /** 正文变动后向宿主交付更新后的 Markdown。 */
  onTextChange(text: string): void
  /** 选区变化后向宿主交付源码范围。 */
  onSelection(
    selection: EditorSelectionRange,
    lineNumber: number,
    lineText: string,
    docChanged: boolean
  ): void
  /** 滚动时向宿主报告当前比例位置。 */
  onScroll(ratio: number): void
  /** 插入表情简码后向宿主交付插入区间，用于就地弹出表情选择器。 */
  onEmojiInserted?(range: EditorSelectionRange): void
}

/** 定义界面和 IPC 桥对当前编辑器可使用的命令与状态读取接口。 */
export interface EditorFacade {
  /** 读取当前编辑缓冲区的完整 Markdown。 */
  getText(): string
  /** 读取主选区的起止偏移。 */
  getSelection(): EditorSelectionRange
  /** 替换当前编辑缓冲区中的完整正文。 */
  setText(text: string): void
  /** 按编辑前坐标批量应用源码编辑，并按需要定位变更区间。 */
  applyEdits(
    edits: Array<{ from: number; to: number; insert: string }>,
    reveal?: { from: number; to: number }
  ): void
  /** 插入 Markdown 模板并按模板设置光标或选区。 */
  insertSnippet(elementId: string): boolean
  /** 用给定纯文本替换当前选区。 */
  insertText(text: string): void
  /** 在选区前后包裹 Markdown 标记。 */
  wrapSelection(kind: 'bold' | 'italic' | 'code' | 'strike' | 'underline' | 'mark'): void
  /** 将当前选区转为 Markdown 链接。 */
  wrapLink(): void
  /** 移除选区中支持清理的行内格式标记。 */
  clearInlineFormat(): void
  /** 撤销最近一次可撤销的编辑事务。 */
  undo(): boolean
  /** 重做最近一次撤销的编辑事务。 */
  redo(): boolean
  /** 选择整个文稿的正文。 */
  selectAll(): void
  /** 将主选区移动到指定源码偏移范围。 */
  setSelection(from: number, to: number): void
  /** 将键盘焦点交给当前编辑器视图。 */
  focus(): void
  /** 滚动到指定源码范围并在编辑器中定位。 */
  revealOffset(offset: number): void
  /** 更新查找词、替换词及查找选项。 */
  setSearch(query: string, caseSensitive: boolean, replacement: string): void
  /** 按指定方向跳转到下一个查找匹配项。 */
  findNext(backwards?: boolean): void
  /** 替换当前查找命中项。 */
  replaceCurrent(): boolean
  /** 替换当前查找条件的全部匹配项。 */
  replaceAllMatches(): number
  /** 返回当前匹配项的位置和总命中数。 */
  searchCounts(): { index: number; total: number }
  /** 读取编辑器在可滚动范围内的位置比例。 */
  getScrollRatio(): number
  /** 按比例设置编辑器滚动位置，用于分屏同步。 */
  setScrollRatio(ratio: number): void
  /** 在指定源码偏移显示续写候选，不立即写入正文。 */
  showGhost(text: string): void
  /** 清除候选装饰而不改写正文。 */
  clearGhost(): void
  /** 检查编辑器是否存在可接受的续写候选。 */
  hasGhost(): boolean
  /** 尝试将当前候选写入正文并报告是否完成接受。 */
  acceptGhost(): boolean
  /** 检查编辑器是否处于输入法组合输入阶段。 */
  isComposing(): boolean
  /** 更新编辑器输入相关的 DOM 属性。 */
  setTextAttributes(themeScope: string | null): void
  /** 切换当前编辑器是否允许编辑。 */
  setEditable(editable: boolean): void
}

/** 保存当前挂载的编辑器门面；没有可用视图时为 null。 */
export const editorApi: { current: EditorFacade | null } = { current: null }
