/**
 * 应用数据目录。所有可写状态都集中在此，文稿原文仍是普通文件。
 */

import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 集中描述用户数据目录及其下各服务的数据、缓存和日志位置。 */
export interface AppPaths {
  /** Electron 用户数据根目录。 */
  userData: string
  /** 应用设置 JSON 文件位置。 */
  settingsFile: string
  /** 非敏感模型配置 JSON 文件位置。 */
  providersFile: string
  /** 写作风格预设 JSON 文件位置。 */
  stylesFile: string
  /** 加密密钥文件位置。 */
  secretsFile: string
  /** 未保存文稿会话的恢复草稿目录。 */
  sessionsDir: string
  /** 变更提案与事务账本目录。 */
  changesDir: string
  /** 执行变更和恢复所用的副本目录。 */
  recoveryDir: string
  /** 主进程本地日志目录。 */
  logsDir: string
  /** 导入主题及其样式、资源的目录。 */
  themesDir: string
  /** 附件缓存和相关索引的目录。 */
  attachmentsDir: string
  /** 参考材料索引与解析产物的目录。 */
  referencesDir: string
  /** 为续写相关数据预留的路径。 */
  predictionsDir: string
  /** 解析后的有效应用缓存目录。 */
  cacheDir: string
  /** 首启演示文稿所在目录。 */
  demoWorkspace: string
}

let cached: AppPaths | null = null

/** 返回当前应用数据和缓存配置对应的路径集合。 */
export function appPaths(): AppPaths {
  if (cached) return cached
  const userData = app.getPath('userData')
  const paths: AppPaths = {
    userData,
    settingsFile: join(userData, 'settings.json'),
    providersFile: join(userData, 'providers.json'),
    stylesFile: join(userData, 'styles.json'),
    secretsFile: join(userData, 'secrets', 'secrets.json'),
    sessionsDir: join(userData, 'sessions'),
    changesDir: join(userData, 'changes'),
    recoveryDir: join(userData, 'recovery'),
    logsDir: join(userData, 'logs'),
    themesDir: join(userData, 'themes'),
    attachmentsDir: join(userData, 'attachments'),
    referencesDir: join(userData, 'references'),
    predictionsDir: join(userData, 'predictions'),
    cacheDir: join(userData, 'cache'),
    demoWorkspace: join(userData, '示例工作区')
  }
  cached = paths
  return paths
}

/** 切换缓存目录（用户在设置中指定）；空值表示回到应用数据目录下的 cache */
export function configureCacheDir(dir: string): boolean {
  const paths = appPaths()
  const value = dir.trim() || join(paths.userData, 'cache')
  try {
    if (!existsSync(value)) mkdirSync(value, { recursive: true })
    paths.cacheDir = value
    return true
  } catch {
    return false
  }
}

/** 首次启动时创建目录结构，失败即终止，避免后续写入随机位置 */
export function ensureAppDirectories(): void {
  const paths = appPaths()
  const dirs = [
    paths.userData,
    paths.sessionsDir,
    paths.changesDir,
    paths.recoveryDir,
    paths.logsDir,
    paths.themesDir,
    paths.attachmentsDir,
    paths.referencesDir,
    paths.predictionsDir,
    paths.cacheDir,
    join(paths.userData, 'secrets')
  ]
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}
