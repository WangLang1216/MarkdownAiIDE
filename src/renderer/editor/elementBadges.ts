/**
 * 元素在紧凑位置使用的记号。
 * 侧栏元素格与顶栏工具条共用同一套映射，避免同一元素在两处出现不同符号。
 */

import type { SnippetDefinition } from './snippets'

/** 基础元素没有自带 glyph，按 id 补一个能一眼认出的文字记号。 */
const BASIC_GLYPHS: Record<string, string> = {
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  paragraph: '¶',
  ordered: '1.',
  tasks: '☑',
  code: '{}',
  table: '▦',
  image: '▧',
  link: '↗',
  hr: '—'
}

/** 没有 glyph 的元素回退到线性图标。 */
const ELEMENT_ICONS: Record<string, string> = {
  quote: 'quote',
  list: 'list',
  tasks: 'tasks',
  code: 'code',
  table: 'table',
  image: 'image',
  link: 'link',
  mermaid: 'workflow'
}

/** 返回元素优先展示的文字记号；没有时返回 undefined。 */
export function snippetGlyph(snippet: SnippetDefinition): string | undefined {
  return snippet.glyph ?? BASIC_GLYPHS[snippet.id]
}

/** 返回元素使用的线性图标；仅在 snippetGlyph 为空时使用。 */
export function snippetIcon(snippet: SnippetDefinition): string {
  return snippet.icon ?? ELEMENT_ICONS[snippet.id] ?? 'file'
}

/**
 * 顶栏工具条没有文字标签，优先用线性图标：
 * ▦ / ▧ 这类近似记号在 12px 下几乎分不出表格和图片。
 */
export function snippetToolbarBadge(snippet: SnippetDefinition): {
  glyph?: string
  icon?: string
} {
  const icon = snippet.icon ?? ELEMENT_ICONS[snippet.id]
  if (icon) return { icon }
  const glyph = snippet.glyph ?? BASIC_GLYPHS[snippet.id]
  return glyph ? { glyph } : {}
}
