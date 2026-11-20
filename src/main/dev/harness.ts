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
