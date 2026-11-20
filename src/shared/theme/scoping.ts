/**
 * Typora 主题 CSS 隔离：把选择器限定到预览容器，过滤远程依赖，生成兼容报告。
 * 纯函数实现，便于单元测试；不依赖 Electron。
 */

export interface ThemeScopedResult {
  /** 重写选择器并处理不允许规则后的主题 CSS。 */
  css: string
  /** 处理后用于兼容报告的 CSS 规则数。 */
  ruleCount: number
  aLevelCovered: string[]
  bLevelCovered: string[]
  /** 流程已收集的非阻断问题说明。 */
  warnings: string[]
}

const A_LEVEL_SELECTORS: Array<[string, RegExp]> = [
  ['标题', /\bh[1-6]\b/i],
  ['正文', /(^|[\s,>])p(\b|[\s,:.#\[])/i],
  ['列表', /\b(ul|ol|li)\b/i],
  ['表格', /\b(table|thead|tbody|tr|th|td)\b/i],
  ['引用', /\bblockquote\b/i],
  ['代码', /\b(pre|code)\b/i],
  ['图片', /\bimg\b/i],
  ['任务列表', /checkbox|task-list/i]
]

const B_LEVEL_SELECTORS: Array<[string, RegExp]> = [
  ['公式', /katex|math/i],
  ['图表', /mermaid|diagram/i],
  ['目录', /toc|outline/i],
  ['脚注', /footnote|footnotes/i]
]

/** 将 CSS 规则限定到预览容器，过滤 @import 与远程资源 */
export function scopeCss(css: string, scopeId: string): ThemeScopedResult {
  const scope = `[data-doc-theme="${scopeId}"]`
  const warnings: string[] = []
  const covered = new Set<string>()
  const bCovered = new Set<string>()
  let ruleCount = 0

  // @import 语句没有块结构，先整体移除，避免其后的第一个 {} 被误认为它的规则体
  const withoutImports = css.replace(/@import[^;]*;?/gi, () => {
    warnings.push('已移除 @import 规则，避免加载外部样式。')
    return '\n'
  })

  const transformRules = (input: string): string => {
    let cursor = 0
    let output = ''
    while (cursor < input.length) {
      const open = input.indexOf('{', cursor)
      if (open === -1) {
        output += input.slice(cursor)
        break
      }
      const prelude = input.slice(cursor, open)
      const close = findMatchingBrace(input, open)
      if (close === -1) {
        output += input.slice(cursor)
        break
      }
      const body = input.slice(open + 1, close)
      const trimmed = prelude.trim()

      if (trimmed.startsWith('@')) {
        const atName = trimmed.split(/\s+/)[0].toLowerCase()
        if (atName.startsWith('@import')) {
          warnings.push('已移除 @import 规则，避免加载外部样式。')
        } else if (
          atName.startsWith('@media') ||
          atName.startsWith('@supports') ||
          atName.startsWith('@layer')
        ) {
          output += `${prelude}{${transformRules(body)}}`
        } else {
          output += `${prelude}{${body}}`
        }
      } else if (trimmed) {
        for (const [label, pattern] of A_LEVEL_SELECTORS) {
          if (pattern.test(trimmed)) covered.add(label)
        }
        for (const [label, pattern] of B_LEVEL_SELECTORS) {
          if (pattern.test(trimmed)) bCovered.add(label)
        }
        const scoped = scopeSelectorList(prelude, scope)
        if (scoped) {
          ruleCount += 1
          output += `${scoped}{${body}}`
        }
      } else {
        output += `${prelude}{${body}}`
      }
      cursor = close + 1
    }
    return output
  }

  return {
    css: transformRules(withoutImports),
    ruleCount,
    aLevelCovered: [...covered],
    bLevelCovered: [...bCovered],
    warnings
  }
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0
  let inString: string | null = null
  let inComment = false
  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i]
    const next = input[i + 1]
    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false
        i += 1
      }
      continue
    }
    if (inString) {
      if (char === '\\') i += 1
      else if (char === inString) inString = null
      continue
    }
    if (char === '/' && next === '*') {
      inComment = true
      i += 1
      continue
    }
    if (char === '"' || char === "'") {
      inString = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function scopeSelectorList(prelude: string, scope: string): string {
  const selectors = splitSelectors(prelude)
  const scoped = selectors
    .map((raw) => {
      let selector = raw.trim()
      if (!selector) return ''
      if (selector.includes('#write')) {
        selector = selector.replace(/#write\b/g, scope)
      } else if (/^(html|body|:root)\b/i.test(selector)) {
        selector = selector.replace(/^(html|body|:root)/i, scope)
      } else if (selector === '*') {
        selector = `${scope} *`
      } else {
        selector = `${scope} ${selector}`
      }
      return selector
    })
    .filter(Boolean)
  return scoped.join(', ')
}

function splitSelectors(prelude: string): string[] {
  const result: string[] = []
  let depth = 0
  let current = ''
  for (const char of prelude) {
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      result.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) result.push(current)
  return result
}

/** 从主题中提取正文与标题排版，映射到实时渲染的装饰类 */
export function buildLiveOverride(css: string, scopeId: string): string {
  const scope = `.cm-content[data-doc-theme="${scopeId}"]`
  const pick = (block: string, property: string): string | null => {
    const match = new RegExp(`${property}\\s*:\\s*([^;]+);`, 'i').exec(block)
    return match ? match[1].trim() : null
  }
  const baseMatch = /#write\s*\{([^}]*)\}/i.exec(css)
  const base = baseMatch?.[1] ?? ''
  const baseRules: string[] = []
  const family = pick(base, 'font-family')
  const size = pick(base, 'font-size')
  const lineHeight = pick(base, 'line-height')
  const color = pick(base, 'color')
  if (family) baseRules.push(`font-family:${family};`)
  if (size) baseRules.push(`font-size:${size};`)
  if (lineHeight) baseRules.push(`line-height:${lineHeight};`)
  if (color) baseRules.push(`color:${color};`)

  const headingRules: string[] = []
  for (let level = 1; level <= 6; level += 1) {
    const match = new RegExp(`#write\\s+h${level}\\s*\\{([^}]*)\\}`, 'i').exec(css)
    if (!match) continue
    const block = match[1]
    const rules: string[] = []
    const fontSize = pick(block, 'font-size')
    const weight = pick(block, 'font-weight')
    const colorValue = pick(block, 'color')
    if (fontSize) rules.push(`font-size:${fontSize};`)
    if (weight) rules.push(`font-weight:${weight};`)
    if (colorValue) rules.push(`color:${colorValue};`)
    if (rules.length) headingRules.push(`${scope} .cm-md-h${level}{${rules.join('')}}`)
  }

  return [`${scope}{${baseRules.join('')}}`, ...headingRules].join('\n')
}

/** A 级元素中未被主题覆盖的部分 */
export function missingALevel(covered: string[]): string[] {
  return A_LEVEL_SELECTORS.map(([label]) => label).filter((label) => !covered.includes(label))
}
