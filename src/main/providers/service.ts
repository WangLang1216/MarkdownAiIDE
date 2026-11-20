/**
 * Provider 配置服务：持久化非敏感字段，密钥交给 SecretService。
 * 能力探测结果允许用户覆盖，避免把“接口能连通”等同于“Agent 用例可用”。
 */

import { readFile } from 'node:fs/promises'
import type {
  ConnectionResult,
  ModelCapabilities,
  ProviderConfig,
  ProviderInput,
  ProviderKind
} from '@shared/types'
import { AppError } from '@shared/errors'
import { appPaths } from '../utils/paths'
import { atomicWriteFile } from '../utils/fs'
import { newId } from '../utils/fs'
import { logger } from '../utils/logger'
import type { SecretService } from '../secrets/service'
import type { ProviderAdapter, ProviderRuntimeConfig } from './types'
import { OpenAICompatibleAdapter, normalizeBaseUrl } from './openai'
import { MockAdapter } from './mock'

const VISION_HINT = /gpt-4o|gpt-4\.1|gpt-5|o3|o4|vision|claude|gemini|qwen[-_]?vl|llava|pixtral|glm-4v/i

/** 根据服务类型与模型名给出能力默认值，最终可在界面逐项覆盖 */
export function inferCapabilities(
  kind: ProviderKind,
  model: string,
  override?: Partial<ModelCapabilities>
): ModelCapabilities {
  const base: ModelCapabilities =
    kind === 'mock'
      ? { text: true, vision: true, toolCalling: true, structuredOutput: true, streaming: true }
      : {
          text: true,
          vision: VISION_HINT.test(model),
          toolCalling: true,
          structuredOutput: kind === 'openai',
          streaming: true
        }
  return { ...base, ...(override ?? {}) }
}

/** 维护模型接入配置、默认选择和验证，按配置创建运行时适配器。 */
export class ProviderService {
  private configs: ProviderConfig[] = []
  private loaded = false

  /** 绑定用于读取或保存模型凭据的密钥服务。 */
  constructor(private readonly secrets: SecretService) {}

  /** 读取本地 Provider 配置并准备默认选项。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(appPaths().providersFile, 'utf8')
      const parsed = JSON.parse(raw) as { providers?: ProviderConfig[] }
      this.configs = (parsed.providers ?? []).map((config) => ({
        ...config,
        hasSecret: this.secrets.has(config.providerId)
      }))
    } catch {
      this.configs = []
    }
    if (this.configs.length === 0) {
      const now = Date.now()
      this.configs = [
        {
          providerId: 'provider_mock',
          name: '内置演示',
          kind: 'mock',
          baseUrl: 'mock://local',
          model: 'mock-writer',
          capabilities: inferCapabilities('mock', 'mock-writer'),
          hasSecret: false,
          isDefault: true,
          createdAt: now,
          updatedAt: now
        }
      ]
      await this.persist()
    }
  }

  /** 返回不含明文密钥的 Provider 配置列表。 */
  list(): ProviderConfig[] {
    return this.configs.map((config) => ({ ...config, hasSecret: this.secrets.has(config.providerId) }))
  }

  /** 按标识读取指定 Provider 的公共配置。 */
  get(providerId: string): ProviderConfig {
    const config = this.configs.find((item) => item.providerId === providerId)
    if (!config) throw new AppError('PROVIDER_NOT_CONFIGURED', '模型配置不存在。')
    return config
  }

  /** 取得当前默认的 Provider 配置。 */
  getDefault(): ProviderConfig {
    return (
      this.configs.find((item) => item.isDefault) ??
      this.configs[0] ??
      (() => {
        throw new AppError('PROVIDER_NOT_CONFIGURED')
      })()
    )
  }

  /** 保存模型配置，并将提供的密钥交给密钥服务处理。 */
  async save(input: ProviderInput): Promise<ProviderConfig> {
    const kind: ProviderKind = input.kind
    if (!input.name.trim()) throw new AppError('INVALID_INPUT', '配置名称不能为空。')
    if (!input.model.trim()) throw new AppError('INVALID_INPUT', '模型名称不能为空。')
    const baseUrl = kind === 'mock' ? input.baseUrl || 'mock://local' : normalizeBaseUrl(input.baseUrl)

    const existing = input.providerId
      ? this.configs.find((item) => item.providerId === input.providerId)
      : null
    const providerId = existing?.providerId ?? input.providerId ?? newId('provider')
    const now = Date.now()

    if (input.apiKey !== undefined && input.apiKey !== null) {
      if (input.apiKey.trim()) await this.secrets.set(providerId, input.apiKey.trim())
      else await this.secrets.delete(providerId)
    }

    const config: ProviderConfig = {
      providerId,
      name: input.name.trim(),
      kind,
      baseUrl,
      model: input.model.trim(),
      capabilities: inferCapabilities(kind, input.model, input.capabilities ?? existing?.capabilities),
      hasSecret: this.secrets.has(providerId),
      isDefault: existing?.isDefault ?? this.configs.length === 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      temperature: input.temperature ?? existing?.temperature,
      maxOutputTokens: input.maxOutputTokens ?? existing?.maxOutputTokens
    }

    if (existing) {
      this.configs = this.configs.map((item) => (item.providerId === providerId ? config : item))
    } else {
      this.configs = [...this.configs, config]
    }
    await this.persist()
    return { ...config, hasSecret: this.secrets.has(providerId) }
  }

  /** 移除 Provider 配置及其关联密钥。 */
  async remove(providerId: string): Promise<void> {
    const target = this.configs.find((item) => item.providerId === providerId)
    if (!target) return
    this.configs = this.configs.filter((item) => item.providerId !== providerId)
    await this.secrets.delete(providerId)
    if (target.isDefault && this.configs.length) this.configs[0].isDefault = true
    await this.persist()
  }

  /** 更新默认模型配置并持久化。 */
  async setDefault(providerId: string): Promise<ProviderConfig[]> {
    this.get(providerId)
    this.configs = this.configs.map((item) => ({ ...item, isDefault: item.providerId === providerId }))
    await this.persist()
    return this.list()
  }

  /** 测试指定 Provider 的连接并返回耗时与能力信息。 */
  async test(providerId: string): Promise<ConnectionResult> {
    const config = this.get(providerId)
    const adapter = this.adapterFor(config)
    const result = await adapter.validate()
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      message: result.message,
      capabilities: config.capabilities,
      models: result.models
    }
  }

  /** 构造运行时适配器，凭据只存在于该对象生命周期内 */
  adapterFor(providerIdOrConfig: string | ProviderConfig): ProviderAdapter {
    const config = typeof providerIdOrConfig === 'string' ? this.get(providerIdOrConfig) : providerIdOrConfig
    const runtime: ProviderRuntimeConfig = {
      providerId: config.providerId,
      kind: config.kind,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: this.secrets.get(config.providerId),
      capabilities: config.capabilities
    }
    logger.info('provider', '创建适配器', {
      providerId: config.providerId,
      kind: config.kind,
      model: config.model
    })
    return config.kind === 'mock' ? new MockAdapter() : new OpenAICompatibleAdapter(runtime)
  }

  private async persist(): Promise<void> {
    await atomicWriteFile(
      appPaths().providersFile,
      JSON.stringify({ providers: this.configs.map(({ ...rest }) => rest) }, null, 2)
    )
  }
}
