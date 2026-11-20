/**
 * 应用图标定位：开发环境取项目 resources/，打包后取 asar 内或 resources/ 下的 icon.png。
 * 托盘与“关于”弹窗共用同一份图标，避免多处维护。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/** 在当前运行环境的候选路径中查找应用图标。 */
export function appIconPath(): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', 'icon.png'),
    join(__dirname, '../../resources/icon.png'),
    join(process.cwd(), 'resources', 'icon.png'),
    join(process.resourcesPath, 'resources', 'icon.png'),
    join(process.resourcesPath, 'icon.png')
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

let cached: string | null | undefined

/** 关于弹窗使用的 data URL；读取失败时返回 null，界面回退到文字标记 */
export async function appIconDataUrl(): Promise<string | null> {
  if (cached !== undefined) return cached
  const path = appIconPath()
  if (!path) {
    cached = null
    return cached
  }
  try {
    cached = `data:image/png;base64,${(await readFile(path)).toString('base64')}`
  } catch {
    cached = null
  }
  return cached
}
