/**
 * 批量渲染图标变体：用 Electron 自带 Chromium 把 SVG 渲染成 512px PNG。
 * 运行：npx electron scripts/generate-icon-variants.cjs
 */

const { app, BrowserWindow } = require('electron')
const { readFile, writeFile, readdir } = require('node:fs/promises')
const { join } = require('node:path')

app.disableHardwareAcceleration()

const DIR = join(__dirname, '../resources/icon-variants')
const SIZE = 512

app.whenReady().then(async () => {
  const files = (await readdir(DIR)).filter((name) => name.endsWith('.svg')).sort()

  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, sandbox: true }
  })

  for (const file of files) {
    const svg = await readFile(join(DIR, file), 'utf8')
    const html = `<!doctype html><html><body style="margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:transparent"><style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}svg{display:block}</style>${svg}</body></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
    const target = join(DIR, file.replace(/\.svg$/, '.png'))
    await writeFile(target, image.toPNG())
    console.log('rendered', target)
  }

  app.quit()
})
