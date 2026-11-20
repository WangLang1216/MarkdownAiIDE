/**
 * 脱敏技术日志：只记录任务 ID、耗时、操作数量与错误码，不写文稿正文、图片或密钥。
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { appPaths } from './paths'

type Level = 'info' | 'warn' | 'error'

const MAX_LOG_SIZE = 2 * 1024 * 1024
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]+|api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+)/gi

function redact(message: string): string {
  return message.replace(SECRET_PATTERN, '[已隐藏凭据]')
}

// 串行写入：并发日志排队而不是被丢弃，否则短时间内的关键日志会缺失
let queue: Promise<void> = Promise.resolve()

function writeLine(line: string): Promise<void> {
  queue = queue
    .then(async () => {
      const dir = appPaths().logsDir
      await mkdir(dir, { recursive: true })
      const file = join(dir, 'main.log')
      const info = await stat(file).catch(() => null)
      if (info && info.size > MAX_LOG_SIZE) {
        await rename(file, join(dir, `main-${Date.now()}.log`)).catch(() => undefined)
      }
      await appendFile(file, `${line}\n`, 'utf8')
    })
    .catch(() => undefined)
  return queue
}

function log(level: Level, scope: string, message: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : ''
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${redact(message)}${suffix}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  void writeLine(line)
}

/** 提供主进程日志入口；消息会经过脱敏，调用方不得在附加字段中传递敏感值。 */
export const logger = {
  info: (scope: string, message: string, extra?: Record<string, unknown>) =>
    log('info', scope, message, extra),
  warn: (scope: string, message: string, extra?: Record<string, unknown>) =>
    log('warn', scope, message, extra),
  error: (scope: string, message: string, extra?: Record<string, unknown>) =>
    log('error', scope, message, extra)
}
