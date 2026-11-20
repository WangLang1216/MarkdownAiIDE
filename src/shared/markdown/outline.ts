/**
 * 轻量 Markdown 结构解析：只做标题树、章节范围与全文字数统计。
 * 解析规则与编辑器方言保持一致，供主进程定位、Agent 工具与目录面板共同使用。
 */

import { AppError } from '../errors'
import type { OutlineNode, SectionRef, TargetAnchor, TextStats } from '../types'

interface LineInfo {
  /** 不含换行符的行内容 */
  text: string
  /** 行起始偏移 */
  start: number
  /** 行尾偏移（不含换行符） */
  end: number
  /** 下一行起始偏移 */
  next: number
}

/** 将文本切分为行，保留精确偏移，兼容 LF 与 CRLF */
export function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = []
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const rawEnd = nl === -1 ? text.length : nl
    const end = rawEnd > start && text[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd
    lines.push({
      text: text.slice(start, end),
      start,
      end,
      next: nl === -1 ? text.length : nl + 1
    })
    if (nl === -1) break
    start = nl + 1
  }
  return lines
}

interface RawHeading {
  level: number
  title: string
  start: number
  /** 标题块结束偏移（下一行起点） */
  end: number
  lineIndex: number
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FRONT_MATTER_RE = /^(---|\.\.\.)[ \t]*$/

/**
 * 扫描全文标题。
 * 忽略围栏代码块、Front Matter 与缩进代码中的伪标题，支持 ATX 与 Setext。
 */
export function scanHeadings(text: string): RawHeading[] {
  const lines = splitLines(text)
  const headings: RawHeading[] = []
  let fence: { char: string; length: number } | null = null
  let inFrontMatter = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const value = line.text

    if (i === 0 && value.replace(/^\uFEFF/, '').trim() === '---') {
      inFrontMatter = true
      continue
    }
    if (inFrontMatter) {
      if (FRONT_MATTER_RE.test(value.trim())) inFrontMatter = false
      continue
    }

    const fenceMatch = FENCE_RE.exec(value)
    if (fence) {
      if (fenceMatch) {
        const marker = fenceMatch[1]
        if (marker[0] === fence.char && marker.length >= fence.length && fenceMatch[2].trim() === '') {
          fence = null
        }
      }
      continue
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      continue
    }
    if (!value.trim()) continue

    const atx = ATX_RE.exec(value)
    if (atx) {
      const rawTitle = atx[2] ?? ''
      const title = rawTitle.replace(/[ \t]+#+[ \t]*$/, '').trim()
      headings.push({
        level: atx[1].length,
        title: title || '未命名标题',
        start: line.start,
        end: line.next,
        lineIndex: i
      })
      continue
    }

    // Setext 标题：当前行是文本，下一行是 === 或 ---
    const next = lines[i + 1]
    if (next && SETEXT_RE.test(next.text) && !/^\s{4,}/.test(value)) {
      const isListOrTable = /^ {0,3}([-*+>|]|\d+[.)])\s/.test(value) || value.trim().startsWith('|')
      const isThematicBreak = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(value)
      if (!isListOrTable && !isThematicBreak) {
        const level = next.text.trim().startsWith('=') ? 1 : 2
        headings.push({
          level,
          title: value.trim(),
          start: line.start,
          end: next.next,
          lineIndex: i
        })
        i += 1
      }
    }
  }
  return headings
}

/** 按标题树计算章节范围：sectionEnd 为下一个同级或更高级标题之前 */
export function parseSections(text: string): SectionRef[] {
  const headings = scanHeadings(text)
  const counters = [0, 0, 0, 0, 0, 0]
  const stack: Array<{ level: number; title: string }> = []

  return headings.map((heading, index) => {
    counters[heading.level - 1] += 1
    for (let i = heading.level; i < counters.length; i += 1) {
      if (i > heading.level - 1) counters[i] = 0
    }
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop()
    stack.push({ level: heading.level, title: heading.title })

    let sectionEnd = text.length
    for (let i = index + 1; i < headings.length; i += 1) {
      if (headings[i].level <= heading.level) {
        sectionEnd = headings[i].start
        break
      }
    }

    return {
      sectionId: `sec-${index}`,
      level: heading.level,
      title: heading.title,
      headingPath: stack.map((item) => item.title),
      ordinalAtLevel: counters[heading.level - 1],
      headingStart: heading.start,
      headingEnd: heading.end,
      sectionEnd
    }
  })
}

/** 目录面板展示用的大纲节点 */
export function parseOutline(text: string): OutlineNode[] {
  return parseSections(text).map((section) => ({
    sectionId: section.sectionId,
    level: section.level,
    title: section.title,
    headingPath: section.headingPath,
    ordinalAtLevel: section.ordinalAtLevel,
    from: section.headingStart,
    to: section.headingEnd
  }))
}

/** 解析章节锚点为可插入偏移；无法定位时抛出可直接展示的错误 */
export function resolveAnchorOffset(
  text: string,
  sections: SectionRef[],
  anchor: TargetAnchor
): { offset: number; section: SectionRef | null } {
  if (anchor.position === 'document_end' && !anchor.sectionId) {
    return { offset: text.length, section: null }
  }
  const section = sections.find((item) => item.sectionId === anchor.sectionId)
  if (!section) {
    throw new AppError('TARGET_AMBIGUOUS', '目标章节不存在或已变化，请重新读取文档目录。')
  }
  if (anchor.position === 'after_heading') {
    return { offset: section.headingEnd, section }
  }
  return { offset: section.sectionEnd, section }
}

/** 中英混排字数统计：CJK 按字计，拉丁按词计 */
export function countText(text: string): TextStats {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)
  const cjkCharacters = cjk ? cjk.length : 0
  const latinWords = latin ? latin.length : 0
  const characters = text.replace(/\s/g, '').length
  const paragraphs = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(
      (item) => item && !item.startsWith('#') && !/^(`{3,}|~{3,})/.test(item) && !item.startsWith('|')
    ).length

  return {
    words: cjkCharacters + latinWords,
    characters,
    cjkCharacters,
    paragraphs,
    readingMinutes: Math.max(1, Math.round(cjkCharacters / 300 + latinWords / 200))
  }
}

/** 提取章节正文（不含标题行），用于 Agent 精确读取 */
export function sectionBody(text: string, section: SectionRef): string {
  const bodyStart = Math.min(section.headingEnd, section.sectionEnd)
  return text.slice(bodyStart, section.sectionEnd)
}

/** 供搜索结果与摘要使用的纯文本化处理 */
export function toPlainExcerpt(markdown: string, maxLength = 160): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain
}
