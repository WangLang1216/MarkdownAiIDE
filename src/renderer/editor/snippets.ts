/**
 * 元素与内容模块片段。点击或拖入正文时在光标处插入，并保留光标可继续编辑。
 * 标题类片段插入后直接选中占位文字，输入即可替换，退格可一键清除。
 */

import { shallowRef } from 'vue'

export interface SnippetDefinition {
  /** 用于搜索和定位要插入的模板的标识。 */
  id: string
  /** 元素面板展示的模板名称。 */
  label: string
  /** 说明模板用途或结构的界面文字。 */
  description?: string
  /** 面板图标位显示的文字符号；缺省时按 id 使用内置图标。 */
  glyph?: string
  /** 面板图标位使用的线性图标名，对应 icons.ts 的 ICON_PATHS。 */
  icon?: string
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

const PARAGRAPH_TEXT = '写下一段新的想法。'
const QUOTE_TEXT = '在这里留下值得记住的一句话。'
const FIRST_ITEM = '第一个想法'
const FIRST_STEP = '第一步'
const FIRST_TASK = '整理思路'

/** 列出标题、列表等基础 Markdown 元素的插入模板。 */
export const ELEMENT_SNIPPETS: SnippetDefinition[] = [
  heading(1),
  heading(2),
  heading(3),
  {
    id: 'paragraph',
    label: '段落',
    markdown: PARAGRAPH_TEXT,
    select: { from: 0, to: PARAGRAPH_TEXT.length }
  },
  { id: 'quote', label: '引用', markdown: `> ${QUOTE_TEXT}`, select: { from: 2, to: 2 + QUOTE_TEXT.length } },
  {
    id: 'list',
    label: '无序列表',
    markdown: `- ${FIRST_ITEM}\n- 第二个想法\n- 第三个想法`,
    select: { from: 2, to: 2 + FIRST_ITEM.length }
  },
  {
    id: 'ordered',
    label: '有序列表',
    markdown: `1. ${FIRST_STEP}\n2. 第二步\n3. 第三步`,
    select: { from: 3, to: 3 + FIRST_STEP.length }
  },
  {
    id: 'tasks',
    label: '任务清单',
    markdown: `- [ ] ${FIRST_TASK}\n- [ ] 完成初稿\n- [ ] 分享成果`,
    select: { from: 6, to: 6 + FIRST_TASK.length }
  },
  {
    id: 'code',
    label: '代码块',
    markdown: '```javascript\nconst idea = "让想法自然成文"\nconsole.log(idea)\n```',
    cursorBack: 4
  },
  {
    id: 'table',
    label: '表格',
    markdown: '| 项目 | 说明 |\n| --- | --- |\n| 新的想法 | 值得记录 |',
    select: { from: 2, to: 4 }
  },
  { id: 'image', label: '图片', markdown: '' },
  // 默认选中括号内的链接地址，输入即可替换目标地址；链接文字仍可按住鼠标拖选修改。
  { id: 'link', label: '链接', markdown: '[链接文字](https://example.com)', select: { from: 7, to: 26 } },
  { id: 'hr', label: '分隔线', markdown: '---' }
]

/** 列出由多个 Markdown 元素构成的常用文稿模板。 */
export const MODULE_SNIPPETS: SnippetDefinition[] = [
  {
    id: 'prompt-template',
    label: '提示词模板',
    description: '目标、上下文和输出要求',
    icon: 'prompt',
    markdown: `# 提示词模板

## 角色与任务
- 角色：[需要的专业能力、职责和视角]
- 目标：[用一句话说明要完成什么]
- 交付物：[列出最终文件、格式或可执行结果]

## 背景与输入
- 使用场景和目标读者：[谁会用，如何使用]
- 已知事实与术语：[列出必要背景]
- 参考资料：[粘贴正文，或列出附件及优先级]
- 可用工具与授权范围：[允许读取、修改或查询的内容]

## 执行要求
1. 根据资料完成任务，优先满足明确的硬性要求。
2. 如果缺少会影响结果的关键信息，先提出具体问题；其余情况标明采用的假设。
3. 事实性结论标明出处，资料不足时标记“待核实”。保留原文中的专名和数据。
4. 多项要求冲突时，说明取舍并遵循：[优先级]。

## 输出规格
- 语言、语气和长度：[例如简体中文、专业简洁、600 字以内]
- 格式与结构：[列出标题、表格列、字段类型或示例]
- 必须包含：[事项与数量]
- 排除项：[敏感信息、无关内容或禁止操作]

## 示例
- 示例输入：[一个典型样例]
- 期望输出：[展示结构与细节程度]
- 边界情况：[遇到缺失值、矛盾或例外时如何处理]

## 验收标准
- [ ] 交付物完整，满足输出格式和长度要求
- [ ] 数据、名称、引用与原资料一致
- [ ] 不确定项和未完成项明确标出
- [ ] 输出可直接用于目标场景`
  },
  {
    id: 'text-to-image-template',
    label: '文生图模板',
    description: '主体、构图与画面风格',
    icon: 'text-to-image',
    markdown:
      '## 文生图\n\n- 主体与动作：\n- 场景与背景：\n- 画面风格：\n- 镜头、光线与色彩：\n- 比例和尺寸：\n- 需要避开的元素：'
  },
  {
    id: 'image-to-text-template',
    label: '图生文模板',
    description: '描述、转录与待确认项',
    icon: 'image-to-text',
    markdown:
      '## 图生文\n\n- 图片来源：\n- 输出任务：描述、转录或提取数据\n- 关注区域：\n- 输出格式：\n- 模糊内容：标记为待确认'
  },
  {
    id: 'meeting-template',
    label: '纪要',
    description: '议题、结论和行动项',
    icon: 'minutes',
    markdown:
      '## 会议纪要\n\n- 日期：\n- 参会人：\n\n### 议题与讨论\n\n### 结论\n\n### 行动项\n\n| 事项 | 负责人 | 截止日期 |\n| --- | --- | --- |\n|  |  |  |'
  },
  {
    id: 'daily-template',
    label: '日报',
    description: '今日进展和明日计划',
    icon: 'daily',
    markdown: '## 日报\n\n- 日期：\n\n### 今日完成\n\n### 问题与协助\n\n### 明日计划'
  },
  {
    id: 'weekly-template',
    label: '周报',
    description: '本周成果和下周计划',
    icon: 'weekly',
    markdown: '## 周报\n\n- 周期：\n\n### 本周成果\n\n### 风险与待办\n\n### 下周计划'
  }
]

/**
 * 扩展语法元素：高亮、上下标、标题锚点、定义列表、目录与表情。
 * 语法对齐 Markdown 速查表与中文扩展语法教程，插入后在预览和导出中直接成稿。
 */
export const EXTENDED_SNIPPETS: SnippetDefinition[] = [
  {
    id: 'callout',
    label: '提示块',
    description: '让重要内容更醒目',
    glyph: '!',
    markdown: '> 提示：在这里记录重要的信息。',
    select: { from: 5, to: '> 提示：在这里记录重要的信息。'.length }
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
    glyph: '∑',
    markdown: '$$\nE = mc^2\n$$',
    cursorBack: 3
  },
  {
    id: 'footnote',
    label: '脚注',
    description: '为正文补充来源',
    glyph: '¹',
    markdown: '正文中的引用[^1]\n\n[^1]: 在这里写脚注内容。',
    cursorBack: 9
  },
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

const templateKey = 'moye.contentTemplates'
export const importedTemplates = shallowRef<SnippetDefinition[]>([])

try {
  const data: unknown = JSON.parse(localStorage.getItem(templateKey) ?? '[]')
  if (Array.isArray(data)) {
    importedTemplates.value = data.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        item.id.startsWith('imported-') &&
        typeof item.label === 'string' &&
        typeof item.markdown === 'string'
    )
  }
} catch {
  // 无法读取已导入模板时保留内置模板。
}

export function importContentTemplate(label: string, markdown: string): void {
  const template = { id: 'imported-' + crypto.randomUUID(), label, markdown, description: '已导入' }
  const next = [...importedTemplates.value, template]
  localStorage.setItem(templateKey, JSON.stringify(next))
  importedTemplates.value = next
}

export function deleteContentTemplate(id: string): void {
  const next = importedTemplates.value.filter((template) => template.id !== id)
  localStorage.setItem(templateKey, JSON.stringify(next))
  importedTemplates.value = next
}

/** 按稳定标识查找可插入模板，不存在时返回空结果。 */
export function snippetById(id: string): SnippetDefinition | undefined {
  return (
    ALL_SNIPPETS.find((snippet) => snippet.id === id) ??
    importedTemplates.value.find((snippet) => snippet.id === id)
  )
}
