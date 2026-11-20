/**
 * 内置演示 Provider：不联网、可离线验证完整 Agent 链路（读取 → 提案 → 审阅 → 应用）。
 * 明确标注为演示数据，不伪装成真实识图或真实生成。
 */

import { AppError } from '@shared/errors'
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderMessage,
  ProviderTurnRequest,
  ProviderValidation
} from './types'

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AppError('CANCELLED'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AppError('CANCELLED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function lastUserText(messages: ProviderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return ''
}

function findToolResult(messages: ProviderMessage[], toolName: string): Record<string, unknown> | null {
  // 工具结果不含 name，按顺序结合 assistant 的 toolCalls 匹配
  let callName = ''
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      callName = message.toolCalls[message.toolCalls.length - 1].name
    } else if (message.role === 'tool') {
      if (callName === toolName) {
        try {
          return JSON.parse(message.content) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function assistantRounds(messages: ProviderMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length
}

/** 为没有远程模型配置的演示与测试提供确定性的模型事件。 */
export class MockAdapter implements ProviderAdapter {
  /** 标记该实现使用离线演示模型。 */
  readonly kind = 'mock' as const

  /** 返回内置演示模型的本地可用结果，无需远程连接。 */
  async validate(): Promise<ProviderValidation> {
    return {
      ok: true,
      latencyMs: 12,
      message: '演示 Provider 已就绪（不访问网络，不调用真实模型）',
      models: ['mock-writer']
    }
  }

  /** 按任务消息返回离线演示所需的模拟文本或工具调用事件。 */
  async *runTurn(request: ProviderTurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    // 预测请求不带工具：返回一段可直接接受的续写候选
    if (request.tools.length === 0) {
      const latest = lastUserText(request.messages)
      const continuation = /总结|摘要/.test(latest)
        ? '把散落的想法收拢成清晰的段落，让每一次写作都更接近真正想表达的内容。'
        : '让工具退到幕后，把注意力留给内容本身：先写清楚，再写完整。'
      yield* this.streamText(continuation, signal)
      yield { type: 'completed', finishReason: 'stop' }
      return
    }
    const prompt = lastUserText(request.messages)
    const rounds = assistantRounds(request.messages)
    const hasImage = request.messages.some((message) => message.role === 'user' && message.images?.length)
    const wantsTable = /表格|table/i.test(prompt)
    const wantsCreate = /新建|创建|起草/.test(prompt)
    const wantsAnswerOnly =
      /摘要|总结|解释|说明|为什么|分析|问/.test(prompt) && !/插入|添加|写入|修改/.test(prompt)

    if (rounds === 0) {
      if (wantsCreate) {
        const result = findToolResult(request.messages, 'list_workspace_files')
        void result
        yield {
          type: 'tool_call',
          call: { callId: 'call_mock_list', name: 'list_workspace_files', argumentsJson: '{"limit":20}' }
        }
        yield { type: 'completed', finishReason: 'tool_calls' }
        return
      }
      yield {
        type: 'tool_call',
        call: { callId: 'call_mock_active', name: 'get_active_document', argumentsJson: '{}' }
      }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }

    const active = findToolResult(request.messages, 'get_active_document')
    const files = findToolResult(request.messages, 'list_workspace_files')
    const documentId = typeof active?.documentId === 'string' ? active.documentId : null
    const revision = typeof active?.revision === 'number' ? active.revision : 0
    const contentHash = typeof active?.contentHash === 'string' ? active.contentHash : ''
    const outline = Array.isArray(active?.outline) ? (active.outline as Array<Record<string, unknown>>) : []
    const workspaceId = typeof files?.workspaceId === 'string' ? files.workspaceId : null

    if (rounds === 1) {
      if (wantsAnswerOnly || !documentId) {
        const title = typeof active?.title === 'string' ? active.title : '当前文档'
        const headings = outline
          .slice(0, 6)
          .map((node) => `${'#'.repeat(Number(node.level) || 1)} ${String(node.title ?? '')}`)
          .join('、')
        yield* this.streamText(
          `（演示 Provider）已读取《${title}》，共 ${outline.length} 个标题${headings ? `：${headings}` : ''}。这是本地演示回复，不调用真实模型；配置模型服务后可获得真实写作建议。`,
          signal
        )
        yield { type: 'completed', finishReason: 'stop' }
        return
      }

      if (wantsCreate && workspaceId) {
        const fileName = `新建文稿-${new Date().toISOString().slice(0, 10)}.md`
        yield {
          type: 'tool_call',
          call: {
            callId: 'call_mock_create',
            name: 'propose_changes',
            argumentsJson: JSON.stringify({
              summary: `在工作区根目录新建 ${fileName}`,
              operations: [
                {
                  kind: 'create_document',
                  workspaceId,
                  relativePath: fileName,
                  content: `# ${fileName.replace(/\.md$/, '')}\n\n这是由文档助手创建的草稿，可直接继续编辑。\n`,
                  ifExists: 'fail'
                }
              ]
            })
          }
        }
        yield { type: 'completed', finishReason: 'tool_calls' }
        return
      }

      const targetSection = outline.find((node) => Number(node.level) === 2) ?? outline[0]
      const sectionId = typeof targetSection?.sectionId === 'string' ? targetSection.sectionId : null
      const operations = wantsTable
        ? [
            {
              kind: 'insert_table',
              guard: { documentId, baseRevision: revision, expectedContentHash: contentHash },
              anchor: { sectionId, position: sectionId ? 'section_end' : 'document_end' },
              caption: '演示数据（未连接真实视觉模型）',
              table: {
                columnCount: 2,
                totalRows: 4,
                header: [
                  { text: '项目', status: 'recognized' },
                  { text: '说明', status: 'recognized' }
                ],
                rows: [
                  [
                    { text: '示例行一', status: 'recognized' },
                    { text: hasImage ? '待核对' : '演示值', status: hasImage ? 'uncertain' : 'recognized' }
                  ],
                  [
                    { text: '示例行二', status: 'recognized' },
                    { text: hasImage ? '待核对' : '演示值', status: hasImage ? 'uncertain' : 'recognized' }
                  ],
                  [
                    { text: '示例行三', status: 'recognized' },
                    { text: hasImage ? '待核对' : '演示值', status: hasImage ? 'uncertain' : 'recognized' }
                  ]
                ]
              }
            }
          ]
        : [
            {
              kind: 'insert_markdown',
              guard: { documentId, baseRevision: revision, expectedContentHash: contentHash },
              anchor: { sectionId, position: sectionId ? 'section_end' : 'document_end' },
              markdown:
                '这是演示 Provider 生成的一段示例文字，用于验证「提案 → 审阅 → 应用 → 撤销」的完整流程。\n\n配置真实模型服务后，这里会替换为与实际指令相符的内容。'
            }
          ]

      yield {
        type: 'tool_call',
        call: {
          callId: 'call_mock_propose',
          name: 'propose_changes',
          argumentsJson: JSON.stringify({
            summary: wantsTable ? '在章节末尾插入 4 行 2 列演示表格' : '在章节末尾插入一段演示文字',
            operations
          })
        }
      }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }

    yield* this.streamText('修改建议已生成，请在审阅面板中确认后应用。', signal)
    yield { type: 'completed', finishReason: 'stop' }
  }

  private async *streamText(text: string, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const chunkSize = 8
    for (let i = 0; i < text.length; i += chunkSize) {
      await sleep(14, signal)
      yield { type: 'text_delta', text: text.slice(i, i + chunkSize) }
    }
  }
}
