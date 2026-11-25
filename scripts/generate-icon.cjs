/**
 * 生成应用图标 PNG：用 Electron 自带的 Chromium 渲染 SVG，避免引入额外图形依赖。
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/generate-icon.cjs
 * 说明：本机 ELECTRON_RUN_AS_NODE 会让 electron 以 node 方式启动，需先 unset。
 */

const { app, BrowserWindow } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

app.disableHardwareAcceleration()

/** 主图标是白底 A（托盘/窗口/安装包统一用它），深色版只给应用内深色主题用 */
const TARGETS = [
  { svg: 'icon.svg', png: 'icon.png' },
  { svg: 'icon-dark.svg', png: 'icon-dark.png' }
]

const SIZE = 512

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, sandbox: true }
  })

  for (const target of TARGETS) {
    const svg = await readFile(join(__dirname, '../resources', target.svg), 'utf8')
    const html = `<!doctype html><html><body style="margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:transparent"><style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}svg{display:block}</style>${svg}</body></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
    await writeFile(join(__dirname, '../resources', target.png), image.toPNG())
    console.log('icon written:', target.png)
  }

  app.quit()
})
