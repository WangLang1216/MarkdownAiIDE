/**
 * 元素与内容模块片段。点击或拖入正文时在光标处插入，并保留光标可继续编辑。
 * 标题类片段插入后直接选中占位文字，输入即可替换，退格可一键清除。
 */

export interface SnippetDefinition {
  /** 用于搜索和定位要插入的模板的标识。 */
  id: string
  /** 元素面板展示的模板名称。 */
  label: string
  /** 说明模板用途或结构的界面文字。 */
  description?: string
  /** 面板图标位显示的文字符号；缺省时按 id 使用内置图标。 */
  glyph?: string
  /** 插入到编辑器中的源码模板。 */
  markdown: string
  /** 插入后光标相对片段末尾的偏移（负值表示回退） */
  cursorBack?: number
  /** 插入后需要选中的文字范围（相对正文起始位置，零基 UTF-16） */
  select?: { from: number; to: number }
}

function heading(level: 1 | 2 | 3): SnippetDefinition {
  const marker = '#'.repeat(level)
  const text = level === 1 ? '一级标题' : level === 2 ? '二级标题' : '三级标题'
  const start = marker.length + 1
  return {
    id: `h${level}`,
    label: level === 1 ? '一级标题' : level === 2 ? '二级标题' : '三级标题',
    markdown: `${marker} ${text}`,
    select: { from: start, to: start + text.length }
  }
}

/** 列出标题、列表等基础 Markdown 元素的插入模板。 */
export const ELEMENT_SNIPPETS: SnippetDefinition[] = [
  heading(1),
  heading(2),
  heading(3),
  { id: 'paragraph', label: '段落', markdown: '写下一段新的想法。' },
  { id: 'quote', label: '引用', markdown: '> 在这里留下值得记住的一句话。' },
  { id: 'list', label: '无序列表', markdown: '- 第一个想法\n- 第二个想法\n- 第三个想法' },
  { id: 'ordered', label: '有序列表', markdown: '1. 第一步\n2. 第二步\n3. 第三步' },
  { id: 'tasks', label: '任务清单', markdown: '- [ ] 整理思路\n- [ ] 完成初稿\n- [ ] 分享成果' },
  {
    id: 'code',
    label: '代码块',
    markdown: '```javascript\nconst idea = "让想法自然成文"\nconsole.log(idea)\n```',
    cursorBack: 4
  },
  { id: 'table', label: '表格', markdown: '| 项目 | 说明 |\n| --- | --- |\n| 新的想法 | 值得记录 |' },
  { id: 'image', label: '图片', markdown: '' },
  { id: 'link', label: '链接', markdown: '[链接文字](https://example.com)' },
  { id: 'hr', label: '分隔线', markdown: '---' }
]

/** 列出由多个 Markdown 元素构成的常用文稿模板。 */
export const MODULE_SNIPPETS: SnippetDefinition[] = [
  {
    id: 'callout',
    label: '提示块',
    description: '让重要内容更醒目',
    markdown: '> 提示：在这里记录重要的信息。'
  },
  {
    id: 'mermaid',
    label: '流程图',
    description: '用 Mermaid 描述逻辑',
    markdown: '```mermaid\ngraph LR\n  灵感 --> 写作 --> 分享\n```',
    cursorBack: 4
  },
  {
    id: 'math',
    label: '数学公式',
    description: '支持 LaTeX 语法',
    markdown: '$$\nE = mc^2\n$$',
    cursorBack: 3
  },
  {
    id: 'footnote',
    label: '脚注',
    description: '为正文补充来源',
    markdown: '正文中的引用[^1]\n\n[^1]: 在这里写脚注内容。',
    cursorBack: 9
  }
]

/**
 * 扩展语法元素：高亮、上下标、标题锚点、定义列表、目录与表情。
 * 语法对齐 Markdown 速查表与中文扩展语法教程，插入后在预览和导出中直接成稿。
 */
export const EXTENDED_SNIPPETS: SnippetDefinition[] = [
  {
    id: 'mark',
    label: '高亮',
    description: '==重点内容==',
    glyph: '==',
    markdown: '==重点内容==',
    select: { from: 2, to: 6 }
  },
  {
    id: 'sup',
    label: '上标',
    description: 'x^2^ 显示为上标',
    glyph: 'x²',
    markdown: 'x^2^',
    select: { from: 2, to: 3 }
  },
  {
    id: 'sub',
    label: '下标',
    description: 'H~2~O 显示为下标',
    glyph: 'x₂',
    markdown: 'H~2~O',
    select: { from: 2, to: 3 }
  },
  {
    id: 'strike',
    label: '删除线',
    description: '~~已废弃的内容~~',
    glyph: '~~',
    markdown: '~~已废弃的内容~~',
    select: { from: 2, to: 8 }
  },
  {
    id: 'underline',
    label: '下划线',
    description: '用 <u> 标记重点',
    glyph: 'U',
    markdown: '<u>重点内容</u>',
    select: { from: 3, to: 7 }
  },
  {
    id: 'heading-id',
    label: '标题锚点',
    description: '给标题一个可跳转 ID',
    glyph: '#',
    markdown: '## 小节标题 {#section-id}',
    select: { from: 3, to: 7 }
  },
  {
    id: 'anchor-link',
    label: '页内跳转',
    description: '跳转到标题锚点',
    glyph: '↧',
    markdown: '[跳到小节](#section-id)',
    select: { from: 7, to: 18 }
  },
  {
    id: 'deflist',
    label: '定义列表',
    description: '术语 + 冒号定义',
    glyph: 'dl',
    markdown: '术语\n: 定义内容',
    select: { from: 0, to: 2 }
  },
  {
    id: 'toc',
    label: '目录',
    description: '[TOC] 生成标题目录',
    glyph: '☰',
    markdown: '[TOC]'
  },
  {
    id: 'emoji',
    label: '表情',
    description: ':smile: 这类简码',
    glyph: '☺',
    markdown: ':smile:'
  }
]

/** 合并元素与模块模板，供搜索及按标识查找。 */
export const ALL_SNIPPETS = [...ELEMENT_SNIPPETS, ...EXTENDED_SNIPPETS, ...MODULE_SNIPPETS]

/** 按稳定标识查找可插入模板，不存在时返回空结果。 */
export function snippetById(id: string): SnippetDefinition | undefined {
  return ALL_SNIPPETS.find((snippet) => snippet.id === id)
}
