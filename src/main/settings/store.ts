/**
 * 应用设置的读写与迁移。
 * 全部为显式字段，未知字段在读取时被丢弃，避免旧版本残留污染。
 */

import { readFile } from 'node:fs/promises'
import { appPaths } from '../utils/paths'
import { atomicWriteFile } from '../utils/fs'
import { logger } from '../utils/logger'
import type { AppSettings, PartialSettings, RecentEntry } from '@shared/types'

/** 定义首次启动、设置缺省及重置时使用的默认值。 */
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  appearance: { themeMode: 'light' },
  typography: {
    fontFamily: 'sans',
    fontSize: 14,
    lineHeight: 1.95,
    maxWidth: 740,
    docThemeId: 'default'
  },
  editor: {
    autosave: true,
    autosaveDelayMs: 1200,
    typewriter: false,
    showLineNumbers: true,
    loadRemoteImages: false,
    spellcheck: false
  },
  agent: {
    autoApplyCurrentDocument: false,
    maxRounds: 12,
    temperature: 0.3
  },
  prediction: {
    enabled: true,
    auto: true,
    debounceMs: 800,
    maxPerMinute: 6,
    maxTokens: 120
  },
  export: {
    includeTheme: true,
    includeSources: true,
    pageSize: 'A4',
    marginMm: 18
  },
  storage: {
    assetsFolder: 'assets',
    cacheDir: ''
  },
  appBehavior: {
    closeAction: 'ask',
    restoreSession: true
  },
  openFiles: [],
  recentFiles: [],
  recentWorkspaces: []
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** 资源目录只允许文稿内的相对目录名，拒绝绝对路径与 `..`，避免写出授权目录 */
function sanitizeAssetsFolder(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
          .trim()
          .replace(/\\/g, '/')
          .replace(/^\.?\/*/, '')
      : ''
  if (!raw) return 'assets'
  const segments = raw.split('/').filter(Boolean)
  if (!segments.length || segments.some((segment) => segment === '..' || segment === '.')) {
    return 'assets'
  }
  return segments.join('/').slice(0, 120)
}

/** 负责应用设置的加载、合并、持久化以及最近使用记录。 */
export class SettingsStore {
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  private loaded = false

  /** 从磁盘读取配置，与默认设置合并得到运行时值。 */
  async load(): Promise<AppSettings> {
    if (this.loaded) return this.settings
    try {
      const raw = await readFile(appPaths().settingsFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.settings = this.migrate(parsed)
    } catch {
      this.settings = structuredClone(DEFAULT_SETTINGS)
    }
    this.loaded = true
    return this.settings
  }

  /** 读取当前应用设置。 */
  get(): AppSettings {
    return this.settings
  }

  /** 合并局部设置并持久化更新后的配置。 */
  async update(patch: PartialSettings): Promise<AppSettings> {
    const next: AppSettings = {
      ...this.settings,
      appearance: { ...this.settings.appearance, ...patch.appearance },
      typography: { ...this.settings.typography, ...patch.typography },
      editor: { ...this.settings.editor, ...patch.editor },
      agent: { ...this.settings.agent, ...patch.agent },
      prediction: { ...this.settings.prediction, ...patch.prediction },
      export: { ...this.settings.export, ...patch.export },
      storage: { ...this.settings.storage, ...patch.storage },
      appBehavior: { ...this.settings.appBehavior, ...patch.appBehavior }
    }
    this.settings = this.normalize(next)
    await this.persist()
    return this.settings
  }

  /** 恢复默认配置并持久化。 */
  async reset(): Promise<AppSettings> {
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      recentFiles: this.settings.recentFiles,
      recentWorkspaces: this.settings.recentWorkspaces
    }
    await this.persist()
    return this.settings
  }

  /** 更新最近打开文稿的记录与排列顺序。 */
  async rememberFile(path: string, title: string): Promise<void> {
    const entry: RecentEntry = { path, title, openedAt: Date.now() }
    const rest = this.settings.recentFiles.filter((item) => item.path !== path)
    this.settings.recentFiles = [entry, ...rest].slice(0, 12)
    await this.persist()
  }

  /** 更新最近打开工作区的路径列表。 */
  async rememberWorkspace(path: string): Promise<void> {
    const rest = this.settings.recentWorkspaces.filter((item) => item !== path)
    this.settings.recentWorkspaces = [path, ...rest].slice(0, 8)
    await this.persist()
  }

  /** 记录当前打开的文稿，供下次启动恢复 */
  async setOpenFiles(paths: string[]): Promise<void> {
    const next = paths.filter((path) => Boolean(path)).slice(0, 12)
    if (
      next.length === this.settings.openFiles.length &&
      next.every((p, i) => p === this.settings.openFiles[i])
    ) {
      return
    }
    this.settings.openFiles = next
    await this.persist()
  }

  private normalize(settings: AppSettings): AppSettings {
    return {
      schemaVersion: 1,
      appearance: {
        themeMode: ['light', 'dark', 'system'].includes(settings.appearance.themeMode)
          ? settings.appearance.themeMode
          : 'light'
      },
      typography: {
        fontFamily: ['sans', 'serif', 'mono'].includes(settings.typography.fontFamily)
          ? settings.typography.fontFamily
          : 'sans',
        fontSize: clamp(settings.typography.fontSize, 12, 22, 14),
        lineHeight: clamp(settings.typography.lineHeight, 1.4, 2.4, 1.95),
        maxWidth: clamp(settings.typography.maxWidth, 560, 1100, 740),
        docThemeId: settings.typography.docThemeId || 'default'
      },
      editor: {
        autosave: Boolean(settings.editor.autosave),
        autosaveDelayMs: clamp(settings.editor.autosaveDelayMs, 300, 10000, 1200),
        typewriter: Boolean(settings.editor.typewriter),
        showLineNumbers: Boolean(settings.editor.showLineNumbers),
        loadRemoteImages: Boolean(settings.editor.loadRemoteImages),
        spellcheck: Boolean(settings.editor.spellcheck)
      },
      agent: {
        autoApplyCurrentDocument: Boolean(settings.agent.autoApplyCurrentDocument),
        maxRounds: clamp(settings.agent.maxRounds, 2, 24, 12),
        temperature: clamp(settings.agent.temperature, 0, 1.5, 0.3)
      },
      prediction: {
        enabled: Boolean(settings.prediction.enabled),
        auto: Boolean(settings.prediction.auto),
        debounceMs: clamp(settings.prediction.debounceMs, 400, 4000, 800),
        maxPerMinute: clamp(settings.prediction.maxPerMinute, 1, 20, 6),
        maxTokens: clamp(settings.prediction.maxTokens, 32, 400, 120)
      },
      export: {
        includeTheme: Boolean(settings.export.includeTheme),
        includeSources: Boolean(settings.export.includeSources),
        pageSize: settings.export.pageSize === 'Letter' ? 'Letter' : 'A4',
        marginMm: clamp(settings.export.marginMm, 5, 40, 18)
      },
      storage: {
        assetsFolder: sanitizeAssetsFolder(settings.storage?.assetsFolder),
        cacheDir:
          typeof settings.storage?.cacheDir === 'string' ? settings.storage.cacheDir.trim().slice(0, 512) : ''
      },
      appBehavior: {
        closeAction: ['ask', 'tray', 'quit'].includes(settings.appBehavior?.closeAction ?? '')
          ? settings.appBehavior.closeAction
          : 'ask',
        restoreSession: settings.appBehavior?.restoreSession !== false
      },
      openFiles: Array.isArray(settings.openFiles)
        ? settings.openFiles
            .filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
            .slice(0, 12)
        : [],
      recentFiles: Array.isArray(settings.recentFiles)
        ? settings.recentFiles
            .filter(
              (entry) => entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path
            )
            .slice(0, 12)
        : [],
      recentWorkspaces: Array.isArray(settings.recentWorkspaces)
        ? settings.recentWorkspaces
            .filter((item): item is string => typeof item === 'string' && Boolean(item))
            .slice(0, 8)
        : []
    }
  }

  private migrate(parsed: Partial<AppSettings>): AppSettings {
    const merged: AppSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      appearance: { ...DEFAULT_SETTINGS.appearance, ...parsed.appearance },
      typography: { ...DEFAULT_SETTINGS.typography, ...parsed.typography },
      editor: { ...DEFAULT_SETTINGS.editor, ...parsed.editor },
      agent: { ...DEFAULT_SETTINGS.agent, ...parsed.agent },
      prediction: { ...DEFAULT_SETTINGS.prediction, ...parsed.prediction },
      export: { ...DEFAULT_SETTINGS.export, ...parsed.export },
      storage: { ...DEFAULT_SETTINGS.storage, ...parsed.storage },
      appBehavior: { ...DEFAULT_SETTINGS.appBehavior, ...parsed.appBehavior }
    }
    return this.normalize(merged)
  }

  /** 将当前设置序列化并写入应用设置文件。 */
  async persist(): Promise<void> {
    try {
      await atomicWriteFile(appPaths().settingsFile, JSON.stringify(this.settings, null, 2))
    } catch (error) {
      logger.error('settings', '设置保存失败', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
