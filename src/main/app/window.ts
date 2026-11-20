/**
 * 主窗口与安全边界：无 Node 的沙箱渲染进程、受限导航、生产环境 CSP。
 */

import { join } from 'node:path'
import { BrowserWindow, Menu, session, shell } from 'electron'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

/** 创建并配置主窗口，加载开发服务器或打包后的渲染入口。 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 950,
    minHeight: 620,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#ffffff',
    title: '小彭友',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev
    }
  })

  Menu.setApplicationMenu(null)

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] 渲染进程异常退出', details.reason)
  })

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** 生产环境统一 CSP；开发环境交由 Vite 处理热更新 */
export function applyContentSecurityPolicy(): void {
  if (isDev) return
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: mdres: mdtheme: https:",
    "font-src 'self' data: mdtheme:",
    "media-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}

/** 拒绝所有默认权限申请（摄像头、麦克风、通知等） */
export function lockDownPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}
