/**
 * 导出服务：HTML/Markdown 直接落盘，PDF 使用隐藏沙箱窗口 printToPDF，
 * 其他格式通过 Pandoc 子进程（固定参数数组，shell=false）。
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type {
  ExportPdfInput,
  ExportPdfResult,
  PandocConvertInput,
  PandocConvertResult,
  PandocStatus
} from '@shared/types'
import { AppError } from '@shared/errors'
import { collectImageRefs, rewriteImageRefs, toSafeZipPath } from '@shared/markdown/images'
import { appPaths } from '../utils/paths'
import { atomicWriteFile, newId, pathExists, toPosix } from '../utils/fs'
import { createZip, type ZipEntry } from '../utils/zip'
import { logger } from '../utils/logger'
import type { DocumentService } from '../documents/service'
import type { MediaService } from '../media'
import type { SettingsStore } from '../settings/store'

const PANDOC_TIMEOUT_MS = 120_000
const MAX_HTML_BYTES = 60 * 1024 * 1024
const MAX_INLINE_IMAGE_BYTES = 40 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

function runPandoc(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'pandoc',
      args,
      { timeout: PANDOC_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new AppError('EXPORT_FAILED', 'Pandoc 转换失败。', {
              details: `${error.message}\n${stderr}`.slice(0, 1200)
            })
          )
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

/** 管理本地保存对话框、文稿导出、PDF 打印和 Pandoc 转换。 */
export class ExportService {
  private pandocCache: PandocStatus | null = null

  /** 注入导出需要的文稿、设置与媒体资源服务。 */
  constructor(
    private readonly documents: DocumentService,
    private readonly media: MediaService,
    private readonly settings: SettingsStore
  ) {}

  /** 让用户选择目标路径并保存已组装的 HTML。 */
  async saveHtml(
    html: string,
    suggestedName: string
  ): Promise<{ ok: boolean; path: string | null; message: string }> {
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      throw new AppError('EXPORT_FAILED', '导出内容超过 60MB 限制。')
    }
    const target = await this.pickSavePath(suggestedName, 'html', 'HTML 网页')
    if (!target) return { ok: false, path: null, message: '已取消导出。' }
    await atomicWriteFile(target, html)
    return { ok: true, path: target, message: `已导出 ${basename(target)}` }
  }

  /** 让用户选择目标路径并保存 Markdown 文本。 */
  async saveMarkdown(
    text: string,
    suggestedName: string
  ): Promise<{ ok: boolean; path: string | null; message: string }> {
    const target = await this.pickSavePath(suggestedName, 'md', 'Markdown 文档')
    if (!target) return { ok: false, path: null, message: '已取消导出。' }
    await atomicWriteFile(target, text)
    return { ok: true, path: target, message: `已导出 ${basename(target)}` }
  }

  /** 使用隔离的打印窗口将 HTML 转为 PDF 并保存到用户选定位置。 */
  async savePdf(input: ExportPdfInput): Promise<ExportPdfResult> {
    if (Buffer.byteLength(input.html, 'utf8') > MAX_HTML_BYTES) {
      throw new AppError('EXPORT_FAILED', '导出内容超过 60MB 限制。')
    }
    const target = await this.pickSavePath(input.suggestedName, 'pdf', 'PDF 文档')
    if (!target) return { ok: false, path: null, message: '已取消导出。' }

    const tempDir = join(appPaths().cacheDir, 'exports')
    await mkdir(tempDir, { recursive: true })
    const tempHtml = join(tempDir, `${newId('print')}.html`)
    await writeFile(tempHtml, input.html, 'utf8')

    const window = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webSecurity: true,
        offscreen: true
      }
    })
    try {
      await window.loadFile(tempHtml)
      await new Promise((resolve) => setTimeout(resolve, 450))
      const landscape = Boolean(input.landscape)
      const pageSize = input.pageSize === 'Letter' ? 'Letter' : 'A4'
      const marginMm = Number.isFinite(input.marginMm) ? Math.min(40, Math.max(5, input.marginMm)) : 18
      const paperHeight = pageSize === 'Letter' ? (landscape ? 215.9 : 279.4) : (landscape ? 210 : 297)
      // 打印设置控制纸张与留白，导入主题仍可控制正文样式。
      await window.webContents.insertCSS(
        '@page { size: auto !important; margin: ' + marginMm + 'mm !important; }\n' +
          ':root { --print-media-height: ' + (paperHeight - 2 * marginMm - 14) + 'mm; }'
      )
      const marginInches = marginMm / 25.4
      const pdf = await window.webContents.printToPDF({
        pageSize,
        printBackground: true,
        landscape,
        margins: { top: marginInches, bottom: marginInches, left: marginInches, right: marginInches },
        preferCSSPageSize: false
      })
      await atomicWriteFile(target, pdf)
      return { ok: true, path: target, message: `已导出 ${basename(target)}` }
    } catch (error) {
      logger.error('exports', 'PDF 导出失败', {
        message: error instanceof Error ? error.message : String(error)
      })
      throw new AppError('EXPORT_FAILED', 'PDF 生成失败，请检查内容中的图片或字体。')
    } finally {
      if (!window.isDestroyed()) window.destroy()
      await unlink(tempHtml).catch(() => undefined)
    }
  }

  /**
   * 导出为 zip：Markdown 与本地图片一起打包，保持相对路径，拷到其他电脑可直接打开。
   * 引用超出文稿目录（含 ../）的图片会复制到资源目录并重写链接。
   */
  async saveMarkdownBundle(
    documentId: string,
    text: string,
    suggestedName: string
  ): Promise<{ ok: boolean; path: string | null; message: string }> {
    const session = this.documents.getSession(documentId)
    if (!session.absPath) throw new AppError('INVALID_INPUT', '请先保存文稿，再导出压缩包。')
    const base = basename(suggestedName, extname(suggestedName)) || '未命名'
    const target = await this.pickSavePath(`${base}.zip`, 'zip', 'Markdown 压缩包')
    if (!target) return { ok: false, path: null, message: '已取消导出。' }
    if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) {
      throw new AppError('EXPORT_FAILED', '导出内容超过 60MB 限制。')
    }

    const entries: ZipEntry[] = []
    const mapping = new Map<string, string>()
    const packed = new Map<string, string>()
    let missing = 0
    for (const src of collectImageRefs(text)) {
      try {
        const abs = await this.media.resolveForDocument(documentId, src)
        const already = packed.get(abs)
        if (already) {
          if (already !== src) mapping.set(src, already)
          continue
        }
        const relative = toSafeZipPath(src, basename(abs), this.settings.get().storage.assetsFolder)
        const data = await readFile(abs)
        entries.push({ name: relative, data })
        packed.set(abs, relative)
        if (relative !== src) mapping.set(src, relative)
      } catch {
        missing += 1
      }
    }

    entries.unshift({
      name: `${base}.md`,
      data: Buffer.from(rewriteImageRefs(text, mapping), 'utf8')
    })
    await atomicWriteFile(target, createZip(entries))
    const note = missing ? `（${missing} 张图片缺失，已跳过）` : ''
    return { ok: true, path: target, message: `已导出 ${basename(target)}${note}` }
  }

  /** 导出单文件 Markdown：本地图片内联为 Base64，远程图片保持原链接 */
  async saveMarkdownInline(
    documentId: string,
    text: string,
    suggestedName: string
  ): Promise<{ ok: boolean; path: string | null; message: string }> {
    const base = basename(suggestedName, extname(suggestedName)) || '未命名'
    const target = await this.pickSavePath(`${base}.md`, 'md', 'Markdown 单文件')
    if (!target) return { ok: false, path: null, message: '已取消导出。' }

    const mapping = new Map<string, string>()
    let missing = 0
    let total = 0
    for (const src of collectImageRefs(text)) {
      try {
        const abs = await this.media.resolveForDocument(documentId, src)
        const data = await readFile(abs)
        if (total + data.length > MAX_INLINE_IMAGE_BYTES) {
          missing += 1
          continue
        }
        const mime = MIME_BY_EXT[extname(abs).toLowerCase()] ?? 'application/octet-stream'
        mapping.set(src, `data:${mime};base64,${data.toString('base64')}`)
        total += data.length
      } catch {
        missing += 1
      }
    }

    const output = rewriteImageRefs(text, mapping)
    if (Buffer.byteLength(output, 'utf8') > MAX_HTML_BYTES) {
      throw new AppError('EXPORT_FAILED', '内联后的文件超过 60MB，请改用压缩包导出。')
    }
    await atomicWriteFile(target, output)
    const note = missing ? `（${missing} 张图片缺失或超限，未内联）` : ''
    return { ok: true, path: target, message: `已导出 ${basename(target)}${note}` }
  }

  /** 检查本机 Pandoc 的可用性并返回诊断信息。 */
  async pandocStatus(): Promise<PandocStatus> {
    if (this.pandocCache) return this.pandocCache
    try {
      const { stdout } = await runPandoc(['--version'])
      const version = /pandoc(?:\.exe)?\s+([\d.]+)/i.exec(stdout)?.[1] ?? null
      this.pandocCache = {
        available: true,
        version,
        path: 'pandoc',
        message: `Pandoc ${version ?? ''} 可用`.trim()
      }
    } catch {
      this.pandocCache = {
        available: false,
        version: null,
        path: null,
        message: '未找到 Pandoc。安装后可使用 DOCX、EPUB、LaTeX 等格式转换。'
      }
    }
    return this.pandocCache
  }

  /**
   * 导入：转换为新 Markdown，图片提取到 assets 子目录，不覆盖源文件。
   * 导出：Markdown 转为 DOCX/ODT/EPUB/LaTeX，使用固定参数数组。
   */
  async pandocConvert(input: PandocConvertInput): Promise<PandocConvertResult> {
    const status = await this.pandocStatus()
    if (!status.available) {
      throw new AppError('PANDOC_MISSING', status.message)
    }
    return input.direction === 'import' ? this.pandocImport(input) : this.pandocExport(input)
  }

  private async pandocImport(input: PandocConvertInput): Promise<PandocConvertResult> {
    let sourcePath = input.sourcePath
    if (!sourcePath) {
      const result = await dialog.showOpenDialog({
        title: '导入文档',
        properties: ['openFile'],
        filters: [{ name: '文档', extensions: ['docx', 'odt', 'html', 'htm', 'epub'] }]
      })
      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, outputPath: null, warnings: [], message: '已取消导入。' }
      }
      sourcePath = result.filePaths[0]
    }
    if (!(await pathExists(sourcePath))) throw new AppError('FILE_NOT_FOUND', '待导入文件不存在。')
    const ext = extname(sourcePath).toLowerCase().replace('.', '')
    const reader = ext === 'htm' ? 'html' : ext
    if (!['docx', 'odt', 'html', 'epub'].includes(reader)) {
      throw new AppError('INVALID_INPUT', '支持导入 DOCX、ODT、HTML、EPUB。')
    }

    const target = await this.pickSavePath(
      `${basename(sourcePath, extname(sourcePath))}.md`,
      'md',
      '导入为 Markdown'
    )
    if (!target) return { ok: false, outputPath: null, warnings: [], message: '已取消导入。' }

    const mediaDir = join(dirname(target), 'assets', basename(target, '.md'))
    await mkdir(mediaDir, { recursive: true })
    const tempOut = join(appPaths().cacheDir, `${newId('import')}.md`)
    const { stderr } = await runPandoc([
      sourcePath,
      '-f',
      reader,
      '-t',
      'gfm',
      '--wrap=none',
      '--extract-media',
      mediaDir,
      '-o',
      tempOut
    ])
    let markdown = await readFile(tempOut, 'utf8').catch(() => '')
    await unlink(tempOut).catch(() => undefined)
    if (!markdown.trim()) throw new AppError('EXPORT_FAILED', '转换结果为空，源文件可能没有可提取内容。')

    // Pandoc 写出的媒体路径改为工作区相对路径
    const relativeMedia = toPosix(relative(dirname(target), mediaDir))
    markdown = markdown
      .split(toPosix(mediaDir))
      .join(relativeMedia)
      .split(mediaDir)
      .join(relativeMedia)
      .split(`file:///${toPosix(mediaDir)}`)
      .join(relativeMedia)
    await atomicWriteFile(target, markdown)
    const warnings = stderr.trim() ? [stderr.trim().slice(0, 600)] : []
    return {
      ok: true,
      outputPath: target,
      markdown,
      warnings,
      message: `已导入为 ${basename(target)}${warnings.length ? '（存在转换提示）' : ''}`
    }
  }

  private async pandocExport(input: PandocConvertInput): Promise<PandocConvertResult> {
    if (!input.markdown?.trim()) throw new AppError('EXPORT_FAILED', '没有可导出的内容。')
    const format = input.format
    const extension = format === 'latex' ? 'tex' : format
    const target = await this.pickSavePath(
      input.suggestedName ?? `导出.${extension}`,
      extension,
      `导出 ${format.toUpperCase()}`
    )
    if (!target) return { ok: false, outputPath: null, warnings: [], message: '已取消导出。' }

    const tempMd = join(appPaths().cacheDir, `${newId('export')}.md`)
    await writeFile(tempMd, input.markdown, 'utf8')
    const args = [tempMd, '-f', 'gfm', '-o', target]
    if (format === 'docx' && input.referenceDocPath && (await pathExists(input.referenceDocPath))) {
      args.push('--reference-doc', input.referenceDocPath)
    }
    if (format === 'latex') args.push('-s')
    try {
      const { stderr } = await runPandoc(args)
      return {
        ok: true,
        outputPath: target,
        warnings: stderr.trim() ? [stderr.trim().slice(0, 600)] : [],
        message: `已导出 ${basename(target)}`
      }
    } finally {
      await unlink(tempMd).catch(() => undefined)
    }
  }

  private async pickSavePath(
    suggestedName: string,
    extension: string,
    label: string
  ): Promise<string | null> {
    const safeName = basename(suggestedName || `未命名.${extension}`)
    const withExt = extname(safeName) ? safeName : `${safeName}.${extension}`
    const result = await dialog.showSaveDialog({
      title: label,
      defaultPath: join(appPaths().userData, withExt),
      filters: [{ name: label, extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  }
}
