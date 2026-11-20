/**
 * 行内预测：手动或停顿后生成短候选，不写文档、不后台抓取网页。
 * 单在途请求 + 频率上限 + 上下文指纹校验，过期结果由渲染进程丢弃。
 */

import { randomUUID } from 'node:crypto'
import type { PredictionRequestInput, PredictionResult } from '@shared/types'
import { AppError, toErrorInfo } from '@shared/errors'
import { PredictionRequestSchema, formatIssues } from '@shared/schemas'
import { sha256 } from '../utils/fs'
import { logger } from '../utils/logger'
import type { ProviderService } from '../providers/service'
import type { DocumentService } from '../documents/service'
import type { ReferenceService } from '../references/service'
import type { SettingsStore } from '../settings/store'
import type { StyleService } from '../styles/service'

const PROMPT_VERSION = 'prediction-v2'
const CACHE_TTL_MS = 3 * 60 * 1000
const MAX_CACHE = 60
const PREFIX_LIMIT = 1800
const SUFFIX_LIMIT = 800

interface CacheEntry {
  text: string
  createdAt: number
  contextKey: PredictionResult['contextKey']
}

/** 为光标续写管理版本校验、并发取消、频控、缓存和模型请求。 */
export class PredictionService {
  private inFlight: { requestId: string; abort: AbortController } | null = null
  private calls: number[] = []
  private cache = new Map<string, CacheEntry>()

  /** 注入预测需要的文稿、模型、来源、风格和设置服务。 */
  constructor(
    private readonly providers: ProviderService,
    private readonly documents: DocumentService,
    private readonly references: ReferenceService,
    private readonly styles: StyleService,
    private readonly settings: SettingsStore
  ) {}

  /** 为指定文稿修订与光标上下文生成或复用续写候选，不修改文稿。 */
  async request(input: PredictionRequestInput): Promise<PredictionResult | null> {
    const parsed = PredictionRequestSchema.safeParse(input)
    if (!parsed.success) throw new AppError('INVALID_INPUT', formatIssues(parsed.error))
    const data = parsed.data
    const settings = this.settings.get()
    if (!settings.prediction.enabled) {
      throw new AppError('PREDICTION_DISABLED', '预测功能已关闭。')
    }
    if (data.trigger === 'auto' && !settings.prediction.auto) return null

    const session = this.documents.getSession(data.documentId)
    if (session.revision !== data.revision) {
      throw new AppError('PREDICTION_STALE', '文档已变化，预测请求已过期。')
    }
    this.enforceRate(data.trigger)

    this.inFlight?.abort.abort()
    const provider = data.providerId ? this.providers.get(data.providerId) : this.providers.getDefault()
    const offset = Math.max(0, Math.min(data.offset, session.text.length))
    const prefix = session.text.slice(Math.max(0, offset - PREFIX_LIMIT), offset)
    const suffix = session.text.slice(offset, Math.min(session.text.length, offset + SUFFIX_LIMIT))
    const sourceIds = data.sourceIds.filter((id) =>
      this.references.list().some((asset) => asset.sourceId === id)
    )
    const sourceDigest = this.references.digest(sourceIds)
    const styleDigest = this.styles.digest(data.styleProfileId)
    const contextKey = {
      documentId: session.documentId,
      revision: session.revision,
      fromUtf16: offset,
      toUtf16: offset,
      sourceSetDigest: sourceDigest,
      styleDigest,
      providerConfigVersion: provider.updatedAt
    }
    const cacheKey = sha256(
      JSON.stringify({ contextKey, prefix, suffix, provider: provider.providerId, prompt: PROMPT_VERSION })
    )
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return {
        requestId: randomUUID(),
        text: cached.text,
        contextKey,
        createdAt: Date.now(),
        cached: true,
        evidence: []
      }
    }

    const bundle = this.references.buildContext(sourceIds, prefix.slice(-400), 6000)
    const style = this.styles.describe(data.styleProfileId)
    const system = [
      '你是 Markdown 写作的续写引擎。',
      '只输出紧接光标处应出现的 1–3 句文本，不要解释、不要加代码围栏、不要重复已有内容。',
      '前文较短（只有一句或一行诗）时也直接从光标处续写，不要返回空内容。',
      '保持与上下文相同的语言、人称与语气。',
      '不得编造具体数字、日期、人名或来源；信息不足时写通用表达。',
      style ? `\n${style}` : '',
      bundle.includedSources.length
        ? `\n可用参考（仅在确有依据时使用，正文中用 [S1] 等标记）：\n${bundle.text}`
        : ''
    ]
      .filter(Boolean)
      .join('\n')

    const user = [
      `文档：《${session.title}》`,
      '已有前文：',
      '>>>',
      prefix || '（文档开头）',
      '>>>',
      '光标在此处。',
      suffix ? `已有后文（不要重复）：\n>>>\n${suffix}\n>>>` : ''
    ]
      .filter(Boolean)
      .join('\n')

    const abort = new AbortController()
    const requestId = randomUUID()
    this.inFlight = { requestId, abort }
    const adapter = this.providers.adapterFor(provider)
    let text = ''
    try {
      for await (const event of adapter.runTurn(
        {
          model: provider.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          tools: [],
          temperature: Math.min(settings.agent.temperature, 0.7),
          maxOutputTokens: settings.prediction.maxTokens,
          taskId: `prediction:${requestId}`
        },
        abort.signal
      )) {
        if (event.type === 'text_delta') text += event.text
      }
    } catch (error) {
      if (abort.signal.aborted) return null
      const info = toErrorInfo(error)
      logger.warn('prediction', '预测失败', { code: info.code })
      throw error instanceof AppError ? error : new AppError('PROVIDER_ERROR', info.message)
    } finally {
      if (this.inFlight?.requestId === requestId) this.inFlight = null
    }

    const sanitized = sanitizeCompletion(text, suffix)
    if (!sanitized) return null
    this.cache.set(cacheKey, { text: sanitized, createdAt: Date.now(), contextKey })
    if (this.cache.size > MAX_CACHE) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (oldest) this.cache.delete(oldest[0])
    }
    return { requestId, text: sanitized, contextKey, createdAt: Date.now(), cached: false, evidence: [] }
  }

  /** 中止与请求 ID 匹配的在途预测。 */
  async cancel(requestId: string): Promise<void> {
    if (this.inFlight?.requestId === requestId) {
      this.inFlight.abort.abort()
      this.inFlight = null
    }
  }

  private enforceRate(trigger: 'manual' | 'auto'): void {
    const settings = this.settings.get()
    const now = Date.now()
    this.calls = this.calls.filter((time) => now - time < 60_000)
    if (this.calls.length >= settings.prediction.maxPerMinute) {
      if (trigger === 'auto')
        throw new AppError('PREDICTION_DISABLED', '自动预测已暂停：达到每分钟调用上限。')
      throw new AppError('PROVIDER_RATE_LIMIT', '预测请求过于频繁，请稍后再试。', { retryable: true })
    }
    this.calls.push(now)
  }
}

/** 清理模型输出：去围栏、去前缀解释、避免与后文重复 */
export function sanitizeCompletion(raw: string, suffix: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim()
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')
  text = text.replace(/^(续写|输出|补全)[:：]\s*/u, '')
  text = text.replace(/^["'“”]([\s\S]*?)["'“”]$/u, '$1').trim()
  if (!text) return ''
  const normalizedSuffix = suffix.slice(0, 60)
  if (normalizedSuffix && text.endsWith(normalizedSuffix)) {
    text = text.slice(0, text.length - normalizedSuffix.length).trim()
  }
  return text.slice(0, 600)
}
