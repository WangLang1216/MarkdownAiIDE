/**
 * 参考材料服务：把图片、网页、MD/TXT、DOCX、PDF 解析为可定位的片段。
 * 每个来源都有独立版本、内容指纹与定位信息；模型只能引用已存在的 sourceId/chunkId。
 */

import { readFile, readdir, stat, unlink, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import { app, dialog } from 'electron'
import { pathToFileURL } from 'node:url'
import type {
  AddSourceInput,
  ReferenceRole,
  SourceAsset,
  SourceChunk,
  SourceLocator,
  SourcePreviewChunk,
  WorkspaceInfo
} from '@shared/types'
import { AppError, messageOf } from '@shared/errors'
import { parseSections } from '@shared/markdown/outline'
import { appPaths } from '../utils/paths'
import { sanitizeImageName } from '../utils/image'
import {
  assertRealPathInside,
  atomicWriteFile,
  isPathInside,
  newId,
  normalizeToLf,
  resolveInside,
  sha256,
  toPosix
} from '../utils/fs'
import { logger } from '../utils/logger'
import type { DocumentService } from '../documents/service'
import type { WorkspaceService } from '../workspace/service'
import type { AttachmentService } from '../attachments/service'
import { fetchPage } from './web'

const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const MAX_PDF_PAGES = 200
const CHUNK_SIZE = 1200
const CONTEXT_BUDGET = 14_000

interface StoredSource {
  asset: SourceAsset
  chunks: SourceChunk[]
}

/** 聚合纳入提示的来源文本、原始片段及截断状态。 */
export interface ContextBundle {
  /** 当前记录承载的文本内容。 */
  text: string
  /** 实际纳入上下文的来源片段。 */
  chunks: SourceChunk[]
  /** 标记预算是否阻止部分已选择片段进入提示。 */
  truncated: boolean
  /** 提示和脚注共享的来源标识、名称与短标签映射。 */
  includedSources: Array<{ sourceId: string; title: string; label: string }>
}

/** 负责参考材料导入、切片、预览、上下文组装和证据引用落文。 */
export class ReferenceService {
  private sources = new Map<string, StoredSource>()

  /** 注入文稿与附件服务，以解析已有文稿和图片材料。 */
  constructor(
    private readonly documents: DocumentService,
    private readonly workspace: WorkspaceService,
    private readonly attachments: AttachmentService
  ) {}

  /** 加载本地参考材料索引及相关数据。 */
  async load(): Promise<void> {
    const dir = appPaths().referencesDir
    const files = await readdir(dir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await readFile(join(dir, file), 'utf8').catch(() => null)
      if (!raw) continue
      try {
        const stored = JSON.parse(raw) as StoredSource
        if (stored.asset.status === 'removed') continue
        this.sources.set(stored.asset.sourceId, stored)
      } catch {
        logger.warn('references', '参考材料缓存损坏', { file })
      }
    }
  }

  /** 列出已记录的参考材料元数据。 */
  list(): SourceAsset[] {
    return [...this.sources.values()].map((item) => item.asset).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 按来源 ID 查找参考材料元数据。 */
  get(sourceId: string): StoredSource {
    const stored = this.sources.get(sourceId)
    if (!stored) throw new AppError('SOURCE_OUT_OF_SCOPE', '参考材料不存在或已移除。')
    return stored
  }

  /** 返回指定来源的已解析片段。 */
  chunksOf(sourceId: string): SourceChunk[] {
    return this.get(sourceId).chunks
  }

  /** 生成指定来源的片段预览和位置标签。 */
  preview(sourceId: string): SourcePreviewChunk[] {
    const stored = this.get(sourceId)
    return stored.chunks.slice(0, 40).map((chunk) => ({
      chunkId: chunk.chunkId,
      text: chunk.text.slice(0, 1200),
      label: describeLocator(chunk.locator),
      uncertain: chunk.uncertain
    }))
  }

  /** 更新来源的参考用途并持久化元数据。 */
  async setRoles(sourceId: string, roles: ReferenceRole[]): Promise<SourceAsset> {
    if (!roles.length) throw new AppError('INVALID_INPUT', '至少保留一种用途。')
    const stored = this.get(sourceId)
    stored.asset.roles = roles
    stored.asset.sourceVersion += 1
    stored.chunks = stored.chunks.map((chunk) => ({ ...chunk, sourceVersion: stored.asset.sourceVersion }))
    await this.persist(stored)
    return stored.asset
  }

  /** 按输入类型导入工作文稿、文件、链接或图片，并解析其上下文。 */
  async add(input: AddSourceInput): Promise<SourceAsset> {
    const roles = input.roles?.length ? input.roles : defaultRoles(input.kind)
    if (input.kind === 'web') return this.addWeb(input, roles)
    if (input.kind === 'image') return this.addImage(input, roles)
    if (input.kind === 'document') return this.addDocument(input, roles)
    return this.addFile(input, roles)
  }

  /**
   * 拖入或粘贴的文件：先复制到应用参考目录，再按普通文件解析。
   * 不直接读取渲染进程给出的任意路径，避免扩大文件读取面。
   */
  async addFromBytes(name: string, bytes: ArrayBuffer): Promise<SourceAsset> {
    const buffer = Buffer.from(bytes)
    if (buffer.length === 0) throw new AppError('INVALID_INPUT', '文件内容为空。')
    if (buffer.length > MAX_SOURCE_BYTES) {
      throw new AppError('SOURCE_UNREADABLE', '参考文件超过 15MB 限制。')
    }
    const rawName = basename(name || '参考文件')
    const ext = extname(rawName).toLowerCase()
    if (!['.md', '.markdown', '.txt', '.docx', '.pdf'].includes(ext)) {
      throw new AppError('INVALID_INPUT', '支持 Markdown、TXT、DOCX 与 PDF 文件。')
    }
    const dir = join(appPaths().referencesDir, 'imports', newId('ref'))
    await mkdir(dir, { recursive: true })
    // 复用图片的清洗规则：保留中文、字母数字与短横线
    const safeName = `${sanitizeImageName(rawName)}${ext}`
    const absPath = join(dir, safeName)
    await writeFile(absPath, buffer)
    return this.add({ kind: 'file', path: absPath, roles: ['facts'], title: rawName })
  }

  /** 通过系统选择器添加用户指定的本地参考文件。 */
  async addFileDialog(): Promise<SourceAsset[]> {
    const result = await dialog.showOpenDialog({
      title: '选择参考文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '可读取的文档', extensions: ['md', 'markdown', 'txt', 'docx', 'pdf'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    const added: SourceAsset[] = []
    for (const path of result.filePaths.slice(0, 6)) {
      added.push(await this.add({ kind: 'file', path, roles: ['facts'] }))
    }
    return added
  }

  private async addWeb(input: AddSourceInput, roles: ReferenceRole[]): Promise<SourceAsset> {
    const url = input.url?.trim()
    if (!url) throw new AppError('INVALID_INPUT', '请填写网页链接。')
    const sourceId = newId('src')
    try {
      const page = await fetchPage(url)
      const drafts = chunkParagraphs(page.text, (from, to, headingPath) => ({
        kind: 'document',
        documentId: null,
        relativePath: page.finalUrl,
        revision: null,
        headingPath,
        fromUtf16: from,
        toUtf16: to
      }))
      const chunks = drafts.map((draft, index) => ({
        sourceId,
        sourceVersion: 1,
        chunkId: `${sourceId}:1:${index}`,
        text: draft.text,
        locator: { kind: 'web' as const, finalUrl: page.finalUrl, fragmentId: `frag-${index}` },
        uncertain: false
      }))
      const asset: SourceAsset = {
        sourceId,
        sourceVersion: 1,
        kind: 'web',
        title: input.title?.trim() || page.title,
        roles,
        contentHash: sha256(page.text),
        fetchedAt: page.fetchedAt,
        requestedUrl: url,
        finalUrl: page.finalUrl,
        relativePath: null,
        attachmentId: null,
        status: 'ready',
        message: null,
        chunkCount: chunks.length,
        createdAt: Date.now()
      }
      const stored = { asset, chunks }
      this.sources.set(sourceId, stored)
      await this.persist(stored)
      return asset
    } catch (error) {
      logger.warn('references', '网页解析失败', { message: messageOf(error) })
      throw error instanceof AppError ? error : new AppError('SOURCE_UNREADABLE', messageOf(error))
    }
  }

  private async addImage(input: AddSourceInput, roles: ReferenceRole[]): Promise<SourceAsset> {
    if (!input.attachmentId) throw new AppError('INVALID_INPUT', '缺少图片附件。')
    const attachment = this.attachments.get(input.attachmentId)
    const sourceId = newId('src')
    const locator: SourceLocator = { kind: 'image', attachmentId: attachment.attachmentId, region: null }
    const chunk: SourceChunk = {
      sourceId,
      sourceVersion: 1,
      chunkId: `${sourceId}:1:0`,
      text: `（图片参考：${attachment.name}。图片内容需由支持视觉的模型读取，文字模型无法解析。）`,
      locator,
      uncertain: true
    }
    const asset: SourceAsset = {
      sourceId,
      sourceVersion: 1,
      kind: 'image',
      title: input.title?.trim() || attachment.name,
      roles,
      contentHash: sha256(`${attachment.attachmentId}:${attachment.size}`),
      fetchedAt: null,
      requestedUrl: null,
      finalUrl: null,
      relativePath: null,
      attachmentId: attachment.attachmentId,
      status: 'ready',
      message: '图片参考需要视觉能力；纯文本模型只能看到占位说明。',
      chunkCount: 1,
      createdAt: Date.now()
    }
    const stored = { asset, chunks: [chunk] }
    this.sources.set(sourceId, stored)
    await this.persist(stored)
    return asset
  }

  private async addDocument(input: AddSourceInput, roles: ReferenceRole[]): Promise<SourceAsset> {
    if (!input.documentId) throw new AppError('INVALID_INPUT', '缺少文档标识。')
    const snapshot = await this.documents.syncForAgent(input.documentId)
    const sourceId = newId('src')
    const drafts = chunksFromMarkdown(snapshot.text)
    const chunks = drafts.map((draft, index) => ({
      sourceId,
      sourceVersion: 1,
      chunkId: `${sourceId}:1:${index}`,
      text: draft.text,
      locator: {
        kind: 'document' as const,
        documentId: snapshot.documentId,
        relativePath: snapshot.relativePath,
        revision: snapshot.revision,
        headingPath: (draft.locator as { headingPath: string[] }).headingPath ?? [],
        fromUtf16: (draft.locator as { fromUtf16: number }).fromUtf16,
        toUtf16: (draft.locator as { toUtf16: number }).toUtf16
      },
      uncertain: false
    }))
    const asset: SourceAsset = {
      sourceId,
      sourceVersion: 1,
      kind: 'document',
      title: input.title?.trim() || snapshot.title,
      roles,
      contentHash: snapshot.contentHash,
      fetchedAt: new Date().toISOString(),
      requestedUrl: null,
      finalUrl: null,
      relativePath: snapshot.relativePath,
      attachmentId: null,
      status: 'ready',
      message: null,
      chunkCount: chunks.length,
      createdAt: Date.now()
    }
    const stored = { asset, chunks }
    this.sources.set(sourceId, stored)
    await this.persist(stored)
    return asset
  }

  private async addFile(input: AddSourceInput, roles: ReferenceRole[]): Promise<SourceAsset> {
    const rawPath = input.path?.trim()
    if (!rawPath) throw new AppError('INVALID_INPUT', '缺少文件路径。')
    const workspace = this.workspace.getCurrent()
    const insideWorkspace = workspace ? isPathInside(workspace.rootPath, rawPath) : false
    const absPath = insideWorkspace
      ? await assertRealPathInside(
          workspace!.rootPath,
          isAbsolute(rawPath) ? rawPath : resolveInside(workspace!.rootPath, rawPath)
        ).catch(() => {
          throw new AppError('SOURCE_OUT_OF_SCOPE', '参考文件通过符号链接指向工作区外，已拒绝。')
        })
      : rawPath
    const info = await stat(absPath).catch(() => null)
    if (!info?.isFile()) throw new AppError('SOURCE_UNREADABLE', '参考文件不存在。')
    if (info.size > MAX_SOURCE_BYTES) throw new AppError('SOURCE_UNREADABLE', '参考文件超过 15MB 限制。')
    const ext = extname(absPath).toLowerCase()
    const relativePath = insideWorkspace ? toPosix(relative(workspace!.rootPath, absPath)) : basename(absPath)
    const sourceId = newId('src')

    try {
      if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
        const text = normalizeToLf(await readFile(absPath, 'utf8'))
        const drafts =
          ext === '.txt'
            ? chunkParagraphs(text, paragraphLocator(relativePath))
            : chunksFromMarkdown(text, relativePath)
        const chunks = drafts.map((draft, index) => ({
          sourceId,
          sourceVersion: 1,
          chunkId: `${sourceId}:1:${index}`,
          text: draft.text,
          locator: draft.locator,
          uncertain: false
        }))
        return this.storeFileAsset({
          sourceId,
          title: input.title || basename(absPath),
          roles,
          relativePath,
          contentHash: sha256(text),
          kind: 'file',
          chunks
        })
      }

      if (ext === '.docx') {
        const mammoth = (await import('mammoth')).default as {
          extractRawText(input: {
            buffer: Buffer
          }): Promise<{ value: string; messages: Array<{ message: string }> }>
        }
        const buffer = await readFile(absPath)
        const result = await mammoth.extractRawText({ buffer })
        const text = normalizeToLf(result.value)
        if (!text.trim()) throw new AppError('SOURCE_UNREADABLE', 'DOCX 中没有可提取的文字。')
        const chunks = chunkDocx(text, sourceId)
        return this.storeFileAsset({
          sourceId,
          title: input.title || basename(absPath),
          roles,
          relativePath,
          contentHash: sha256(text),
          kind: 'docx',
          chunks,
          message: result.messages.length ? `DOCX 提取提示：${result.messages[0].message}` : null
        })
      }

      if (ext === '.pdf') {
        const { chunks, scanned } = await extractPdf(await readFile(absPath), sourceId)
        if (!chunks.length)
          throw new AppError(
            'SOURCE_UNREADABLE',
            'PDF 中没有可提取的文字，可能是扫描版，需要 OCR 或视觉模型。'
          )
        return this.storeFileAsset({
          sourceId,
          title: input.title || basename(absPath),
          roles,
          relativePath,
          contentHash: sha256(chunks.map((chunk) => chunk.text).join('\n')),
          kind: 'pdf',
          chunks,
          status: scanned ? 'partial' : 'ready',
          message: scanned ? '部分页面文字过少，可能为扫描页，未能完整读取。' : null
        })
      }

      throw new AppError('SOURCE_UNREADABLE', '只支持 MD、TXT、DOCX、PDF 与图片。')
    } catch (error) {
      logger.warn('references', '文件解析失败', { name: basename(absPath), message: messageOf(error) })
      throw error instanceof AppError ? error : new AppError('SOURCE_UNREADABLE', messageOf(error))
    }
  }

  private async storeFileAsset(input: {
    sourceId: string
    title: string
    roles: ReferenceRole[]
    relativePath: string
    contentHash: string
    kind: 'file' | 'docx' | 'pdf'
    chunks: SourceChunk[]
    status?: 'ready' | 'partial'
    message?: string | null
  }): Promise<SourceAsset> {
    const asset: SourceAsset = {
      sourceId: input.sourceId,
      sourceVersion: 1,
      kind: input.kind,
      title: input.title,
      roles: input.roles,
      contentHash: input.contentHash,
      fetchedAt: new Date().toISOString(),
      requestedUrl: null,
      finalUrl: null,
      relativePath: input.relativePath,
      attachmentId: null,
      status: input.status ?? 'ready',
      message: input.message ?? null,
      chunkCount: input.chunks.length,
      createdAt: Date.now()
    }
    const stored = { asset, chunks: input.chunks }
    this.sources.set(asset.sourceId, stored)
    await this.persist(stored)
    return asset
  }

  /** 移除参考材料及本地索引中的关联数据。 */
  async remove(sourceId: string): Promise<void> {
    this.sources.delete(sourceId)
    await unlink(join(appPaths().referencesDir, `${sourceId}.json`)).catch(() => undefined)
  }

  /** 来源集合摘要：材料变化会让旧提案失效 */
  digest(sourceIds: string[]): string {
    const parts = sourceIds
      .map((id) => this.sources.get(id))
      .filter((item): item is StoredSource => Boolean(item))
      .map((item) => `${item.asset.sourceId}@${item.asset.sourceVersion}#${item.asset.contentHash ?? ''}`)
      .sort()
    return sha256(parts.join('|'))
  }

  /**
   * 按预算组装上下文：优先与查询相关的片段，但每个来源至少保留开头片段。
   * 明确记录被截断的事实，避免宣称“已完整阅读”。
   */
  buildContext(sourceIds: string[], query: string, budget = CONTEXT_BUDGET): ContextBundle {
    const terms = extractTerms(query)
    const included: SourceChunk[] = []
    const lines: string[] = []
    const includedSources: ContextBundle['includedSources'] = []
    let used = 0
    let truncated = false

    for (const sourceId of sourceIds) {
      const stored = this.sources.get(sourceId)
      if (!stored || stored.asset.status === 'failed' || stored.asset.status === 'removed') continue
      const label = `S${includedSources.length + 1}`
      includedSources.push({ sourceId, title: stored.asset.title, label })
      const ranked = [...stored.chunks].sort((a, b) => scoreChunk(b.text, terms) - scoreChunk(a.text, terms))
      const selected: SourceChunk[] = []
      const head = stored.chunks[0]
      if (head) selected.push(head)
      for (const chunk of ranked) {
        if (selected.length >= 6) break
        if (selected.includes(chunk)) continue
        selected.push(chunk)
      }
      for (const chunk of selected) {
        const block = `[${label}] 《${stored.asset.title}》 ${describeLocator(chunk.locator)}\n${chunk.text.trim()}`
        if (used + block.length > budget) {
          truncated = true
          break
        }
        included.push(chunk)
        lines.push(block)
        used += block.length
      }
    }

    return {
      text: lines.join('\n\n'),
      chunks: included,
      truncated,
      includedSources
    }
  }

  /** 将正文中的 [S1] 标记转换为 Markdown 脚注与来源列表 */
  applyCitations(
    markdown: string,
    bundle: ContextBundle
  ): { markdown: string; used: string[]; invalid: string[] } {
    const usedLabels = new Set<string>()
    const invalid: string[] = []
    const labelToSource = new Map(bundle.includedSources.map((item) => [item.label, item]))
    const replaced = markdown.replace(/\[S(\d+)\]/g, (match, raw: string) => {
      const label = `S${raw}`
      const source = labelToSource.get(label)
      if (!source) {
        invalid.push(label)
        return match
      }
      usedLabels.add(label)
      return `[^${label.toLowerCase()}]`
    })
    if (!usedLabels.size) return { markdown, used: [], invalid }

    const definitions: string[] = []
    for (const label of [...usedLabels].sort()) {
      const source = labelToSource.get(label)!
      const stored = this.sources.get(source.sourceId)
      const chunk = bundle.chunks.find((item) => item.sourceId === source.sourceId)
      const location = chunk ? describeLocator(chunk.locator) : '来源'
      const where = stored?.asset.finalUrl ?? stored?.asset.relativePath ?? ''
      const fetched = stored?.asset.fetchedAt ? `，抓取于 ${stored.asset.fetchedAt.slice(0, 10)}` : ''
      definitions.push(
        `[^${label.toLowerCase()}]: 《${source.title}》${where ? ` — ${where}` : ''}（${location}${fetched}）`
      )
    }
    return {
      markdown: `${replaced.replace(/\n+$/, '')}\n\n${definitions.join('\n')}\n`,
      used: [...usedLabels],
      invalid
    }
  }

  private async persist(stored: StoredSource): Promise<void> {
    const dir = appPaths().referencesDir
    await mkdir(dir, { recursive: true })
    await atomicWriteFile(join(dir, `${stored.asset.sourceId}.json`), JSON.stringify(stored, null, 2)).catch(
      (error) => logger.warn('references', '参考材料缓存写入失败', { message: messageOf(error) })
    )
  }
}

function defaultRoles(kind: AddSourceInput['kind']): ReferenceRole[] {
  return kind === 'image' ? ['data'] : ['facts']
}

function extractTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s，。、；：！？,.;:!?（）()「」【】]+/)
        .filter((term) => term.length >= 2)
    )
  ].slice(0, 24)
}

function scoreChunk(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    let index = lower.indexOf(term)
    while (index !== -1) {
      score += 1
      index = lower.indexOf(term, index + term.length)
    }
  }
  return score
}

/** 按章节切块，保留标题路径与源文本范围 */
function chunksFromMarkdown(
  text: string,
  relativePath: string | null = null
): Array<{ text: string; locator: SourceLocator }> {
  const sections = parseSections(text)
  const drafts: Array<{ text: string; locator: SourceLocator }> = []
  if (!sections.length) {
    return chunkParagraphs(text, (from, to) => ({
      kind: 'document',
      documentId: null,
      relativePath,
      revision: null,
      headingPath: [],
      fromUtf16: from,
      toUtf16: to
    }))
  }
  for (const section of sections) {
    const bodyStart = section.headingEnd
    const body = text.slice(bodyStart, section.sectionEnd)
    const heading = text.slice(section.headingStart, section.headingEnd).trim()
    if (body.trim().length > CHUNK_SIZE * 3) {
      const pieces = splitLongText(body, bodyStart)
      for (const piece of pieces) {
        drafts.push({
          text: `${heading}\n\n${piece.text}`,
          locator: {
            kind: 'document',
            documentId: null,
            relativePath,
            revision: null,
            headingPath: section.headingPath,
            fromUtf16: piece.from,
            toUtf16: piece.to
          }
        })
      }
    } else if (body.trim() || heading) {
      drafts.push({
        text: `${heading}\n\n${body.trim()}`.trim(),
        locator: {
          kind: 'document',
          documentId: null,
          relativePath,
          revision: null,
          headingPath: section.headingPath,
          fromUtf16: section.headingStart,
          toUtf16: section.sectionEnd
        }
      })
    }
  }
  return drafts
}

function splitLongText(text: string, baseOffset: number): Array<{ text: string; from: number; to: number }> {
  const pieces: Array<{ text: string; from: number; to: number }> = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + CHUNK_SIZE)
    if (end < text.length) {
      const nextBreak = text.lastIndexOf('\n', end)
      if (nextBreak > cursor + 200) end = nextBreak
    }
    pieces.push({ text: text.slice(cursor, end).trim(), from: baseOffset + cursor, to: baseOffset + end })
    cursor = end
  }
  return pieces
}

function paragraphLocator(relativePath: string | null) {
  return (from: number, to: number): SourceLocator => ({
    kind: 'document',
    documentId: null,
    relativePath,
    revision: null,
    headingPath: [],
    fromUtf16: from,
    toUtf16: to
  })
}

/** 段落聚合切块，保留偏移 */
function chunkParagraphs(
  text: string,
  locator: (from: number, to: number, headingPath: string[]) => SourceLocator
): Array<{ text: string; locator: SourceLocator }> {
  const drafts: Array<{ text: string; locator: SourceLocator }> = []
  const pattern = /[^\n]+(?:\n(?!\n)[^\n]+)*/g
  let match: RegExpExecArray | null
  let buffer = ''
  let start = 0
  let end = 0
  while ((match = pattern.exec(text)) !== null) {
    const block = match[0].trim()
    if (!block) continue
    if (!buffer) {
      buffer = block
      start = match.index
      end = match.index + match[0].length
    } else if (buffer.length + block.length + 2 <= CHUNK_SIZE) {
      buffer += `\n\n${block}`
      end = match.index + match[0].length
    } else {
      drafts.push({ text: buffer, locator: locator(start, end, []) })
      buffer = block
      start = match.index
      end = match.index + match[0].length
    }
  }
  if (buffer) drafts.push({ text: buffer, locator: locator(start, end, []) })
  return drafts
}

function chunkDocx(text: string, sourceId: string): SourceChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
  const chunks: SourceChunk[] = []
  let buffer: string[] = []
  let size = 0
  let startIndex = 0
  const flush = (): void => {
    if (!buffer.length) return
    const index = chunks.length
    chunks.push({
      sourceId,
      sourceVersion: 1,
      chunkId: `${sourceId}:1:${index}`,
      text: buffer.join('\n\n'),
      locator: { kind: 'docx', paragraphId: `p-${startIndex}`, tableId: null },
      uncertain: false
    })
    buffer = []
    size = 0
  }
  paragraphs.forEach((paragraph, index) => {
    if (size + paragraph.length > CHUNK_SIZE) {
      flush()
      startIndex = index
    }
    buffer.push(paragraph)
    size += paragraph.length
  })
  flush()
  return chunks
}

async function extractPdf(
  buffer: Buffer,
  sourceId: string
): Promise<{ chunks: SourceChunk[]; scanned: boolean }> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(input: Record<string, unknown>): { promise: Promise<PdfDocument> }
    GlobalWorkerOptions?: { workerSrc: string }
  }
  if (pdfjs.GlobalWorkerOptions) {
    const root = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
    ).href
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false
  }).promise
  const chunks: SourceChunk[] = []
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES)
  let scannedPages = 0
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text.length < 20) {
      scannedPages += 1
      continue
    }
    for (const piece of splitLongText(text, 0)) {
      const index = chunks.length
      chunks.push({
        sourceId,
        sourceVersion: 1,
        chunkId: `${sourceId}:1:${index}`,
        text: piece.text,
        locator: { kind: 'pdf', page: pageNumber, bbox: null },
        uncertain: false
      })
    }
  }
  await doc.destroy().catch(() => undefined)
  return { chunks, scanned: scannedPages > pages * 0.3 }
}

interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>
  }>
  destroy(): Promise<void>
}

function describeLocator(locator: SourceLocator): string {
  switch (locator.kind) {
    case 'document':
      return locator.headingPath.length
        ? `章节 ${locator.headingPath.join(' › ')}`
        : `字符 ${locator.fromUtf16}–${locator.toUtf16}`
    case 'pdf':
      return `第 ${locator.page} 页`
    case 'docx':
      return `段落 ${locator.paragraphId}`
    case 'web':
      return `网页片段 ${locator.fragmentId}`
    case 'image':
      return '图片区域'
    default:
      return '来源片段'
  }
}

/** 将可空的工作区转换为适合提示展示的名称。 */
export function workspaceLabel(workspace: WorkspaceInfo | null): string {
  return workspace?.name ?? '（未打开工作区）'
}
