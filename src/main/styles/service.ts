/**
 * 写作风格配置：用户显式保存的语气、受众、术语与结构偏好。
 * 不扫描历史文稿，不把一次接受行为自动变成长期画像。
 */

import { readFile } from 'node:fs/promises'
import type { StyleProfile } from '@shared/types'
import { AppError } from '@shared/errors'
import { appPaths } from '../utils/paths'
import { atomicWriteFile, newId } from '../utils/fs'
import { logger } from '../utils/logger'
import type { StyleProfileInput } from '@shared/ipc'

/** 维护风格配置的保存、版本、摘要及面向提示的文本表示。 */
export class StyleService {
  private profiles: StyleProfile[] = []
  private loaded = false

  /** 从本地配置文件读取已保存的风格预设。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(appPaths().stylesFile, 'utf8')
      const parsed = JSON.parse(raw) as { profiles?: StyleProfile[] }
      this.profiles = parsed.profiles ?? []
    } catch {
      this.profiles = []
    }
  }

  /** 列出已保存的风格配置。 */
  list(): StyleProfile[] {
    return [...this.profiles].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 按标识查询风格配置，不存在时返回 null。 */
  get(profileId: string): StyleProfile | null {
    return this.profiles.find((item) => item.profileId === profileId) ?? null
  }

  /** 创建或更新风格配置，并维护版本和更新时间。 */
  async save(input: StyleProfileInput): Promise<StyleProfile> {
    const name = input.name.trim()
    if (!name) throw new AppError('INVALID_INPUT', '风格名称不能为空。')
    const existing = input.profileId ? this.get(input.profileId) : null
    const profile: StyleProfile = {
      profileId: existing?.profileId ?? newId('style'),
      version: (existing?.version ?? 0) + 1,
      scope: input.scope,
      name,
      tone: input.tone?.trim() || null,
      audience: input.audience?.trim() || null,
      language: input.language?.trim() || null,
      terminology: input.terminology ?? {},
      sampleSourceIds: input.sampleSourceIds ?? [],
      preferredStructures: input.preferredStructures ?? [],
      updatedAt: Date.now()
    }
    this.profiles = existing
      ? this.profiles.map((item) => (item.profileId === profile.profileId ? profile : item))
      : [...this.profiles, profile]
    await this.persist()
    return profile
  }

  /** 移除指定风格配置并持久化列表。 */
  async remove(profileId: string): Promise<void> {
    this.profiles = this.profiles.filter((item) => item.profileId !== profileId)
    await this.persist()
  }

  /** 生成提示词片段；只包含用户明确填写的字段 */
  describe(profileId: string | undefined): string {
    if (!profileId) return ''
    const profile = this.get(profileId)
    if (!profile) return ''
    const lines = [`写作风格：${profile.name}`]
    if (profile.tone) lines.push(`语气：${profile.tone}`)
    if (profile.audience) lines.push(`受众：${profile.audience}`)
    if (profile.language) lines.push(`语言：${profile.language}`)
    const terms = Object.entries(profile.terminology)
    if (terms.length) lines.push(`术语：${terms.map(([key, value]) => `${key}→${value}`).join('；')}`)
    if (profile.preferredStructures.length) lines.push(`偏好结构：${profile.preferredStructures.join('、')}`)
    return lines.join('\n')
  }

  /** 返回用于上下文识别的风格摘要。 */
  digest(profileId: string | undefined): string {
    const profile = profileId ? this.get(profileId) : null
    return profile ? `${profile.profileId}@${profile.version}` : 'none'
  }

  private async persist(): Promise<void> {
    await atomicWriteFile(appPaths().stylesFile, JSON.stringify({ profiles: this.profiles }, null, 2)).catch(
      (error) =>
        logger.warn('styles', '风格配置写入失败', {
          message: error instanceof Error ? error.message : String(error)
        })
    )
  }
}
