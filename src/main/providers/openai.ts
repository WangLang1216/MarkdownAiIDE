/**
 * OpenAI 兼容适配器（官方 API、自定义远程、Ollama / LM Studio 共用）。
 * 负责：SSE 流解析、工具调用增量拼装、图片输入、错误码归一化与有限重试提示。
 */

import { AppError } from '@shared/errors'
import { logger } from '../utils/logger'
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderMessage,
  ProviderRuntimeConfig,
  ProviderTurnRequest,
  ProviderValidation
} from './types'

const REQUEST_TIMEOUT_MS = 120_000
const MAX_ERROR_BODY = 400

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type: string; text?: string }>
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** 将配置地址整理为 OpenAI 兼容适配器使用的 API 根地址。 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed) throw new AppError('PROVIDER_NOT_CONFIGURED', '模型服务地址不能为空。')
  return trimmed
}

/** 组合用户取消信号与超时信号，统一抛出 CANCELLED / PROVIDER_TIMEOUT */
function withTimeout(signal: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function mapHttpError(status: number, body: string): AppError {
  const detail = body.slice(0, MAX_ERROR_BODY)
  if (status === 401 || status === 403) return new AppError('PROVIDER_AUTH', undefined, { details: detail })
  if (status === 429)
    return new AppError('PROVIDER_RATE_LIMIT', undefined, { retryable: true, details: detail })
  if (status === 404)
    return new AppError('PROVIDER_ERROR', '接口或模型不存在，请检查地址与模型名。', { details: detail })
  if (status >= 500) return new AppError('PROVIDER_ERROR', undefined, { retryable: true, details: detail })
  return new AppError('PROVIDER_ERROR', `模型服务返回 ${status}。`, { details: detail })
}

/** 通过兼容接口检查模型连接并将流式响应归一化为内部事件。 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  /** 标记该实现走 OpenAI 兼容协议。 */
  readonly kind: ProviderAdapter['kind']

  /** 绑定模型服务地址、模型标识及调用凭据。 */
  constructor(private readonly config: ProviderRuntimeConfig) {
    this.kind = config.kind
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream'
    }
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    return headers
  }

  /** 查询兼容端点以检查连接与可用模型。 */
  async validate(signal?: AbortSignal): Promise<ProviderValidation> {
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}/models`, {
        headers: this.headers(),
        signal: controller.signal
      })
      if (response.ok) {
        const payload = (await response.json()) as { data?: Array<{ id?: string }> }
        const models = (payload.data ?? []).map((item) => item.id ?? '').filter(Boolean)
        return {
          ok: true,
          latencyMs: Date.now() - started,
          message: `连接成功${this.config.kind === 'ollama' ? '（本地服务）' : ''}`,
          models
        }
      }
      // 部分服务不提供 /models，退化为一次极小的对话探测
      const probe = await this.probeChat(controller.signal)
      if (probe) {
        return {
          ok: true,
          latencyMs: Date.now() - started,
          message: '连接成功（未暴露模型列表）',
          models: []
        }
      }
      throw mapHttpError(response.status, await response.text().catch(() => ''))
    } catch (error) {
      if (error instanceof AppError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new AppError('PROVIDER_TIMEOUT', '连接测试超时，请检查服务地址是否可达。')
      }
      throw new AppError('PROVIDER_ERROR', '无法连接到模型服务，请检查地址与网络。', {
        details: error instanceof Error ? error.message : String(error)
      })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async probeChat(signal: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { ...this.headers(), accept: 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        signal
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        if (response.status === 400 || response.status === 404) return false
        throw mapHttpError(response.status, body)
      }
      return true
    } catch (error) {
      if (error instanceof AppError) throw error
      return false
    }
  }

  /** 发起模型轮次，解析流式增量并产出统一模型事件。 */
  async *runTurn(request: ProviderTurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const { signal: composed, cleanup } = withTimeout(signal)
    const body = {
      model: request.model || this.config.model,
      messages: request.messages.map(toWireMessage),
      tools: request.tools.length
        ? request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters }
          }))
        : undefined,
      tool_choice: request.tools.length ? 'auto' : undefined,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      stream: true
    }

    let response: Response
    try {
      response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: composed
      })
    } catch (error) {
      cleanup()
      if ((error as Error).name === 'AbortError') {
        if (signal.aborted) throw new AppError('CANCELLED', undefined)
        throw new AppError('PROVIDER_TIMEOUT')
      }
      throw new AppError('PROVIDER_ERROR', '请求模型服务失败。', {
        details: error instanceof Error ? error.message : String(error)
      })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      cleanup()
      throw mapHttpError(response.status, text)
    }
    if (!response.body) {
      cleanup()
      throw new AppError('PROVIDER_ERROR', '模型服务未返回数据流。')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    let finished = false

    try {
      while (!finished) {
        if (signal.aborted) throw new AppError('CANCELLED')
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let lineEnd = buffer.indexOf('\n')
        while (lineEnd !== -1) {
          const rawLine = buffer.slice(0, lineEnd).trim()
          buffer = buffer.slice(lineEnd + 1)
          lineEnd = buffer.indexOf('\n')
          if (!rawLine || rawLine.startsWith(':')) continue
          if (!rawLine.startsWith('data:')) continue
          const data = rawLine.slice(5).trim()
          if (data === '[DONE]') {
            finished = true
            break
          }
          let chunk: ChatChunk
          try {
            chunk = JSON.parse(data) as ChatChunk
          } catch {
            continue
          }
          const choice = chunk.choices?.[0]
          const delta = choice?.delta
          if (delta?.content) {
            const text =
              typeof delta.content === 'string'
                ? delta.content
                : delta.content.map((part) => part.text ?? '').join('')
            if (text) yield { type: 'text_delta', text }
          }
          if (delta?.tool_calls) {
            for (const call of delta.tool_calls) {
              const current = toolCalls.get(call.index) ?? { id: '', name: '', args: '' }
              if (call.id) current.id = call.id
              if (call.function?.name) current.name = call.function.name
              if (call.function?.arguments) current.args += call.function.arguments
              toolCalls.set(call.index, current)
            }
          }
          if (chunk.usage) {
            yield {
              type: 'usage',
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0
            }
          }
          if (choice?.finish_reason) {
            finished = true
            yield { type: 'completed', finishReason: choice.finish_reason }
            break
          }
        }
      }

      // 完整参数才交给上层执行，半截 JSON 一律丢弃
      for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!call.name) continue
        yield {
          type: 'tool_call',
          call: {
            callId: call.id || `call_${call.name}_${Date.now()}`,
            name: call.name,
            argumentsJson: call.args || '{}'
          }
        }
      }
      if (!finished) yield { type: 'completed', finishReason: 'stop' }
    } catch (error) {
      if (signal.aborted) throw new AppError('CANCELLED')
      if ((error as Error).name === 'AbortError') throw new AppError('PROVIDER_TIMEOUT')
      if (error instanceof AppError) throw error
      logger.warn('provider', '流式读取中断', {
        message: error instanceof Error ? error.message : String(error)
      })
      throw new AppError('PROVIDER_ERROR', '模型响应流中断。', { retryable: true })
    } finally {
      cleanup()
      reader.releaseLock()
    }
  }
}

/** 将内部消息转换为 OpenAI Chat Completions 协议结构 */
function toWireMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.callId,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson }
      }))
    }
  }
  if (message.role === 'user' && message.images?.length) {
    return {
      role: 'user',
      content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.images.map((url) => ({ type: 'image_url', image_url: { url } }))
      ]
    }
  }
  return { role: message.role, content: message.content }
}
