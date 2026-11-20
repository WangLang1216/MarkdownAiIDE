/**
 * 开发态数据目录隔离。
 *
 * 未打包运行时如果和已安装版本共用 %APPDATA%\<应用名>，两个进程会争用同一份
 * 单实例锁与 Chromium 磁盘缓存：后来的进程要么静默退出，要么在控制台刷出
 * "Unable to move the cache: 拒绝访问。(0x5)" / "Unable to create cache"。
 * 因此开发与预览改用独立目录，并在首次启动时从正式目录复制少量用户配置，
 * 避免每次重新填写模型服务。
 */

import { app } from 'electron'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 开发专用目录名，与正式目录并列，便于用户自行清理或对比。 */
const DEV_DIR_NAME = '墨页-dev'
/** 只迁移与使用习惯相关的配置，缓存、会话、日志一律不复用。 */
const SEED_FILES = ['settings.json', 'providers.json', 'styles.json']
/**
 * Chromium 的 OSCrypt 主密钥（DPAPI 加密后）保存在 Local State 的 os_crypt 字段，
 * 缺少它时 secrets/ 里的凭据只能解出乱码，因此首次迁移必须带上。
 */
const SEED_LOCAL_STATE = 'Local State'
const SEED_DIRS = ['secrets']

/**
 * 未打包运行时把 userData 指向独立目录。
 * 必须在任何 getPath('userData') 和 requestSingleInstanceLock() 之前调用。
 * 返回实际使用的目录；打包运行时返回 null，表示沿用默认目录。
 */
export function isolateDevUserData(): string | null {
  if (app.isPackaged) return null

  const shared = app.getPath('userData')
  const override = process.env.MOYE_USER_DATA?.trim()
  const target = override
    ? isAbsolute(override)
      ? override
      : resolve(override)
    : join(app.getPath('appData'), DEV_DIR_NAME)
  if (target === shared) return null

  try {
    mkdirSync(target, { recursive: true })
    app.setPath('userData', target)
  } catch (error) {
    // 目录不可写时退回默认目录，让启动流程给出真正的错误，而不是在这里中断
    console.warn('[启动] 无法使用开发数据目录，已回退默认目录', {
      target,
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  }
  seedFromSharedProfile(shared, target)
  return target
}

/** 首次运行时继承正式目录的配置；已有配置则完全不动，保证开发数据可独立演化。 */
function seedFromSharedProfile(sharedDir: string, devDir: string): void {
  try {
    if (existsSync(join(devDir, 'settings.json'))) return
    if (!existsSync(sharedDir)) return
    for (const name of [...SEED_FILES, SEED_LOCAL_STATE]) {
      const from = join(sharedDir, name)
      const to = join(devDir, name)
      if (existsSync(from) && !existsSync(to)) cpSync(from, to)
    }
    for (const name of SEED_DIRS) {
      const from = join(sharedDir, name)
      if (existsSync(from)) cpSync(from, join(devDir, name), { recursive: true })
    }
  } catch (error) {
    // 迁移失败只影响首次体验，不应阻塞启动
    console.warn('[启动] 复制开发配置失败', error instanceof Error ? error.message : String(error))
  }
}
