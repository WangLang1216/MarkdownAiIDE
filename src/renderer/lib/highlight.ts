/**
 * 共享的 highlight.js 实例：预览、代码块 Widget 与导出使用同一套语言注册。
 */

import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import python from 'highlight.js/lib/languages/python'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import markdownLang from 'highlight.js/lib/languages/markdown'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import diff from 'highlight.js/lib/languages/diff'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdownLang)
hljs.registerLanguage('md', markdownLang)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('php', php)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('diff', diff)

/**
 * Markdown 里的写法与语法名的差异。jsonl / ndjson 没有独立语法，
 * 用 json 逐行着色即可。
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  jsonl: 'json',
  ndjson: 'json',
  'c++': 'cpp',
  'c#': 'csharp',
  'objective-c': 'c',
  golang: 'go'
}

/** 把 Markdown 里写的语言标识映射到已注册的语法名。 */
export function resolveLanguage(language: string): string {
  const key = language.trim().toLowerCase()
  return LANGUAGE_ALIASES[key] ?? key
}

/** 按语言高亮代码；不支持的语言走转义回退。 */
export function highlightCode(code: string, language: string): string {
  const resolved = resolveLanguage(language)
  if (resolved && hljs.getLanguage(resolved)) {
    try {
      return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
    } catch {
      return escape(code)
    }
  }
  return escape(code)
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 重导出配置后的高亮实例供 Markdown 和编辑器复用。 */
export { hljs }
