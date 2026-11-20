/** markdown-it-footnote 暂无官方类型声明，仅使用默认导出插件 */
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it'
  const footnote: MarkdownIt.PluginSimple
  /** 供预览渲染器注册 Markdown 脚注的插件。 */
  export default footnote
}
