/**
 * 文件读写与指纹工具。
 * 关键点：原子保存、BOM/EOL 往返、路径穿越防护、内容指纹一致性。
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { AppError } from '@shared/errors'
import type { EolStyle } from '@shared/types'

/** 限制按文本读取的单个文件体积。 */
export const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024

/** 为正文、磁盘字节或配置摘要计算 SHA-256 十六进制字符串。 */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 生成供会话等本地记录使用的唯一标识。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** 统一成正斜杠，便于跨平台比较与展示 */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/** 判断 child 是否位于 parent 内（大小写不敏感由 realpath 与平台规则共同保证） */
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 将工作区相对路径解析为绝对路径，并拒绝越界与绝对路径输入 */
export function resolveInside(root: string, relativePath: string): string {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new AppError('INVALID_INPUT', '路径不能为空。')
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    throw new AppError('OUT_OF_SCOPE', '请使用工作区相对路径。')
  }
  const normalized = normalize(relativePath.replace(/^[\\/]+/, ''))
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new AppError('OUT_OF_SCOPE', '路径超出工作区范围。')
  }
  const target = resolve(root, normalized)
  if (!isPathInside(resolve(root), target)) {
    throw new AppError('OUT_OF_SCOPE', '路径超出工作区范围。')
  }
  return target
}

/**
 * 校验真实路径仍在工作区内，防止符号链接逃逸。
 * 目标不存在时校验其最近的存在祖先目录。
 */
export async function assertRealPathInside(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root)
  let probe = target
  for (let i = 0; i < 12; i += 1) {
    try {
      const real = await realpath(probe)
      if (!isPathInside(realRoot, real)) throw new AppError('OUT_OF_SCOPE', '路径通过符号链接指向工作区外。')
      return real
    } catch (error) {
      if (error instanceof AppError) throw error
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return target
}

/** 汇集文本读取后的 LF 正文、原始编码标志、字节数及磁盘指纹。 */
export interface ReadTextResult {
  /** 去除 BOM 并统一换行为 LF 的解码文本。 */
  text: string
  /** 标记原始文本是否带 UTF-8 BOM，以便保存时保留。 */
  hasBom: boolean
  /** 保存时用于恢复磁盘换行风格的标志。 */
  eol: EolStyle
  /** 读取时计算的磁盘原始字节指纹。 */
  fingerprint: string
  /** 关联内容占用的大小，单位为字节。 */
  size: number
}

/** 读取 UTF-8 文本，识别 BOM 与换行风格，并计算磁盘指纹 */
export async function readTextDocument(
  absPath: string,
  maxBytes = MAX_TEXT_FILE_BYTES
): Promise<ReadTextResult> {
  const info = await stat(absPath).catch(() => null)
  if (!info) throw new AppError('FILE_NOT_FOUND', '文件不存在。')
  if (!info.isFile()) throw new AppError('FILE_NOT_FOUND', '目标不是文件。')
  if (info.size > maxBytes) {
    throw new AppError(
      'INVALID_INPUT',
      `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，暂不支持在编辑器中打开。`
    )
  }
  const buffer = await readFile(absPath)
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const text = buffer.toString(hasBom ? 'utf8' : 'utf8').replace(/^\uFEFF/, '')
  return {
    text,
    hasBom,
    eol: detectEol(text),
    fingerprint: sha256(buffer),
    size: info.size
  }
}

/** BF/CR 混合统计，返回主导换行风格 */
export function detectEol(text: string): EolStyle {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  if (crlf === 0 && lf === 0) return 'lf'
  if (crlf > 0 && lf > 0) return 'mixed'
  return crlf > 0 ? 'crlf' : 'lf'
}

/** 统一正文换行符为编辑器使用的 LF。 */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 按会话记录的风格转换为落盘文本（混合换行按主导风格保存） */
export function toDiskText(text: string, eol: EolStyle, hasBom: boolean): Buffer {
  let output = text
  if (eol === 'crlf') output = text.replace(/\r?\n/g, '\r\n')
  return Buffer.from(`${hasBom ? '\uFEFF' : ''}${output}`, 'utf8')
}

/**
 * 原子写入：同目录临时文件 + fsync + rename。
 * Windows 下 Node 的 rename 使用 MoveFileEx 替换目标，避免半截文件。
 */
export async function atomicWriteFile(absPath: string, data: Buffer | string): Promise<void> {
  const dir = dirname(absPath)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${randomUUID().slice(0, 8)}.mdide.tmp`)
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, absPath)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw new AppError('SAVE_FAILED', '写入目标文件失败，请检查文件锁或磁盘权限。', {
      details: error instanceof Error ? error.message : String(error)
    })
  }
}

/** 排他创建，避免“先检查后写入”的竞态 */
export async function exclusiveWriteFile(absPath: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  try {
    await writeFile(absPath, data, { flag: 'wx' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new AppError('FILE_EXISTS', '目标位置已存在同名文件。')
    throw new AppError('SAVE_FAILED', '创建文件失败。', {
      details: error instanceof Error ? error.message : String(error)
    })
  }
}

/** 检查路径是否可访问；不可访问时返回 false。 */
export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 复制到应用恢复区，保留原文件名与时间戳前缀 */
export async function copyToRecovery(
  recoveryDir: string,
  sourcePath: string,
  ticket: string
): Promise<string> {
  const targetDir = join(recoveryDir, ticket)
  await mkdir(targetDir, { recursive: true })
  const target = join(targetDir, `${Date.now()}-${sourcePath.split(/[\\/]/).pop() ?? 'file'}`)
  await copyFile(sourcePath, target)
  return target
}
