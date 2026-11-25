/**
 * Markdown 链接定位：供实时预览的双击选中与退格删除使用。
 * 纯函数，只处理单行源码，不依赖 CodeMirror 或浏览器。
 */

/** 一段链接在单行源码中的位置，以及可替换的链接文字区间。 */
export interface LinkRange {
  /** 整段链接语法的起止偏移（相对单行文本）。 */
  from: number
  to: number
  /** 链接文字的起止偏移（相对单行文本）。 */
  textFrom: number
  textTo: number
}

/** `[文字](地址)`，排除 `![图片](地址)` */
const MARKDOWN_LINK = /(?<!!)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
/** `<https://…>` 形式的自动链接 */
const AUTO_LINK = /<((?:https?:\/\/|mailto:)[^\s>]+)>/g
/** `https://…` / `www.` 裸链接 */
const BARE_LINK = /(?:https?:\/\/|www\.)[^\s<>"'`）)】]+/g

/**
 * 判断单行源码中的某个偏移是否落在链接上，并返回整段链接与文字的范围。
 * 偏移取链接任意位置（含文字与语法标记）都会命中。
 */
export function findLinkAt(text: string, offset: number): LinkRange | null {
  for (const pattern of [MARKDOWN_LINK, AUTO_LINK, BARE_LINK]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const from = match.index ?? 0
      const to = from + match[0].length
      if (offset < from || offset > to) continue
      if (pattern === MARKDOWN_LINK) {
        const textFrom = from + 1
        return { from, to, textFrom, textTo: textFrom + match[1].length }
      }
      return { from, to, textFrom: from, textTo: to }
    }
  }
  return null
}

/**
 * 判断选区是否恰好覆盖某段链接的文字；用于让退格/删除清掉整段链接标记。
 */
export function findLinkByTextRange(text: string, from: number, to: number): LinkRange | null {
  const link = findLinkAt(text, from)
  if (!link || link.textFrom !== from || link.textTo !== to) return null
  return link
}

/** 把 `选中文字` 包成链接源码；保留已选文字作为链接文字。 */
export function wrapLinkSource(
  text: string,
  href = 'https://'
): { insert: string; textFrom: number; textTo: number; hrefFrom: number } {
  const insert = `[${text}](${href})`
  return {
    insert,
    textFrom: 1,
    textTo: 1 + text.length,
    hrefFrom: text.length + 3
  }
}
