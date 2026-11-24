/**
 * 插入代码块前的语言选择弹层。
 *
 * 有选中文本时第一项是「自动识别」，默认落在它上面；没有选区时默认落在上次用过的语言上。
 * 键盘 ↑↓ 选择、Enter 确认、Esc 取消；点面板外部或滚动正文也会取消。
 */

import type { EditorView } from '@codemirror/view'
import { CODE_LANGUAGES, languageLabel } from './codeLanguage'

export interface CodeLanguageOptions {
  view: EditorView
  /** 弹层锚点：通常是光标或选区末尾 */
  anchor: number
  /** 自动识别结果；为空表示没有可识别的选中文本 */
  detected: string | null
  /** 上次使用的语言 */
  current: string
  onPick: (language: string) => void
  onCancel?: () => void
}

interface Item {
  id: string
  label: string
  hint: string
  auto?: boolean
}

let opener: (() => void) | null = null

/** 打开语言选择弹层；同一时刻只保留一个。 */
export function pickCodeLanguage(options: CodeLanguageOptions): void {
  opener?.()
  const { view, anchor, detected, current, onPick, onCancel } = options
  const items: Item[] = []
  if (detected) {
    items.push({ id: detected, label: '自动识别', hint: languageLabel(detected), auto: true })
  }
  for (const language of CODE_LANGUAGES) {
    items.push({ id: language.id, label: language.label, hint: language.id })
  }

  const preferred = detected ? 0 : Math.max(0, items.findIndex((item) => item.id === current))
  let active = preferred
  let closed = false

  const dom = document.createElement('div')
  dom.className = 'slash-menu code-lang-menu'
  dom.setAttribute('role', 'listbox')
  dom.setAttribute('aria-label', '选择代码语言')
  const title = document.createElement('div')
  title.className = 'slash-menu-title'
  title.textContent = '选择代码语言'
  const list = document.createElement('div')
  dom.append(title, list)
  document.body.appendChild(dom)

  function render(): void {
    list.innerHTML = items
      .map(
        (item, index) => `
        <button class="slash-item" type="button" data-index="${index}" data-active="${index === active}">
          <span class="slash-glyph">${item.auto ? 'AI' : escapeHtml(item.id.slice(0, 3))}</span>
          <span class="slash-text"><b>${escapeHtml(item.label)}</b></span>
        </button>`
      )
      .join('')
    list.querySelector('.slash-item[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  /** 贴合锚点摆放；锚点滚出可视区时返回 false，由调用方决定是否收起 */
  function place(): boolean {
    const coords = view.coordsAtPos(Math.min(anchor, view.state.doc.length))
    if (!coords) return false
    const margin = 10
    const width = dom.offsetWidth
    const height = dom.offsetHeight
    let left = coords.left
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin
    let top = coords.bottom + 6
    if (top + height > window.innerHeight - margin && coords.top - height - 6 > margin) {
      top = coords.top - height - 6
    }
    dom.style.left = `${Math.max(margin, left)}px`
    dom.style.top = `${Math.max(margin, top)}px`
    return true
  }

  function close(cancelled: boolean): void {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('mousedown', onOutside, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onScroll)
    dom.remove()
    opener = null
    if (cancelled) {
      view.focus()
      onCancel?.()
    }
  }

  function choose(index: number): void {
    const item = items[index]
    if (!item) return
    close(false)
    onPick(item.id)
  }

  function move(delta: number): void {
    active = (active + delta + items.length) % items.length
    render()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      choose(active)
    }
  }

  function onOutside(event: MouseEvent): void {
    if (!dom.contains(event.target as Node)) close(true)
  }

  function onScroll(event: Event): void {
    // 列表自身要能滚（22 个语言放不下），这类滚动直接忽略；
    // 正文滚动则跟着锚点走，而不是一滚就关——滚轮落在哪一侧都不该把面板弄没。
    const target = event.target as Node | null
    if (target && dom.contains(target)) return
    if (!place()) close(true)
  }

  dom.addEventListener('mousedown', (event) => {
    // 不让点击把焦点抢走，编辑器选区保持不变
    event.preventDefault()
    const button = (event.target as HTMLElement | null)?.closest('.slash-item') as HTMLElement | null
    const index = Number(button?.dataset.index)
    if (Number.isNaN(index)) return
    choose(index)
  })

  render()
  place()
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('mousedown', onOutside, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  opener = () => close(true)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;'
  )
}
