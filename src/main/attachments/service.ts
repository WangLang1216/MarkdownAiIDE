/**
 * 附件服务：只接受用户主动提供的图片，校验真实文件头与大小，保存在任务独立目录中。
 * 原图不被改写；缩略预览由渲染进程按 data URL 展示。
 */

import { readFile, readdir, unlink, writeFile, mkdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { dialog } from 'electron'
import type { Attachment } from '@shared/types'
import { AppError } from '@shared/errors'
import { appPaths } from '../utils/paths'
import { newId, sha256 } from '../utils/fs'
import { logger } from '../utils/logger'

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const ALLOWED = new Map<string, string>([
  ['89504e47', 'image/png'],
  ['ffd8ff', 'image/jpeg'],
  ['47494638', 'image/gif']
])

function sniffMime(buffer: Buffer): string | null {
  const hex = buffer.subarray(0, 8).toString('hex')
  for (const [magic, mime] of ALLOWED) {
    if (hex.startsWith(magic)) return mime
  }
  // WebP: RIFF....WEBP
  if (hex.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function extensionFor(mime: string): string {
  return mime === 'image/png'
    ? '.png'
    : mime === 'image/jpeg'
      ? '.jpg'
      : mime === 'image/gif'
        ? '.gif'
        : '.webp'
}

interface AttachmentMeta {
  attachmentId: string
  name: string
  mime: string
  size: number
  hash: string
  createdAt: number
  taskId?: string
}

/** 管理任务附件的本地缓存、元数据、读取和过期清理。 */
export class AttachmentService {
  private items = new Map<string, Attachment>()
  private loaded = false

  /** 从磁盘加载附件元数据索引。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const dir = appPaths().attachmentsDir
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = await readFile(join(dir, entry.name, 'meta.json'), 'utf8').catch(() => null)
      if (!meta) continue
      try {
        const parsed = JSON.parse(meta) as AttachmentMeta
        this.items.set(parsed.attachmentId, {
          attachmentId: parsed.attachmentId,
          name: parsed.name,
          mime: parsed.mime,
          size: parsed.size,
          createdAt: parsed.createdAt
        })
      } catch {
        // 忽略损坏的元数据
      }
    }
  }

  /** 列出缓存中的附件元数据。 */
  list(): Attachment[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
  }

  /** 按附件 ID 查询缓存条目。 */
  get(attachmentId: string): Attachment {
    const item = this.items.get(attachmentId)
    if (!item) throw new AppError('FILE_NOT_FOUND', '附件不存在或已被清理。')
    return item
  }

  /** 通过系统文件选择器导入任务附件。 */
  async addFromDialog(): Promise<Attachment[]> {
    const result = await dialog.showOpenDialog({
      title: '选择图片作为参考',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (result.canceled) return []
    const added: Attachment[] = []
    for (const path of result.filePaths.slice(0, 6)) {
      try {
        const buffer = await readFile(path)
        added.push(await this.addBuffer(basename(path), buffer))
      } catch (error) {
        logger.warn('attachments', '图片读取失败', {
          name: basename(path),
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return added
  }

  /** 从提供的文件字节建立本地附件及索引记录。 */
  async addFromBytes(name: string, _mime: string, bytes: ArrayBuffer): Promise<Attachment> {
    return this.addBuffer(name || '粘贴的图片.png', Buffer.from(bytes))
  }

  private async addBuffer(name: string, buffer: Buffer): Promise<Attachment> {
    if (buffer.length === 0) throw new AppError('INVALID_INPUT', '图片内容为空。')
    if (buffer.length > MAX_IMAGE_BYTES) throw new AppError('INVALID_INPUT', '图片超过 12MB 限制。')
    const mime = sniffMime(buffer)
    if (!mime) throw new AppError('INVALID_INPUT', '仅支持 PNG、JPEG、WebP、GIF 图片。')

    const attachmentId = newId('att')
    const dir = join(appPaths().attachmentsDir, attachmentId)
    await mkdir(dir, { recursive: true })
    const safeName = `${newId('img')}${extensionFor(mime)}`
    const filePath = join(dir, safeName)
    await writeFile(filePath, buffer)
    const hash = sha256(buffer)
    const meta: AttachmentMeta = {
      attachmentId,
      name: name.slice(0, 120),
      mime,
      size: buffer.length,
      hash,
      createdAt: Date.now()
    }
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, filePath }, null, 2), 'utf8')
    const attachment: Attachment = {
      attachmentId,
      name: meta.name,
      mime,
      size: meta.size,
      createdAt: meta.createdAt
    }
    this.items.set(attachmentId, attachment)
    return attachment
  }

  /** 读取附件并编码为可传给界面或模型的 data URL。 */
  async dataUrl(attachmentId: string): Promise<string | null> {
    const dir = join(appPaths().attachmentsDir, attachmentId)
    const raw = await readFile(join(dir, 'meta.json'), 'utf8').catch(() => null)
    if (!raw) return null
    const meta = JSON.parse(raw) as AttachmentMeta & { filePath?: string }
    const filePath = meta.filePath ?? ''
    const buffer = await readFile(filePath).catch(() => null)
    if (!buffer) return null
    return `data:${meta.mime};base64,${buffer.toString('base64')}`
  }

  /** 移除附件记录和对应缓存文件。 */
  async remove(attachmentId: string): Promise<void> {
    this.items.delete(attachmentId)
    const dir = join(appPaths().attachmentsDir, attachmentId)
    await unlink(join(dir, 'meta.json')).catch(() => undefined)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      if (name === 'meta.json') continue
      await unlink(join(dir, name)).catch(() => undefined)
    }
  }

  /** 清理 7 天前且未被任务引用的附件 */
  async cleanup(): Promise<void> {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000
    for (const item of [...this.items.values()]) {
      if (item.createdAt < cutoff) await this.remove(item.attachmentId)
    }
  }

  /** 返回附件文件所用扩展名。 */
  fileExtension(name: string): string {
    return extname(name).toLowerCase()
  }
}
