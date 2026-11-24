/**
 * 段落拆分：以文本里的换行符（回车）为段落边界，不按视觉行切。
 * 编辑器开启自动折行后，一个段落会占多行显示但仍只有一个换行符，必须算作一段。
 */

/** 行首块级标记：标题、引用、有序/无序列表与任务列表。 */
const BLOCK_MARKER = /^\s*(?:#{1,6}\s+|>\s*|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/

/** 剥离行首标记并去掉首尾空白；空行返回空串。 */
export function paragraphText(line: string): string {
  return line.replace(BLOCK_MARKER, '').trim()
}

/**
 * 把一段源码按回车拆成独立段落。
 * 连续空行、末尾回车都不会产生空段落，避免生成空列表项/空标题。
 */
export function splitParagraphs(text: string): string[] {
  const paragraphs: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const content = paragraphText(line)
    if (content) paragraphs.push(content)
  }
  return paragraphs
}
