/**
 * 应用图标定位：开发环境取项目 resources/，打包后取 asar 内或 resources/ 下的 icon.png。
 * 这里用的是主图标（白底 A），供托盘、窗口、系统通知使用；应用内深色主题另取 icon-dark.png。
 */

import { existsSync } from 'node:fs'
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
