/**
 * 生成应用图标 PNG：用 Electron 自带的 Chromium 渲染 SVG，避免引入额外图形依赖。
 * 运行：electron scripts/generate-icon.cjs
 */

const { app, BrowserWindow } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = await readFile(join(__dirname, '../resources/icon.svg'), 'utf8')
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, sandbox: true }
  })
  const html = `<!doctype html><html><body style="margin:0;width:512px;height:512px;overflow:hidden;background:transparent"><style>html,body{margin:0;padding:0;width:512px;height:512px;overflow:hidden}svg{display:block}</style>${svg}</body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  await writeFile(join(__dirname, '../resources/icon.png'), image.toPNG())
  console.log('icon written')
  app.quit()
})
