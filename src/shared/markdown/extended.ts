/**
 * 扩展语法的纯文本助手：标题 ID、目录标记与定义列表前缀。
 * 预览渲染与即时渲染共用，避免两处正则各自演化。
 */

const HEADING_ID = /\s*\{#([A-Za-z0-9_:.-]+)\}\s*$/
const ATX_PREFIX = /^ {0,3}#{1,6}[ \t]*/
const TOC_LINE = /^\s*\[TOC\]\s*$/i
const DEF_ITEM = /^ {0,3}:[ \t]+(?=\S)/

/** 标题行解析结果：去掉标记与自定义 ID 后的文字，以及可选的锚点 ID。 */
export interface HeadingText {
  text: string
  id: string | null
}

/** 查找标题末尾的 `{#custom-id}`；返回 ID 与其在整行中的起点。 */
export function findHeadingId(text: string): { id: string; index: number } | null {
  const match = HEADING_ID.exec(text)
  return match ? { id: match[1], index: match.index } : null
}

/** 解析 ATX 标题行，得到纯标题文字与自定义 ID。 */
export function parseHeadingLine(line: string): HeadingText {
  const body = line.replace(ATX_PREFIX, '')
  const found = findHeadingId(body)
  const text = (found ? body.slice(0, found.index) : body).trim()
  return { text, id: found?.id ?? null }
}

/** 由标题文字生成锚点标识；保留中英文与数字，空白折叠为连字符。 */
export function slugifyHeading(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/^-+|-+$/g, '')
  return base || 'section'
}

/** 是否为独立的 `[TOC]` 目录标记行。 */
export function isTocLine(line: string): boolean {
  return TOC_LINE.test(line)
}

/** 定义列表定义行的前缀长度（`: `）；不是定义行时返回 0。 */
export function definitionPrefixLength(line: string): number {
  return DEF_ITEM.exec(line)?.[0].length ?? 0
}
