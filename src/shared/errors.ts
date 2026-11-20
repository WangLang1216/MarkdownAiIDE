/**
 * 统一错误模型。
 * 所有可预期失败都以 AppError 抛出，经 IPC 序列化为 { code, message, retryable, details }。
 */

export const ERROR_CODES = [
  'TARGET_AMBIGUOUS',
  'REVISION_CONFLICT',
  'DISK_CONFLICT',
  'FILE_EXISTS',
  'FILE_NOT_FOUND',
  'OUT_OF_SCOPE',
  'CAPABILITY_MISSING',
  'IMAGE_UNCERTAIN',
  'INVALID_PROPOSAL',
  'INVALID_INPUT',
  'PROVIDER_AUTH',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
  'PROVIDER_NOT_CONFIGURED',
  'PARTIAL_APPLY',
  'RECOVERY_CONFLICT',
  'SAVE_FAILED',
  'SOURCE_UNREADABLE',
  'SOURCE_STALE',
  'SOURCE_CONFLICT',
  'SOURCE_OUT_OF_SCOPE',
  'SOURCE_BUDGET_EXCEEDED',
  'CITATION_INVALID',
  'PREDICTION_STALE',
  'PREDICTION_DISABLED',
  'THEME_INVALID',
  'EXPORT_FAILED',
  'PANDOC_MISSING',
  'CANCELLED',
  'UNKNOWN'
] as const

/** 表示可跨 IPC 传输、可供调用端分支处理的稳定错误码。 */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** 表示可序列化的应用错误，包含提示和重试信息。 */
export interface AppErrorInfo {
  /** 用于调用端分支处理的稳定错误码。 */
  code: ErrorCode
  /** 供界面显示的结果或错误说明。 */
  message: string
  /** 标明在条件变化后是否值得重试。 */
  retryable: boolean
  /** 脱敏后的技术细节，仅用于日志与折叠展示 */
  details?: string
}

/** 面向用户的默认文案，避免把原始 HTTP 响应直接暴露给界面 */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  TARGET_AMBIGUOUS: '目标不明确，请先确认具体位置。',
  REVISION_CONFLICT: '文档在提案生成后已被修改，需要重新读取。',
  DISK_CONFLICT: '磁盘上的文件已被其他程序修改。',
  FILE_EXISTS: '目标位置已存在同名文件。',
  FILE_NOT_FOUND: '文件不存在或已被移动。',
  OUT_OF_SCOPE: '操作超出了当前授权范围。',
  CAPABILITY_MISSING: '当前模型缺少完成该任务所需的能力。',
  IMAGE_UNCERTAIN: '图片中有无法可靠识别的内容。',
  INVALID_PROPOSAL: '修改提案未通过校验。',
  INVALID_INPUT: '输入参数不合法。',
  PROVIDER_AUTH: '模型服务认证失败，请检查密钥。',
  PROVIDER_RATE_LIMIT: '模型服务限流，请稍后重试。',
  PROVIDER_TIMEOUT: '模型服务响应超时。',
  PROVIDER_ERROR: '模型服务返回错误。',
  PROVIDER_NOT_CONFIGURED: '尚未配置可用的模型服务。',
  PARTIAL_APPLY: '部分修改已应用，部分失败。',
  RECOVERY_CONFLICT: '恢复会覆盖新的内容，需要人工选择。',
  SAVE_FAILED: '保存失败，内容仍保留在编辑器中。',
  SOURCE_UNREADABLE: '参考材料无法读取。',
  SOURCE_STALE: '参考材料版本已变化。',
  SOURCE_CONFLICT: '参考材料之间存在冲突信息。',
  SOURCE_OUT_OF_SCOPE: '参考材料不在已授权范围内。',
  SOURCE_BUDGET_EXCEEDED: '参考内容超出上下文预算。',
  CITATION_INVALID: '引用来源无法校验。',
  PREDICTION_STALE: '预测结果已过期。',
  PREDICTION_DISABLED: '预测功能未开启。',
  THEME_INVALID: '主题文件无法解析。',
  EXPORT_FAILED: '导出失败。',
  PANDOC_MISSING: '未找到 Pandoc，无法使用该格式转换。',
  CANCELLED: '操作已取消。',
  UNKNOWN: '发生未知错误。'
}

/** 携带稳定错误码与诊断信息，供服务抛出并在 IPC 边界转换。 */
export class AppError extends Error {
  /** 用于调用端分支处理的稳定错误码。 */
  readonly code: ErrorCode
  /** 标明在条件变化后是否值得重试。 */
  readonly retryable: boolean
  /** 可选的诊断补充信息。 */
  readonly details?: string

  /** 构造带稳定错误码、可选诊断信息及重试标记的异常。 */
  constructor(code: ErrorCode, message?: string, options: { retryable?: boolean; details?: string } = {}) {
    super(message ?? DEFAULT_MESSAGES[code])
    this.name = 'AppError'
    this.code = code
    this.retryable = options.retryable ?? (code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_RATE_LIMIT')
    this.details = options.details
  }

  /** 将异常转换为可跨进程返回的普通对象。 */
  toInfo(): AppErrorInfo {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {})
    }
  }
}

/** 将任意异常收敛为 AppErrorInfo，避免跨进程抛出不可序列化对象 */
export function toErrorInfo(error: unknown): AppErrorInfo {
  if (error instanceof AppError) return error.toInfo()
  if (error instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: error.message || DEFAULT_MESSAGES.UNKNOWN,
      retryable: false
    }
  }
  return { code: 'UNKNOWN', message: DEFAULT_MESSAGES.UNKNOWN, retryable: false }
}

/** 将未知异常转换为可展示的消息文本。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
