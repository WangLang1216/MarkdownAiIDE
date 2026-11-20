/**
 * 文档 Agent 调度：有界工具循环、澄清挂起、提案冻结、取消与自动应用。
 * 模型输出永远不是执行事实；只有工具返回与应用事务结果才决定任务状态。
 */

import type {
  AgentPhase,
  Attachment,
  ClarificationAnswer,
  DocumentSnapshot,
  StartTaskInput,
  TaskEvent,
  TaskEventPayload,
  TaskSnapshot,
  TaskSummary
} from '@shared/types'
import { AppError, toErrorInfo } from '@shared/errors'
import { StartTaskSchema, formatIssues } from '@shared/schemas'
import { parseSections } from '@shared/markdown/outline'
import { newId } from '../utils/fs'
import { logger } from '../utils/logger'
import type { ProviderService } from '../providers/service'
import type { ProviderMessage, ProviderToolCall } from '../providers/types'
import { AGENT_TOOLS, AgentTools, type ToolContext, type ToolOutcome } from './tools'
import { buildSystemPrompt } from './prompts'
import type { DocumentService } from '../documents/service'
import type { WorkspaceService } from '../workspace/service'
import type { ChangeService } from '../changes/service'
import type { ReferenceService, ContextBundle } from '../references/service'
import type { AttachmentService } from '../attachments/service'
import type { SettingsStore } from '../settings/store'

const MAX_TASKS = 20
const CLARIFICATION_TIMEOUT_MS = 10 * 60 * 1000

type AnswerResolution = (value: string | null) => void

interface TaskRecord {
  taskId: string
  summary: TaskSummary
  phase: AgentPhase
  text: string
  toolLog: TaskSnapshot['toolLog']
  clarification: TaskSnapshot['clarification']
  proposalId: string | null
  error: TaskSnapshot['error']
  abort: AbortController
  answer: AnswerResolution | null
  sequence: number
  autoApplyTried: boolean
}

interface Deps {
  providers: ProviderService
  documents: DocumentService
  workspace: WorkspaceService
  changes: ChangeService
  references: ReferenceService
  attachments: AttachmentService
  settings: SettingsStore
  tools: AgentTools
}

const TOOL_TITLES: Record<string, string> = {
  get_active_document: '读取当前文档',
  open_workspace_file: '打开工作区文件',
  list_workspace_files: '浏览工作区文件',
  search_documents: '搜索文档',
  get_document_outline: '读取标题大纲',
  read_section: '读取章节',
  read_document: '读取文档片段',
  request_clarification: '等待澄清',
  propose_changes: '准备修改建议',
  list_task_sources: '查看参考材料',
  read_source_chunk: '读取参考片段'
}

/** 组织显式 Agent 任务的上下文准备、模型轮次、工具调用、澄清与状态事件。 */
export class AgentController {
  private tasks = new Map<string, TaskRecord>()
  private sink: ((event: TaskEvent) => void) | null = null

  /** 注入任务执行所需的文稿、模型、工具及变更服务。 */
  constructor(private readonly deps: Deps) {}

  /** 设置任务事件接收器，供主进程转发到渲染端。 */
  setSink(sink: (event: TaskEvent) => void): void {
    this.sink = sink
  }

  /** 返回任务的当前聚合状态，未保留的任务返回 null。 */
  snapshot(taskId: string): TaskSnapshot | null {
    const record = this.tasks.get(taskId)
    if (!record) return null
    return {
      task: { ...record.summary },
      phase: record.phase,
      text: record.text,
      toolLog: record.toolLog.map((item) => ({ ...item })),
      clarification: record.clarification ? { ...record.clarification } : null,
      proposalId: record.proposalId,
      error: record.error ? { ...record.error } : null
    }
  }

  /** 校验任务输入和模型配置，登记并异步运行任务，立即返回任务标识。 */
  async start(input: StartTaskInput): Promise<{ taskId: string }> {
    const parsed = StartTaskSchema.safeParse(input)
    if (!parsed.success) throw new AppError('INVALID_INPUT', formatIssues(parsed.error))
    const data = parsed.data

    const provider = data.providerId
      ? this.deps.providers.get(data.providerId)
      : this.deps.providers.getDefault()
    if (!provider.capabilities.text) throw new AppError('CAPABILITY_MISSING', '当前模型不支持文本生成。')

    const activeDocument = data.documentId ? await this.deps.documents.syncForAgent(data.documentId) : null
    const attachments: Attachment[] = []
    for (const id of data.attachmentIds) {
      try {
        attachments.push(this.deps.attachments.get(id))
      } catch {
        // 附件已被清理，不阻断任务
      }
    }
    const sourceIds = data.sourceIds.filter((id) =>
      this.deps.references.list().some((asset) => asset.sourceId === id)
    )
    const citationBundle = this.deps.references.buildContext(sourceIds, data.prompt)

    const taskId = newId('task')
    const summary: TaskSummary = {
      taskId,
      documentId: activeDocument?.documentId ?? null,
      documentTitle: activeDocument?.title ?? '工作区',
      prompt: data.prompt.slice(0, 200),
      status: 'running',
      createdAt: Date.now()
    }
    const record: TaskRecord = {
      taskId,
      summary,
      phase: 'preparing',
      text: '',
      toolLog: [],
      clarification: null,
      proposalId: null,
      error: null,
      abort: new AbortController(),
      answer: null,
      sequence: 0,
      autoApplyTried: false
    }
    this.register(record)
    this.emit(record, { type: 'started', task: { ...summary } })

    void this.run(
      record,
      data,
      provider.providerId,
      activeDocument,
      attachments,
      citationBundle,
      sourceIds
    ).catch((error) => {
      const info = toErrorInfo(error)
      record.error = { code: info.code, message: info.message, retryable: info.retryable }
      record.summary.status = 'failed'
      record.phase = 'failed'
      this.emit(record, { type: 'failed', code: info.code, message: info.message, retryable: info.retryable })
      logger.error('agent', '任务失败', { taskId, code: info.code })
    })

    return { taskId }
  }

  /** 发出中止信号，并解除任务对用户澄清答复的等待。 */
  async cancel(taskId: string): Promise<void> {
    const record = this.tasks.get(taskId)
    if (!record) return
    if (['completed', 'failed', 'cancelled', 'applied'].includes(record.summary.status)) return
    record.abort.abort()
    record.answer?.(null)
    record.answer = null
    record.summary.status = 'cancelled'
    record.phase = 'cancelled'
    this.emit(record, { type: 'cancelled' })
  }

  /** 将界面答复交给匹配的等待中任务。 */
  async answer(input: ClarificationAnswer): Promise<void> {
    const record = this.tasks.get(input.taskId)
    if (!record) throw new AppError('FILE_NOT_FOUND', '任务不存在。')
    if (!record.answer) throw new AppError('INVALID_INPUT', '当前任务没有等待澄清的问题。')
    const value = input.selectedOption?.trim() || input.answer.trim()
    if (!value) throw new AppError('INVALID_INPUT', '回答不能为空。')
    record.clarification = null
    const resolve = record.answer
    record.answer = null
    resolve(value)
  }

  private async run(
    record: TaskRecord,
    input: StartTaskInput,
    providerId: string,
    activeDocument: DocumentSnapshot | null,
    attachments: Attachment[],
    citationBundle: ContextBundle,
    sourceIds: string[]
  ): Promise<void> {
    const provider = this.deps.providers.get(providerId)
    const adapter = this.deps.providers.adapterFor(provider)
    const settings = this.deps.settings.get()
    const visionAvailable = provider.capabilities.vision
    const toolCalling = provider.capabilities.toolCalling
    const outline = activeDocument ? parseSections(activeDocument.text) : []
    const selection =
      input.selection && activeDocument
        ? {
            from: Math.min(input.selection.from, activeDocument.text.length),
            to: Math.min(input.selection.to, activeDocument.text.length),
            text: activeDocument.text.slice(input.selection.from, input.selection.to)
          }
        : null

    const images: string[] = []
    if (visionAvailable) {
      for (const attachment of attachments.slice(0, 4)) {
        const dataUrl = await this.deps.attachments.dataUrl(attachment.attachmentId)
        if (dataUrl) images.push(dataUrl)
      }
    }

    const systemPrompt = buildSystemPrompt({
      workspaceName: this.deps.workspace.getCurrent()?.name ?? null,
      workspaceId: this.deps.workspace.getCurrent()?.workspaceId ?? null,
      activeDocument,
      outline,
      selection,
      attachments: attachments.map((item) => ({ name: item.name, mime: item.mime })),
      visionAvailable,
      toolCalling,
      sources: citationBundle,
      mode: input.mode,
      scope: input.scope
    })

    if (!visionAvailable && attachments.length) {
      this.emit(record, {
        type: 'message',
        text: '当前模型未启用视觉能力：已附加的图片不会被读取。可切换到支持视觉的模型，或先用 OCR/文字描述补充内容。'
      })
    }

    const messages: ProviderMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: input.prompt,
        ...(images.length ? { images } : {})
      }
    ]

    const context: ToolContext = {
      taskId: record.taskId,
      activeDocumentId: activeDocument?.documentId ?? null,
      scope: input.scope,
      ...(selection ? { selection: { from: selection.from, to: selection.to } } : {}),
      attachmentIds: attachments.map((item) => item.attachmentId),
      sourceIds,
      allowedDocumentIds: new Set(activeDocument ? [activeDocument.documentId] : []),
      citationBundle
    }

    let consecutiveToolErrors = 0
    const maxRounds = Math.min(settings.agent.maxRounds, 20)

    for (let round = 0; round < maxRounds; round += 1) {
      this.throwIfCancelled(record)
      this.setPhase(record, round === 0 ? 'thinking' : 'generating', round === 0 ? '分析任务' : '继续处理')

      let text = ''
      const calls: ProviderToolCall[] = []
      let attempt = 0
      let completed = false

      while (!completed) {
        this.throwIfCancelled(record)
        try {
          for await (const event of adapter.runTurn(
            {
              model: provider.model,
              messages,
              tools: toolCalling
                ? input.mode === 'ask'
                  ? AGENT_TOOLS.filter((tool) => tool.name !== 'propose_changes')
                  : AGENT_TOOLS
                : [],
              temperature: settings.agent.temperature,
              maxOutputTokens: 4096,
              taskId: record.taskId
            },
            record.abort.signal
          )) {
            this.throwIfCancelled(record)
            if (event.type === 'text_delta') {
              text += event.text
              record.text += event.text
              this.emit(record, { type: 'text_delta', text: event.text })
            } else if (event.type === 'tool_call') {
              calls.push(event.call)
            } else if (event.type === 'completed') {
              completed = true
            }
          }
          completed = true
        } catch (error) {
          if (record.abort.signal.aborted) throw new AppError('CANCELLED')
          const info = toErrorInfo(error)
          if (info.retryable && attempt === 0) {
            attempt += 1
            this.setPhase(record, 'thinking', '服务暂时不可用，正在重试')
            await new Promise((resolve) => setTimeout(resolve, 1200))
            continue
          }
          throw error
        }
      }

      if (!calls.length) {
        record.phase = 'completed'
        record.summary.status = 'completed'
        this.emit(record, { type: 'completed', text: text || '任务已完成。' })
        return
      }

      messages.push({ role: 'assistant', content: text, toolCalls: calls })

      for (const call of calls) {
        this.throwIfCancelled(record)
        const args = this.parseArgs(call)
        const entry: TaskSnapshot['toolLog'][number] = {
          callId: call.callId,
          name: call.name,
          title: TOOL_TITLES[call.name] ?? call.name,
          status: 'running',
          summary: ''
        }
        record.toolLog.push(entry)
        this.emit(record, {
          type: 'tool_started',
          callId: call.callId,
          name: call.name,
          title: entry.title,
          argsSummary: summarizeArgs(args)
        })

        let outcome: ToolOutcome
        try {
          outcome = await this.deps.tools.execute(call.name, args, context)
        } catch (error) {
          outcome = {
            ok: false,
            summary: toErrorInfo(error).message,
            result: { error: toErrorInfo(error).message }
          }
        }

        if (outcome.clarification) {
          entry.status = 'done'
          entry.summary = '等待用户回答'
          this.emit(record, {
            type: 'tool_finished',
            callId: call.callId,
            name: call.name,
            ok: true,
            summary: entry.summary
          })
          record.summary.status = 'waiting_input'
          this.setPhase(record, 'waiting_input', '等待澄清')
          this.emit(record, {
            type: 'clarification',
            question: outcome.clarification.question,
            options: outcome.clarification.options,
            allowFreeText: true
          })
          const answer = await this.waitForAnswer(record)
          if (answer === null) {
            this.throwIfCancelled(record)
            throw new AppError('PROVIDER_TIMEOUT', '等待澄清超时。')
          }
          record.summary.status = 'running'
          record.phase = 'generating'
          messages.push({
            role: 'tool',
            toolCallId: call.callId,
            content: JSON.stringify({ question: outcome.clarification.question, answer })
          })
          continue
        }

        entry.status = outcome.ok ? 'done' : 'failed'
        entry.summary = outcome.summary
        messages.push({
          role: 'tool',
          toolCallId: call.callId,
          content: JSON.stringify(outcome.result)
        })
        this.emit(record, {
          type: 'tool_finished',
          callId: call.callId,
          name: call.name,
          ok: outcome.ok,
          summary: outcome.summary
        })

        consecutiveToolErrors = outcome.ok ? 0 : consecutiveToolErrors + 1
        if (consecutiveToolErrors >= 3) {
          throw new AppError('PROVIDER_ERROR', '连续多次工具调用失败，已停止任务。')
        }

        if (outcome.proposalId) {
          record.proposalId = outcome.proposalId
          record.summary.status = 'reviewing'
          record.phase = 'reviewing'
          const review = await this.deps.changes.review(outcome.proposalId)
          this.emit(record, {
            type: 'proposal_ready',
            changeSetId: outcome.proposalId,
            summary: review.changeSet.summary,
            fileCount: review.files.length,
            risk: review.changeSet.risk
          })
          if (
            !record.autoApplyTried &&
            input.mode === 'edit' &&
            settings.agent.autoApplyCurrentDocument &&
            review.autoApplicable
          ) {
            record.autoApplyTried = true
            const result = await this.deps.changes.accept(outcome.proposalId, review.changeSet.proposalDigest)
            this.emit(record, {
              type: 'applied',
              transactionId: result.transactionId,
              summary: result.message,
              status: result.status
            })
            record.summary.status = result.status === 'applied' ? 'applied' : 'reviewing'
            record.phase = result.status === 'applied' ? 'applied' : 'reviewing'
          }
          return
        }
      }
    }

    throw new AppError('PROVIDER_ERROR', `已超过 ${maxRounds} 轮工具预算，任务停止。`)
  }

  private waitForAnswer(record: TaskRecord): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        record.answer = null
        resolve(null)
      }, CLARIFICATION_TIMEOUT_MS)
      record.answer = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
    })
  }

  private throwIfCancelled(record: TaskRecord): void {
    if (record.abort.signal.aborted) throw new AppError('CANCELLED')
  }

  private setPhase(record: TaskRecord, phase: AgentPhase, label: string): void {
    record.phase = phase
    this.emit(record, { type: 'phase', phase, label })
  }

  private parseArgs(call: ProviderToolCall): Record<string, unknown> {
    try {
      const parsed = JSON.parse(call.argumentsJson || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }

  private register(record: TaskRecord): void {
    this.tasks.set(record.taskId, record)
    if (this.tasks.size <= MAX_TASKS) return
    const sorted = [...this.tasks.values()].sort((a, b) => a.summary.createdAt - b.summary.createdAt)
    for (const item of sorted.slice(0, this.tasks.size - MAX_TASKS)) {
      if (['running', 'waiting_input', 'reviewing'].includes(item.summary.status)) continue
      this.tasks.delete(item.taskId)
    }
  }

  private emit(record: TaskRecord, payload: TaskEventPayload): void {
    record.sequence += 1
    const event: TaskEvent = {
      ...payload,
      taskId: record.taskId,
      sequence: record.sequence,
      timestamp: Date.now()
    }
    this.sink?.(event)
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  if (typeof args.sectionId === 'string') return `章节 ${args.sectionId}`
  if (typeof args.relativePath === 'string') return args.relativePath
  if (typeof args.query === 'string') return `关键词：${args.query}`
  if (typeof args.summary === 'string') return args.summary
  const json = JSON.stringify(args)
  return json.length > 90 ? `${json.slice(0, 90)}…` : json
}

/** 重导出任务控制器所依赖的工具分发类型。 */
export type { AgentTools }
