/**
 * Provider 抽象：业务层只依赖这些类型，不接触任何厂商 SDK 细节。
 */

import type { ModelCapabilities, ProviderKind } from '@shared/types'

/** 标识模型会话中的系统、用户、模型或工具消息角色。 */
export type ProviderRole = 'system' | 'user' | 'assistant' | 'tool'

/** 表示模型返回的一次工具请求及原始 JSON 参数。 */
export interface ProviderToolCall {
  /** 用于匹配一次模型工具请求、执行结果和任务进度的调用标识。 */
  callId: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 由模型返回的原始 JSON 参数，执行前须解析和校验。 */
  argumentsJson: string
}

/** 表示传给模型的统一消息，可携带图片、工具请求或工具结果。 */
export interface ProviderMessage {
  /** 指定消息在模型上下文中的发送方类型。 */
  role: ProviderRole
  /** 该角色消息的文本内容；只有工具请求时可为空。 */
  content: string
  /** 仅 assistant 消息使用 */
  toolCalls?: ProviderToolCall[]
  /** 仅 tool 消息使用 */
  toolCallId?: string
  /** data URL 列表，仅 user 消息使用 */
  images?: string[]
}

/** 描述向模型公开的工具名称、说明和 JSON Schema。 */
export interface ProviderToolDefinition {
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 提供给模型的工具用途说明。 */
  description: string
  /** 描述模型工具入参的 JSON Schema。 */
  parameters: Record<string, unknown>
}

/** 描述一次模型调用的消息、工具及生成参数。 */
export interface ProviderTurnRequest {
  /** 在接入服务中标识要调用的模型。 */
  model: string
  /** 本轮调用需要发送的有序消息上下文。 */
  messages: ProviderMessage[]
  /** 本轮允许提供给模型的工具定义。 */
  tools: ProviderToolDefinition[]
  /** 提供给模型用于控制生成随机性的采样参数。 */
  temperature: number
  /** 限制单轮由模型生成的输出令牌数。 */
  maxOutputTokens: number
  /** 仅用于日志与去重 */
  taskId: string
}

/** 描述适配器产生的文本增量、工具调用、结束或错误事件。 */
export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ProviderToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'completed'; finishReason: string }

/** 表示适配器连接检测的结果及可选模型列表。 */
export interface ProviderValidation {
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 连接检查测得的耗时，单位为毫秒。 */
  latencyMs: number
  /** 供界面显示的结果或错误说明。 */
  message: string
  /** 连接探测可返回的模型标识列表。 */
  models: string[]
}

/** 约束不同模型接入的连接检测和异步轮次事件流。 */
export interface ProviderAdapter {
  /** 标记当前适配器使用的接入方式。 */
  readonly kind: ProviderKind
  /** 检测配置对应的模型连接，并返回统一的诊断结果。 */
  validate(signal?: AbortSignal): Promise<ProviderValidation>
  /** 以异步迭代器返回单轮模型的文本、工具和结束事件。 */
  runTurn(request: ProviderTurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>
}

/** 汇集构造模型适配器所需的配置和仅主进程可见的密钥。 */
export interface ProviderRuntimeConfig {
  /** 用于选择模型连接配置的标识。 */
  providerId: string
  /** 用于分派该记录的类别标记。 */
  kind: ProviderKind
  /** 模型服务配置的请求根地址。 */
  baseUrl: string
  /** 在接入服务中标识要调用的模型。 */
  model: string
  /** 调用模型接口的凭据；不用于可公开的配置输出。 */
  apiKey: string | null
  /** 控制调用方启用视觉、工具等模型特性的能力声明。 */
  capabilities: ModelCapabilities
}
