/**
 * 开发期视觉验证脚本：仅在显式设置环境变量时运行，用于自动化截图与端到端检查。
 * 生产运行不会触发任何逻辑。
 */

import { writeFile } from 'node:fs/promises'
import { clipboard } from 'electron'
import type { BrowserWindow } from 'electron'
import { logger } from '../utils/logger'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function clickByText(window: BrowserWindow, text: string, selector = 'button'): Promise<boolean> {
  const result = (await window.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) =>
        (item.textContent || '').trim().includes(${JSON.stringify(text)})
      );
      if (!target) return false;
      target.click();
      return true;
    })()
  `)) as boolean
  return result
}

/** 准备界面状态：主题、模式、侧栏、Provider 重置 */
async function prepareUi(window: BrowserWindow): Promise<void> {
  const mode = process.env.MDIDE_UI_MODE
  const theme = process.env.MDIDE_UI_THEME
  const resetProvider = process.env.MDIDE_UI_RESET_PROVIDER === '1'
  const aiCollapsed = process.env.MDIDE_UI_AI_COLLAPSED
  const leftTab = process.env.MDIDE_UI_LEFT_TAB
  const provider = process.env.MDIDE_UI_PROVIDER
  const splitRatio = process.env.MDIDE_UI_SPLIT_RATIO
  if (mode || resetProvider || aiCollapsed || leftTab || provider || splitRatio) {
    await window.webContents.executeJavaScript(`
      (() => {
        ${mode ? `localStorage.setItem('moye.mode', ${JSON.stringify(mode)});` : ''}
        ${resetProvider ? "localStorage.removeItem('moye.provider');" : ''}
        ${aiCollapsed ? `localStorage.setItem('moye.aiCollapsed', ${JSON.stringify(aiCollapsed)});` : ''}
        ${leftTab ? `localStorage.setItem('moye.leftTab', ${JSON.stringify(leftTab)});` : ''}
        ${provider ? `localStorage.setItem('moye.provider', ${JSON.stringify(provider)});` : ''}
        ${
          splitRatio === 'reset'
            ? "localStorage.removeItem('moye.splitRatio');"
            : splitRatio
              ? `localStorage.setItem('moye.splitRatio', ${JSON.stringify(splitRatio)});`
              : ''
        }
        ${
          splitRatio === 'reset'
            ? "localStorage.removeItem('moye.splitRatio');"
            : splitRatio
              ? `localStorage.setItem('moye.splitRatio', ${JSON.stringify(splitRatio)});`
              : ''
        }
        return true;
      })()
    `)
    if (theme) {
      await window.webContents.executeJavaScript(
        `window.api.settings.update({ appearance: { themeMode: ${JSON.stringify(theme)} } }); true;`
      )
    }
    await window.webContents.executeJavaScript('location.reload(); true;')
    await delay(1700)
  } else if (theme) {
    await window.webContents.executeJavaScript(
      `window.api.settings.update({ appearance: { themeMode: ${JSON.stringify(theme)} } }); true;`
    )
    await window.webContents.executeJavaScript('location.reload(); true;')
    await delay(1700)
  }
}

/** 驱动开发窗口进入指定场景并为视觉检查生成截图。 */
export async function runVisualHarness(window: BrowserWindow): Promise<void> {
  const target = process.env.MDIDE_SCREENSHOT_OUT
  if (!target) return
  await delay(Number(process.env.MDIDE_SCREENSHOT_DELAY ?? 2400))
  try {
    await prepareUi(window)

    // 打开“关于”弹窗，用于核对品牌图标是否随主题切换
    if (process.env.MDIDE_UI_OPEN_ABOUT === '1') {
      await clickByText(window, '帮助')
      await delay(250)
      await clickByText(window, '关于小彭友', '.popup button')
      await delay(700)
    }

    // 从当前弹窗再开一层子弹窗，可选再关掉它，用于验证是否退回上一层
    if (process.env.MDIDE_UI_MODAL_CHILD) {
      await clickByText(window, process.env.MDIDE_UI_MODAL_CHILD, '.modal button')
      await delay(700)
      if (process.env.MDIDE_UI_MODAL_CLOSE === '1') {
        await window.webContents.executeJavaScript(`
          (() => {
            const btn = document.querySelector('.modal [aria-label="关闭"]');
            if (!btn) return false;
            btn.click();
            return true;
          })()
        `)
        await delay(600)
      }
    }

    if (process.env.MDIDE_UI_OPEN_FILE) {
      await window.webContents.executeJavaScript(
        `window.api.documents.openPath(${JSON.stringify(process.env.MDIDE_UI_OPEN_FILE)}).catch(() => null); true;`
      )
      await delay(2200)
    }

    if (process.env.MDIDE_UI_SCROLL) {
      await window.webContents.executeJavaScript(`
        (() => {
          const scroller = document.querySelector('.cm-scroller');
          if (scroller) scroller.scrollTop = ${Number(process.env.MDIDE_UI_SCROLL)};
          return true;
        })()
      `)
      await delay(1000)
    }

    if (process.env.MDIDE_UI_AI_PROMPT) {
      await window.webContents.executeJavaScript(`
        (() => {
          const area = document.querySelector('.ai-input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(area, ${JSON.stringify(process.env.MDIDE_UI_AI_PROMPT)});
          area.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('.send-btn').click();
          return true;
        })()
      `)
      await delay(Number(process.env.MDIDE_UI_AI_WAIT ?? 8000))
    }

    if (process.env.MDIDE_UI_PREDICT === '1') {
      await clickByText(window, '续写一句')
      await delay(Number(process.env.MDIDE_UI_PREDICT_WAIT ?? 6000))
    }

    if (process.env.MDIDE_UI_ACCEPT_GHOST === '1') {
      await window.webContents.executeJavaScript(`
        (() => {
          const content = document.querySelector('.cm-content');
          if (!content) return false;
          content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          return true;
        })()
      `)
      await delay(900)
    }

    if (process.env.MDIDE_UI_OPEN_REVIEW === '1') {
      await clickByText(window, '查看差异')
      await delay(1300)
    }

    if (process.env.MDIDE_UI_APPLY === '1') {
      await clickByText(window, '应用修改')
      await delay(1500)
    }

    if (process.env.MDIDE_UI_EXPORT_ITEM) {
      await window.webContents.executeJavaScript(`document.getElementById('exportBtn')?.click(); true;`)
      await delay(400)
      const clicked = await clickByText(window, process.env.MDIDE_UI_EXPORT_ITEM, '.popup button')
      if (!clicked) logger.warn('harness', '未找到导出菜单项', { item: process.env.MDIDE_UI_EXPORT_ITEM })
      await delay(4200)
    }

    if (process.env.MDIDE_UI_MODAL) {
      await window.webContents.executeJavaScript(
        `document.querySelector('[title="外观与主题"]')?.click(); true;`
      )
      await delay(900)
    }

    if (process.env.MDIDE_UI_CLICK_TEXT) {
      await clickByText(window, process.env.MDIDE_UI_CLICK_TEXT)
      await delay(Number(process.env.MDIDE_UI_CLICK_WAIT ?? 1200))
    }

    if (process.env.MDIDE_UI_EVAL) {
      const result = await window.webContents.executeJavaScript(process.env.MDIDE_UI_EVAL)
      logger.info('harness', 'eval 结果', { result })
      await delay(1200)
    }

    // 真实鼠标点击：走 Chromium 输入管线（不是 dispatchEvent），用于验证 CodeMirror
    // 是否会抢走 widget 内的点击。值为 CSS 选择器，点在元素中心。
    if (process.env.MDIDE_UI_REAL_CLICK) {
      const point = (await window.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector(${JSON.stringify(process.env.MDIDE_UI_REAL_CLICK)});
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        })()
      `)) as { x: number; y: number } | null
      if (point) {
        window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
        window.webContents.sendInputEvent({
          type: 'mouseDown',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1
        })
        window.webContents.sendInputEvent({
          type: 'mouseUp',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1
        })
        await delay(700)
        const probe = await window.webContents.executeJavaScript(`
          (() => ({
            widget: Boolean(document.querySelector('.cm-widget-table')),
            editing: Boolean(document.querySelector('.cm-widget-table.editing')),
            source: (document.querySelector('.cm-content')?.innerText || '').includes('| --- |')
          }))()
        `)
        logger.info('harness', '真实点击后状态', { point, probe })
      } else {
        logger.warn('harness', '真实点击目标不存在', { target: process.env.MDIDE_UI_REAL_CLICK })
      }
    }

    // 模拟输入法组合输入（CDP Input.imeSetComposition），用于复现中文标点导致的光标跳动
    if (process.env.MDIDE_UI_IME) {
      const segments = process.env.MDIDE_UI_IME.split('|')
      const dbg = window.webContents.debugger
      try {
        dbg.attach('1.3')
      } catch {
        // 已附加时忽略
      }
      const probe = async (label: string): Promise<void> => {
        const state = await window.webContents.executeJavaScript(`
          (() => {
            const selection = window.getSelection();
            const content = document.querySelector('.cm-content');
            const active = document.activeElement;
            return {
              text: (content?.innerText || '').slice(0, 80),
              caret: selection?.anchorOffset ?? null,
              node: selection?.anchorNode?.textContent?.slice(0, 40) ?? null,
              activeTag: active?.tagName ?? null,
              activeValue: (active && 'value' in active ? String(active.value) : '').slice(0, 40),
              activeCaret: (active && 'selectionStart' in active ? active.selectionStart : null)
            };
          })()
        `)
        logger.info('harness', `IME ${label}`, { state })
      }
      await probe('开始前')
      // 支持用 | 分隔多段组合，逐段模拟输入法上屏
      for (const text of segments) {
        if (!text) continue
        await dbg.sendCommand('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length
        })
        await delay(280)
        await probe(`组合 ${text}`)
        await dbg.sendCommand('Input.insertText', { text })
        await delay(280)
        await probe(`提交 ${text}`)
      }
      dbg.detach()
    }

    // 复制当前选区（等价于 Ctrl+C），用于验证锁定态的“选中即可复制”
    if (process.env.MDIDE_UI_COPY_SELECTION === '1') {
      window.webContents.copy()
      await delay(500)
      const copied = await clipboard.readText()
      logger.info('harness', '已复制当前选区', { copied: copied.slice(0, 120) })
    }

    // 真实拖放文件到标签栏：CDP 的 dispatchDragEvent 会带上本地路径，可验证拖入打开
    if (process.env.MDIDE_UI_DROP_FILE) {
      const point = (await window.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('.doc-tabs');
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.left + Math.min(120, rect.width / 2)), y: Math.round(rect.top + rect.height / 2) };
        })()
      `)) as { x: number; y: number } | null
      if (point) {
        try {
          window.webContents.debugger.attach('1.3')
        } catch {
          // 调试器已附加时复用
        }
        const data = {
          items: [],
          files: [process.env.MDIDE_UI_DROP_FILE],
          dragOperationsMask: 1
        }
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
            type,
            x: point.x,
            y: point.y,
            data
          })
          await delay(260)
        }
        window.webContents.debugger.detach()
        await delay(1500)
        logger.info('harness', '拖放测试完成', { file: process.env.MDIDE_UI_DROP_FILE, point })
      } else {
        logger.warn('harness', '拖放测试未找到标签栏')
      }
    }

    // 被其他窗口完全遮挡时 capturePage 可能失败：先置顶但不抢焦点
    if (window.isMinimized()) window.restore()
    window.showInactive()
    window.moveTop()
    await delay(300)

    const image = await window.webContents.capturePage()
    await writeFile(target, image.toPNG())
    logger.info('harness', '截图已保存', { target })
  } catch (error) {
    logger.warn('harness', '视觉验证失败', {
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    setTimeout(() => window.destroy(), 250)
    setTimeout(() => process.exit(0), 400)
  }
}
