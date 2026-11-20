/**
 * 文稿图片解析：把 mdres:// 地址安全地映射到工作区或文档目录内的真实文件。
 * 允许相对路径与 ../，但真实路径必须仍在授权根目录内。
 */

import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { protocol } from 'electron'
import { AppError } from '@shared/errors'
import type { DocumentService } from './documents/service'
import type { WorkspaceService } from './workspace/service'
import { isPathInside } from './utils/fs'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

/** 在 Electron 就绪前注册文稿与主题资源协议的权限属性。 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'mdres', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: 'mdtheme', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

/** 为文稿图片提供协议解析和导出内嵌入口，使渲染进程无需直接访问磁盘。 */
export class MediaService {
  /** 注入文稿和工作区服务，用于确定图片路径解析的边界。 */
  constructor(
    private readonly documents: DocumentService,
    private readonly workspace: WorkspaceService
  ) {}

  /** 注册 mdres 与 mdtheme 协议处理器 */
  registerProtocols(themeDir: () => string): void {
    protocol.handle('mdres', async (request) => {
      try {
        const url = new URL(request.url)
        const documentId = url.hostname
        const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        const abs = await this.resolveForDocument(documentId, relativePath)
        const data = await readFile(abs)
        return new Response(data, {
          headers: {
            'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-cache'
          }
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })

    protocol.handle('mdtheme', async (request) => {
      try {
        const url = new URL(request.url)
        const themeId = url.hostname
        if (!/^theme_[a-z0-9]+$/i.test(themeId)) return new Response('Forbidden', { status: 403 })
        const root = themeDir()
        const abs = resolve(root, themeId, decodeURIComponent(url.pathname.replace(/^\/+/, '')))
        if (!isPathInside(resolve(root, themeId), abs)) return new Response('Forbidden', { status: 403 })
        const data = await readFile(abs)
        return new Response(data, {
          headers: { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' }
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }

  /** 把文稿中的图片引用解析为主进程可读取的资源位置。 */
  async resolveForDocument(documentId: string, relativePath: string): Promise<string> {
    const session = this.documents.getSession(documentId)
    if (!session.absPath) throw new AppError('FILE_NOT_FOUND', '文档尚未保存，无法解析相对图片。')
    const docDir = dirname(session.absPath)
    const workspace = this.workspace.getCurrent()
    const root = workspace && isPathInside(workspace.rootPath, session.absPath) ? workspace.rootPath : docDir
    const target = resolve(docDir, relativePath)
    if (!isPathInside(root, target)) throw new AppError('OUT_OF_SCOPE', '图片路径超出授权目录。')
    const real = await realpath(target).catch(() => null)
    if (!real) throw new AppError('FILE_NOT_FOUND', '图片不存在。')
    const realRoot = await realpath(root).catch(() => root)
    if (!isPathInside(realRoot, real)) throw new AppError('OUT_OF_SCOPE', '图片路径超出授权目录。')
    if (!MIME[extname(real).toLowerCase()]) throw new AppError('INVALID_INPUT', '不支持的图片类型。')
    return real
  }

  /** 导出 HTML 前把本地图片内联为 data URL，保证文件可离线打开 */
  async inlineImages(documentId: string, urls: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const url of urls.slice(0, 60)) {
      try {
        if (!url.startsWith('mdres://')) continue
        const parsed = new URL(url)
        const relativePath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
        const abs = await this.resolveForDocument(documentId, relativePath)
        const data = await readFile(abs)
        result[url] = `data:${MIME[extname(abs).toLowerCase()]};base64,${data.toString('base64')}`
      } catch {
        // 单张图片失败不影响整体导出
      }
    }
    return result
  }
}
