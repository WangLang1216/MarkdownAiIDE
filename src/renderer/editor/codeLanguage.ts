/**
 * 代码块语言：常用语言清单 + 粗略的自动识别。
 *
 * 识别是"够用就好"的启发式：按特征命中第一个匹配，命中不了落到纯文本。
 * 目的只是给用户一个合理的默认值，随时可以在弹层里改。
 */

export interface CodeLanguage {
  id: string
  label: string
}

export const CODE_LANGUAGES: CodeLanguage[] = [
  { id: 'txt', label: '纯文本' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'jsonl', label: 'JSON Lines' },
  { id: 'yaml', label: 'YAML' },
  { id: 'bash', label: 'Shell' },
  { id: 'sql', label: 'SQL' },
  { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'swift', label: 'Swift' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'diff', label: 'Diff' }
]

/** 语言标识对应的显示名，未知标识原样返回。 */
export function languageLabel(id: string): string {
  return CODE_LANGUAGES.find((item) => item.id === id)?.label ?? id
}

const RULES: Array<{ id: string; test: RegExp }> = [
  { id: 'diff', test: /^(diff --git |@@ -\d|\+\+\+ |--- )/m },
  { id: 'php', test: /<\?php/ },
  { id: 'html', test: /^\s*<(!doctype|html|head|body|div|section|ul|li|p|span|table)\b/im },
  { id: 'html', test: /<\/[a-z][a-z0-9]*>/i },
  { id: 'css', test: /(^|\n)\s*[.#]?[a-zA-Z-]+\s*\{[^}]*:[^}]*;?[^}]*\}/ },
  { id: 'sql', test: /\b(select\s+[\s\S]+\s+from|insert\s+into|update\s+\w+\s+set|create\s+table)\b/i },
  { id: 'java', test: /\b(public\s+(static\s+)?(class|void|interface)|System\.out\.println|import\s+java\.)/ },
  { id: 'go', test: /\bpackage\s+\w+\s*$|\bfunc\s+\w*\s*\(/m },
  { id: 'rust', test: /\bfn\s+\w+\s*\(|\blet\s+mut\b|println!\s*\(/ },
  { id: 'csharp', test: /\busing\s+System\b|\bnamespace\s+\w+|\bConsole\.WriteLine\b/ },
  { id: 'typescript', test: /\b(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean|void)\b|\bas\s+(const|\w+)\b/ },
  { id: 'javascript', test: /\b(const|let|var)\s+\w+\s*=|\bfunction\b|=>|\bconsole\.log\b|\bimport\s+.+\s+from\s+['"]/ },
  { id: 'python', test: /^\s*(def|class)\s+\w+[\s\S]*:\s*$/m },
  { id: 'python', test: /^\s*(import\s+\w+|from\s+\w+\s+import)\s*$/m },
  { id: 'python', test: /\bself\.|\bprint\s*\(/ },
  { id: 'bash', test: /^#!\// },
  { id: 'bash', test: /\b(sudo\s+\w+|apt-get\s+\w+|npm\s+(run|install)|docker\s+\w+|chmod\s+\d+)\b/ },
  { id: 'bash', test: /^\s*\$\s+\w+/m },
  { id: 'ruby', test: /\bputs\b|^\s*end\s*$/m },
  { id: 'json', test: /^\s*[[{][\s\S]*[\]}]\s*$/ },
  { id: 'markdown', test: /^#{1,6}\s+\S/m },
  { id: 'markdown', test: /^\s*[-*+]\s+\S/m }
]

/** 单行是否是合法 JSON 值 */
function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

/** 从一段选中文本猜测语言标识；判断不出时返回 txt。 */
export function detectCodeLanguage(text: string): string {
  const sample = text.trim()
  if (!sample) return 'txt'
  if (/^\s*[[{]/.test(sample)) {
    try {
      JSON.parse(sample)
      return 'json'
    } catch {
      // 整体不是合法 JSON：可能是 JSON Lines（每行一个对象）
      const lines = sample.split('\n').map((line) => line.trim()).filter(Boolean)
      if (lines.length > 1 && lines.every((line) => isJsonLine(line))) return 'jsonl'
    }
  }
  if (/#include\s*</.test(sample)) {
    return /\b(std::|using\s+namespace|template\s*<|class\s+\w+\s*[:{])/.test(sample) ? 'cpp' : 'c'
  }
  for (const rule of RULES) {
    if (rule.test.test(sample)) return rule.id
  }
  return 'txt'
}
