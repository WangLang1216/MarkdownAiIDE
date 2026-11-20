/**
 * 模型可见的文档工具。
 * 只暴露读取与提案能力；写入、保存、恢复由应用内部执行，模型无法直接调用。
 */

import type { ProviderToolDefinition } from '../providers/types'
import type { ChangeOperation, SourceChunk } from '@shared/types'
import { AppError, messageOf } from '@shared/errors'
import { parseOutline, parseSections, countText, toPlainExcerpt } from '@shared/markdown/outline'
import type { DocumentService } from '../documents/service'
import type { WorkspaceService } from '../workspace/service'
import type { ChangeService } from '../changes/service'
import { planOperation } from '../changes/engine'
import type { ReferenceService, ContextBundle } from '../references/service'

const MAX_TOOL_RESULT = 24_000

const cellSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '单元格文字；不要编造未识别的内容' },
    status: {
      type: 'string',
      enum: ['recognized', 'uncertain', 'empty'],
      description: 'uncertain 表示需要人工核对'
    }
  },
  required: ['text', 'status'],
  additionalProperties: false
} as const

const guardSchema = {
  type: 'object',
  properties: {
    documentId: { type: 'string' },
    baseRevision: { type: 'integer', minimum: 0 },
    expectedContentHash: { type: 'string' }
  },
  required: ['documentId', 'baseRevision', 'expectedContentHash'],
  additionalProperties: false
} as const

const anchorSchema = {
  type: 'object',
  properties: {
    sectionId: { type: ['string', 'null'], description: '章节 ID；document_end 时可为 null' },
    position: { type: 'string', enum: ['after_heading', 'section_end', 'document_end'] }
  },
  required: ['sectionId', 'position'],
  additionalProperties: false
} as const

const operationSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { const: 'insert_table' },
        guard: guardSchema,
        anchor: anchorSchema,
        caption: { type: 'string' },
        table: {
          type: 'object',
          properties: {
            columnCount: { type: 'integer', minimum: 1 },
            totalRows: { type: 'integer', minimum: 1, description: '总行数包含表头，不包含 Markdown 分隔行' },
            header: { type: 'array', items: cellSchema },
            rows: { type: 'array', items: { type: 'array', items: cellSchema } }
          },
          required: ['columnCount', 'totalRows', 'header', 'rows'],
          additionalProperties: false
        }
      },
      required: ['kind', 'guard', 'anchor', 'table'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'insert_markdown' },
        guard: guardSchema,
        anchor: anchorSchema,
        markdown: { type: 'string' }
      },
      required: ['kind', 'guard', 'anchor', 'markdown'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'replace_range' },
        guard: guardSchema,
        from: { type: 'integer', minimum: 0 },
        to: { type: 'integer', minimum: 0 },
        expectedOldText: { type: 'string', description: '必须与当前文档该范围完全一致' },
        newText: { type: 'string' }
      },
      required: ['kind', 'guard', 'from', 'to', 'expectedOldText', 'newText'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'create_document' },
        workspaceId: { type: 'string' },
        relativePath: { type: 'string', description: '工作区相对路径，必须以 .md 或 .txt 结尾' },
        content: { type: 'string' },
        ifExists: { const: 'fail' }
      },
      required: ['kind', 'workspaceId', 'relativePath', 'content', 'ifExists'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'delete_document' },
        guard: guardSchema,
        recovery: { const: 'trash_or_recovery' }
      },
      required: ['kind', 'guard', 'recovery'],
      additionalProperties: false
    }
  ]
} as const

/** 定义可传给支持工具调用的模型的工具名和参数 schema。 */
export const AGENT_TOOLS: ProviderToolDefinition[] = [
  {
    name: 'get_active_document',
    description: '读取当前文档的身份、版本、字数、选区与标题大纲。默认不返回整篇正文。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'open_workspace_file',
    description: '按工作区相对路径打开一个 Markdown/TXT 文件用于读取或修改，返回文档 ID、版本、hash 与大纲。',
    parameters: {
      type: 'object',
      properties: { relativePath: { type: 'string' } },
      required: ['relativePath'],
      additionalProperties: false
    }
  },
  {
    name: 'list_workspace_files',
    description: '列出当前工作区内的文本文件（相对路径、大小、是否已打开）。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      additionalProperties: false
    }
  },
  {
    name: 'search_documents',
    description: '在工作区已打开文档与磁盘文本中搜索关键词，返回文件、行号与片段。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 60 }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'get_document_outline',
    description: '获取指定文档（默认当前文档）的标题树与章节 ID。',
    parameters: {
      type: 'object',
      properties: { documentId: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'read_section',
    description: '读取指定章节的精确源文本（含标题行）。',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        sectionId: { type: 'string' }
      },
      required: ['sectionId'],
      additionalProperties: false
    }
  },
  {
    name: 'read_document',
    description: '读取指定文档的文本片段；大文档请优先读章节或指定范围。',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        from: { type: 'integer', minimum: 0 },
        to: { type: 'integer', minimum: 0 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'request_clarification',
    description: '当目标标题、文件或表格行列含义不明确时，先向用户提出一个具体问题。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4 }
      },
      required: ['question'],
      additionalProperties: false
    }
  },
  {
    name: 'propose_changes',
    description:
      '提交修改建议，由应用校验、展示差异并由用户确认后执行。禁止直接声称已修改文件。章节插入点由 sectionId 与 position 指定；表格总行数含表头；无法识别的单元格使用 uncertain。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话说明修改内容与目标位置' },
        operations: { type: 'array', items: operationSchema, minItems: 1, maxItems: 12 }
      },
      required: ['summary', 'operations'],
      additionalProperties: false
    }
  },
  {
    name: 'list_task_sources',
    description: '列出本任务已授权的参考材料及其用途。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'read_source_chunk',
    description: '读取参考材料中的一个片段，用于核对事实或引用。',
    parameters: {
      type: 'object',
      properties: { chunkId: { type: 'string' } },
      required: ['chunkId'],
      additionalProperties: false
    }
  }
]

/** 限定单个任务的文稿、附件、来源及允许访问的文稿集合。 */
export interface ToolContext {
  /** 用于关联任务状态、工具调用及事件的任务标识。 */
  taskId: string
  /** 当前任务初始关联的活动文稿会话标识。 */
  activeDocumentId: string | null
  /** 任务启动时的工作区，阻止切换工作区后改写其他文件。 */
  workspaceId: string | null
  /** 限定工具运行在选区、文稿或工作区范围。 */
  scope: 'selection' | 'document' | 'workspace'
  /** 用于限定上下文或操作目标的当前源码选区。 */
  selection?: { from: number; to: number }
  /** 本次操作选用的附件标识列表。 */
  attachmentIds: string[]
  /** 本次操作关联的参考材料标识列表。 */
  sourceIds: string[]
  /** 本任务已明确允许直接访问的文稿集合。 */
  allowedDocumentIds: Set<string>
  /** 为提案生成证据引用所使用的已选来源上下文。 */
  citationBundle: ContextBundle
}

/** 统一返回工具执行结果、简述、变更提案或澄清请求。 */
export interface ToolOutcome {
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 返回给模型的 JSON 结果 */
  result: unknown
  /** 展示在任务流中的简短说明 */
  summary: string
  /** 与当前工具或任务结果关联的可审阅提案标识。 */
  proposalId?: string
  /** 任务需向用户确认时提供的澄清请求。 */
  clarification?: { question: string; options: string[] }
}

interface Deps {
  documents: DocumentService
  workspace: WorkspaceService
  changes: ChangeService
  references: ReferenceService
}

function clip(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json.length <= MAX_TOOL_RESULT) return value
  return {
    truncated: true,
    note: `结果超过 ${MAX_TOOL_RESULT} 字符已截断，请缩小读取范围。`,
    preview: json.slice(0, MAX_TOOL_RESULT)
  }
}

/** 将模型的工具请求路由到本地读取、引用、澄清及提案服务，不直接授权变更执行。 */
export class AgentTools {
  /** 注入工具路由所需的文稿、变更、附件和来源服务。 */
  constructor(private readonly deps: Deps) {}

  /** 按工具名称分派调用，并根据任务上下文限制可用的目标与材料。 */
  async execute(name: string, rawArgs: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'get_active_document':
          return this.getActiveDocument(context)
        case 'open_workspace_file':
          return await this.openWorkspaceFile(String(rawArgs.relativePath ?? ''), context)
        case 'list_workspace_files':
          return await this.listWorkspaceFiles(Number(rawArgs.limit ?? 80), context)
        case 'search_documents':
          return await this.searchDocuments(String(rawArgs.query ?? ''), Number(rawArgs.limit ?? 30), context)
        case 'get_document_outline':
          return this.getOutline(rawArgs.documentId as string | undefined, context)
        case 'read_section':
          return this.readSection(
            String(rawArgs.sectionId ?? ''),
            rawArgs.documentId as string | undefined,
            context
          )
        case 'read_document':
          return this.readDocument(
            rawArgs.documentId as string | undefined,
            rawArgs.from as number | undefined,
            rawArgs.to as number | undefined,
            context
          )
        case 'request_clarification':
          return this.clarify(rawArgs)
        case 'propose_changes':
          return await this.propose(rawArgs, context)
        case 'list_task_sources':
          return this.listSources(context)
        case 'read_source_chunk':
          return this.readSourceChunk(String(rawArgs.chunkId ?? ''), context)
        default:
          return { ok: false, summary: `未知工具 ${name}`, result: { error: `未知工具：${name}` } }
      }
    } catch (error) {
      return { ok: false, summary: messageOf(error), result: { error: messageOf(error) } }
    }
  }

  private authorize(documentId: string | undefined, context: ToolContext): string {
    const id = documentId || context.activeDocumentId
    if (!id) throw new AppError('TARGET_AMBIGUOUS', '当前没有打开的文档，请先指定目标文件。')
    if (!context.allowedDocumentIds.has(id)) {
      throw new AppError('OUT_OF_SCOPE', '该文档不在本任务授权范围内，请先通过 open_workspace_file 打开。')
    }
    return id
  }

  private getActiveDocument(context: ToolContext): ToolOutcome {
    if (!context.activeDocumentId) {
      return { ok: false, summary: '没有活动文档', result: { error: '当前没有打开的文档。' } }
    }
    const session = this.deps.documents.getSession(context.activeDocumentId)
    const stats = countText(session.text)
    const outline = parseOutline(session.text)
    const selection = context.selection
      ? {
          from: context.selection.from,
          to: context.selection.to,
          text: session.text.slice(context.selection.from, context.selection.to).slice(0, 1500)
        }
      : null
    return {
      ok: true,
      summary: `读取《${session.title}》`,
      result: clip({
        documentId: session.documentId,
        title: session.title,
        relativePath: session.relativePath,
        revision: session.revision,
        contentHash: session.contentHash,
        dirty: session.dirty,
        words: stats.words,
        characters: stats.characters,
        outline,
        selection,
        note: '正文未整体发送；请用 get_document_outline 与 read_section 精确读取。'
      })
    }
  }

  private async openWorkspaceFile(relativePath: string, context: ToolContext): Promise<ToolOutcome> {
    if (!relativePath) throw new AppError('INVALID_INPUT', '缺少 relativePath。')
    const workspace = this.deps.workspace.getCurrent()
    if (!workspace) throw new AppError('OUT_OF_SCOPE', '尚未打开工作区。')
    const abs = await this.deps.workspace.resolveExisting(relativePath)
    const snapshot = await this.deps.documents.openHeadless(abs)
    context.allowedDocumentIds.add(snapshot.documentId)
    return {
      ok: true,
      summary: `打开《${snapshot.title}》`,
      result: clip({
        documentId: snapshot.documentId,
        title: snapshot.title,
        relativePath: snapshot.relativePath,
        revision: snapshot.revision,
        contentHash: snapshot.contentHash,
        dirty: snapshot.dirty,
        outline: parseOutline(snapshot.text),
        words: countText(snapshot.text).words
      })
    }
  }

  private async listWorkspaceFiles(limit: number, _context: ToolContext): Promise<ToolOutcome> {
    const workspace = this.deps.workspace.getCurrent()
    if (!workspace) {
      return { ok: false, summary: '未打开工作区', result: { error: '尚未打开工作区，只能操作当前文档。' } }
    }
    const files = await this.deps.workspace.listTextFiles()
    const open = new Map(
      this.deps.documents.listOpen().map((snapshot) => [snapshot.relativePath, snapshot.documentId])
    )
    const items = files.slice(0, Math.min(limit, 200)).map((file) => ({
      relativePath: file.relativePath,
      name: file.name,
      size: file.size,
      documentId: open.get(file.relativePath) ?? null
    }))
    return {
      ok: true,
      summary: `列出 ${items.length} 个工作区文件`,
      result: clip({
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
        total: files.length,
        files: items,
        note: '修改未打开的文件前，请先调用 open_workspace_file 获取 documentId 与版本。'
      })
    }
  }

  private async searchDocuments(query: string, limit: number, _context: ToolContext): Promise<ToolOutcome> {
    if (!query.trim()) throw new AppError('INVALID_INPUT', '搜索关键词不能为空。')
    const hits = []
    for (const snapshot of this.deps.documents.listOpen()) {
      const lower = snapshot.text.toLowerCase()
      const needle = query.toLowerCase()
      let index = lower.indexOf(needle)
      let count = 0
      while (index !== -1 && count < 3) {
        const lineStart = snapshot.text.lastIndexOf('\n', index) + 1
        const lineEnd = snapshot.text.indexOf('\n', index)
        hits.push({
          relativePath: snapshot.relativePath,
          documentId: snapshot.documentId,
          line: snapshot.text.slice(0, lineStart).split('\n').length,
          excerpt: snapshot.text
            .slice(lineStart, lineEnd === -1 ? index + 120 : lineEnd)
            .trim()
            .slice(0, 180),
          unsaved: true
        })
        index = lower.indexOf(needle, index + needle.length)
        count += 1
      }
    }
    if (this.deps.workspace.getCurrent()) {
      const diskHits = await this.deps.workspace.search(query, Math.max(1, Math.min(limit, 60)))
      for (const hit of diskHits) hits.push({ ...hit, unsaved: false })
    }
    const deduped = hits.slice(0, Math.max(1, Math.min(limit, 60)))
    return { ok: true, summary: `搜索到 ${deduped.length} 处匹配`, result: clip({ query, hits: deduped }) }
  }

  private getOutline(documentId: string | undefined, context: ToolContext): ToolOutcome {
    const id = this.authorize(documentId, context)
    const session = this.deps.documents.getSession(id)
    return {
      ok: true,
      summary: `读取《${session.title}》目录`,
      result: clip({
        documentId: id,
        revision: session.revision,
        contentHash: session.contentHash,
        outline: parseOutline(session.text),
        note: 'sectionId 仅在当前 revision 内有效。'
      })
    }
  }

  private readSection(sectionId: string, documentId: string | undefined, context: ToolContext): ToolOutcome {
    const id = this.authorize(documentId, context)
    const session = this.deps.documents.getSession(id)
    const section = parseSections(session.text).find((item) => item.sectionId === sectionId)
    if (!section) throw new AppError('TARGET_AMBIGUOUS', '章节不存在，请重新获取目录。')
    const text = session.text.slice(section.headingStart, section.sectionEnd)
    const clipped = text.length > 9000 ? `${text.slice(0, 9000)}\n…（章节过长，已截断）` : text
    return {
      ok: true,
      summary: `读取章节《${section.title}》`,
      result: clip({
        documentId: id,
        revision: session.revision,
        contentHash: session.contentHash,
        sectionId,
        level: section.level,
        title: section.title,
        headingPath: section.headingPath,
        headingStart: section.headingStart,
        sectionEnd: section.sectionEnd,
        text: clipped,
        truncated: text.length > 9000
      })
    }
  }

  private readDocument(
    documentId: string | undefined,
    from: number | undefined,
    to: number | undefined,
    context: ToolContext
  ): ToolOutcome {
    const id = this.authorize(documentId, context)
    const session = this.deps.documents.getSession(id)
    const start = Math.max(0, Math.min(from ?? 0, session.text.length))
    const end = Math.max(start, Math.min(to ?? start + 12_000, session.text.length))
    const text = session.text.slice(start, end)
    return {
      ok: true,
      summary: `读取《${session.title}》 ${start}–${end}`,
      result: clip({
        documentId: id,
        revision: session.revision,
        contentHash: session.contentHash,
        length: session.text.length,
        from: start,
        to: end,
        truncated: end < session.text.length || text.length >= 12_000,
        text: text.slice(0, 12_000)
      })
    }
  }

  private clarify(raw: Record<string, unknown>): ToolOutcome {
    const question = String(raw.question ?? '').trim()
    if (!question) throw new AppError('INVALID_INPUT', '澄清问题不能为空。')
    const options = Array.isArray(raw.options) ? raw.options.map((item) => String(item)).slice(0, 4) : []
    return {
      ok: true,
      summary: '等待用户澄清',
      result: { status: 'waiting_for_user', question, options },
      clarification: { question, options }
    }
  }

  private async propose(raw: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    if (context.scope === 'workspace' && (!context.workspaceId ||
        this.deps.workspace.getCurrent()?.workspaceId !== context.workspaceId)) {
      throw new AppError('OUT_OF_SCOPE', '任务的工作区已变化，请重新发起任务。')
    }
    const operations = Array.isArray(raw.operations) ? (raw.operations as ChangeOperation[]) : []
    for (const operation of operations) {
      if ('guard' in operation && !context.allowedDocumentIds.has(operation.guard.documentId)) {
        throw new AppError('OUT_OF_SCOPE', '提案包含未授权的文档。')
      }
      if ('guard' in operation && operation.guard.documentId !== context.activeDocumentId &&
        this.deps.documents.getSession(operation.guard.documentId).workspaceId !== context.workspaceId) {
        throw new AppError('OUT_OF_SCOPE', '提案包含任务工作区之外的文档。')
      }
      if (context.scope !== 'workspace' && (
        !('guard' in operation) || operation.kind === 'delete_document' ||
        operation.guard.documentId !== context.activeDocumentId
      )) {
        throw new AppError('OUT_OF_SCOPE', '新建、删除或修改其他文档需要将任务范围设为工作区。')
      }
    }

    // 参考生成：把 [S1] 标记编译为脚注，并记录使用情况
    const rewritten = operations.map((operation) => {
      if (operation.kind === 'insert_markdown') {
        const citations = this.deps.references.applyCitations(operation.markdown, context.citationBundle)
        if (citations.invalid.length) {
          throw new AppError('CITATION_INVALID', `引用了未提供的来源：${citations.invalid.join('、')}`)
        }
        return { ...operation, markdown: citations.markdown }
      }
      if (operation.kind === 'replace_range') {
        const citations = this.deps.references.applyCitations(operation.newText, context.citationBundle)
        if (citations.invalid.length) {
          throw new AppError('CITATION_INVALID', `引用了未提供的来源：${citations.invalid.join('、')}`)
        }
        return { ...operation, newText: citations.markdown }
      }
      return operation
    })

    if (context.scope === 'selection') {
      const { selection, activeDocumentId } = context
      if (!selection || !activeDocumentId) throw new AppError('OUT_OF_SCOPE', '请先选中需要修改的内容。')
      const session = this.deps.documents.getSession(activeDocumentId)
      for (const operation of rewritten) {
        const { edits } = planOperation(operation, session)
        if (edits.some((edit) => edit.from < selection.from || edit.to > selection.to)) {
          throw new AppError('OUT_OF_SCOPE', '修改超出了任务的原始选区。')
        }
      }
    }

    const changeSet = await this.deps.changes.createProposalFromModel(context.taskId, {
      summary: raw.summary,
      operations: rewritten,
      attachmentIds: context.attachmentIds,
      sourceIds: context.sourceIds,
      sourceSetDigest: this.deps.references.digest(context.sourceIds)
    })
    return {
      ok: true,
      summary: changeSet.summary,
      proposalId: changeSet.changeSetId,
      result: {
        status: 'proposal_submitted',
        changeSetId: changeSet.changeSetId,
        summary: changeSet.summary,
        operationCount: changeSet.operations.length,
        note: '提案已提交，应用会按用户设置处理审批，不要重复提交相同修改。'
      }
    }
  }

  private listSources(context: ToolContext): ToolOutcome {
    const all = this.deps.references.list()
    const selected = all.filter((asset) => context.sourceIds.includes(asset.sourceId))
    return {
      ok: true,
      summary: `本任务有 ${selected.length} 份参考材料`,
      result: clip({
        sources: selected.map((asset) => ({
          sourceId: asset.sourceId,
          title: asset.title,
          kind: asset.kind,
          roles: asset.roles,
          status: asset.status,
          chunkCount: asset.chunkCount,
          message: asset.message
        })),
        note: '引用事实时在正文中使用 [S1]、[S2] 标记，应用会生成可定位的脚注。'
      })
    }
  }

  private readSourceChunk(chunkId: string, context: ToolContext): ToolOutcome {
    for (const sourceId of context.sourceIds) {
      const chunks: SourceChunk[] = this.deps.references.chunksOf(sourceId)
      const chunk = chunks.find((item) => item.chunkId === chunkId)
      if (!chunk) continue
      const asset = this.deps.references.get(sourceId).asset
      return {
        ok: true,
        summary: `读取参考片段《${asset.title}》`,
        result: clip({
          sourceId,
          sourceVersion: asset.sourceVersion,
          chunkId,
          title: asset.title,
          text: chunk.text,
          locator: chunk.locator,
          uncertain: chunk.uncertain
        })
      }
    }
    throw new AppError('CITATION_INVALID', '片段不存在或不在本任务授权范围内。')
  }
}

/** 供系统提示使用的来源清单摘要 */
export function describeSources(bundle: ContextBundle): string {
  return bundle.includedSources.map((source) => `${source.label} 《${source.title}》`).join('；')
}

/** 提取便于展示在上下文或工具摘要中的正文片段。 */
export function excerptOf(text: string): string {
  return toPlainExcerpt(text, 80)
}
