/**
 * 文稿主题服务：导入 Typora CSS，复制本地资源、隔离选择器、生成兼容报告。
 * 主题只影响正文预览与导出，不污染应用工具栏；远程资源一律不加载。
 */

import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { dialog } from 'electron'
import type { DocThemeInfo, ThemeCompatibilityReport } from '@shared/types'
import { AppError } from '@shared/errors'
import { appPaths } from '../utils/paths'
import { atomicWriteFile, isPathInside, newId } from '../utils/fs'
import { logger } from '../utils/logger'
import type { SettingsStore } from '../settings/store'
import { buildLiveOverride, missingALevel, scopeCss } from '@shared/theme/scoping'

const MAX_CSS_BYTES = 1.5 * 1024 * 1024
const MAX_ASSET_BYTES = 5 * 1024 * 1024
const MAX_ASSETS = 30
const ALLOWED_ASSET_EXT = new Set([
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg'
])

/** 列出随应用提供的文稿排版主题。 */
export const BUILTIN_THEMES: DocThemeInfo[] = [
  {
    themeId: 'default',
    name: '小彭友 · 默认',
    kind: 'builtin',
    builtinFont: 'sans',
    cssScopeId: null,
    report: null,
    createdAt: 0
  },
  {
    themeId: 'serif',
    name: '纸感 · 衬线',
    kind: 'builtin',
    builtinFont: 'serif',
    cssScopeId: null,
    report: null,
    createdAt: 0
  },
  {
    themeId: 'minimal',
    name: '极简 · 留白',
    kind: 'builtin',
    builtinFont: 'sans',
    cssScopeId: null,
    report: null,
    createdAt: 0
  }
]

interface ThemeMeta extends DocThemeInfo {
  sourceName: string
  previewScope: string
}

/** 负责导入和管理文稿主题、隔离样式、处理主题资源并更新当前选择。 */
export class ThemeService {
  private imported: ThemeMeta[] = []

  /** 绑定设置服务，以保存和读取当前主题选择。 */
  constructor(private readonly settings: SettingsStore) {}

  /** 加载已导入主题的本地索引。 */
  async load(): Promise<void> {
    const dir = appPaths().themesDir
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('theme_')) continue
      const raw = await readFile(join(dir, entry.name, 'meta.json'), 'utf8').catch(() => null)
      if (!raw) continue
      try {
        this.imported.push(JSON.parse(raw) as ThemeMeta)
      } catch {
        logger.warn('themes', '主题元数据损坏', { themeId: entry.name })
      }
    }
  }

  /** 返回内置主题和已导入主题的列表。 */
  list(): DocThemeInfo[] {
    return [
      ...BUILTIN_THEMES,
      ...this.imported.map(({ sourceName: _sourceName, previewScope: _previewScope, ...info }) => info)
    ]
  }

  /** 使用文件选择器选择主题 CSS 并导入。 */
  async importDialog(): Promise<{ theme: DocThemeInfo; report: ThemeCompatibilityReport } | null> {
    const result = await dialog.showOpenDialog({
      title: '选择 Typora 主题 CSS',
      properties: ['openFile'],
      filters: [{ name: 'CSS 主题', extensions: ['css'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return this.importCss(result.filePaths[0])
  }

  /** 处理主题样式和资源，生成隔离 CSS 与兼容性报告并登记导入结果。 */
  async importCss(cssPath: string): Promise<{ theme: DocThemeInfo; report: ThemeCompatibilityReport }> {
    const info = await stat(cssPath).catch(() => null)
    if (!info?.isFile()) throw new AppError('THEME_INVALID', '主题文件不存在。')
    if (info.size > MAX_CSS_BYTES) throw new AppError('THEME_INVALID', '主题 CSS 超过 1.5MB 限制。')
    const raw = await readFile(cssPath, 'utf8')
    if (!raw.trim()) throw new AppError('THEME_INVALID', '主题文件为空。')

    const themeId = newId('theme')
    const scopeId = `doc-${themeId}`
    const themeDir = join(appPaths().themesDir, themeId)
    const assetDir = join(themeDir, 'assets')
    await mkdir(assetDir, { recursive: true })

    const assetResult = await this.importAssets(raw, resolve(cssPath, '..'), themeId, assetDir)
    const preview = scopeCss(assetResult.css, scopeId)
    if (!preview.css.trim()) throw new AppError('THEME_INVALID', '主题中没有可用的样式规则。')
    const live = buildLiveOverride(raw, scopeId)

    const report: ThemeCompatibilityReport = {
      ruleCount: preview.ruleCount,
      aLevelCovered: preview.aLevelCovered,
      bLevelCovered: preview.bLevelCovered,
      missingALevel: missingALevel(preview.aLevelCovered),
      remoteAssetsBlocked: assetResult.remoteBlocked,
      importedAssets: assetResult.imported,
      warnings: [...preview.warnings, ...assetResult.warnings]
    }

    const meta: ThemeMeta = {
      themeId,
      name: basename(cssPath, extname(cssPath)).slice(0, 40) || '导入主题',
      kind: 'imported',
      builtinFont: null,
      cssScopeId: scopeId,
      report,
      createdAt: Date.now(),
      sourceName: basename(cssPath),
      previewScope: scopeId
    }

    await atomicWriteFile(join(themeDir, 'theme.css'), preview.css)
    await atomicWriteFile(join(themeDir, 'live.css'), live)
    await atomicWriteFile(join(themeDir, 'meta.json'), JSON.stringify(meta, null, 2))
    this.imported.push(meta)
    logger.info('themes', '导入主题', { themeId, rules: preview.ruleCount, assets: assetResult.imported })
    return { theme: meta, report }
  }

  /** 将指定文稿主题设置为当前主题。 */
  async activate(themeId: string): Promise<DocThemeInfo[]> {
    if (!this.list().some((theme) => theme.themeId === themeId)) {
      throw new AppError('THEME_INVALID', '主题不存在。')
    }
    await this.settings.update({ typography: { docThemeId: themeId } })
    return this.list()
  }

  /** 移除导入主题，并在需要时恢复默认主题选择。 */
  async remove(themeId: string): Promise<DocThemeInfo[]> {
    if (!themeId.startsWith('theme_')) throw new AppError('INVALID_INPUT', '内置主题不能删除。')
    const dir = join(appPaths().themesDir, themeId)
    if (!dir.startsWith(appPaths().themesDir)) throw new AppError('OUT_OF_SCOPE')
    await rm(dir, { recursive: true, force: true })
    this.imported = this.imported.filter((item) => item.themeId !== themeId)
    if (this.settings.get().typography.docThemeId === themeId) {
      await this.settings.update({ typography: { docThemeId: 'default' } })
    }
    return this.list()
  }

  /** 返回可直接注入预览容器的 CSS；内置主题由应用样式表提供 */
  async css(themeId: string): Promise<string> {
    if (!themeId.startsWith('theme_')) return ''
    const css = await readFile(join(appPaths().themesDir, themeId, 'theme.css'), 'utf8').catch(() => '')
    const live = await readFile(join(appPaths().themesDir, themeId, 'live.css'), 'utf8').catch(() => '')
    return `${css}\n${live}`
  }

  /** 导出 HTML 时使用同一份隔离样式 */
  async exportCss(themeId: string): Promise<string> {
    return this.css(themeId)
  }

  /** 返回主题的 CSS 隔离作用域标识。 */
  scopeOf(themeId: string): string | null {
    return this.imported.find((item) => item.themeId === themeId)?.cssScopeId ?? null
  }

  private async importAssets(
    css: string,
    sourceDir: string,
    themeId: string,
    assetDir: string
  ): Promise<{ css: string; imported: number; remoteBlocked: number; warnings: string[] }> {
    const warnings: string[] = []
    let imported = 0
    let remoteBlocked = 0
    const seen = new Map<string, string>()

    const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
    let output = css
    const replacements: Array<{ from: string; to: string }> = []
    let match: RegExpExecArray | null
    while ((match = urlPattern.exec(css)) !== null) {
      const target = match[2].trim()
      if (!target || target.startsWith('data:') || target.startsWith('#')) continue
      if (/^(https?:)?\/\//i.test(target)) {
        remoteBlocked += 1
        replacements.push({ from: match[0], to: 'none' })
        continue
      }
      if (imported >= MAX_ASSETS) {
        warnings.push('主题资源数量超过 30 个，多余资源未导入。')
        break
      }
      const clean = target.split(/[?#]/)[0]
      const abs = resolve(sourceDir, clean)
      if (!isPathInside(resolve(sourceDir), abs)) {
        warnings.push(`资源路径越界已忽略：${target}`)
        continue
      }
      const ext = extname(abs).toLowerCase()
      if (!ALLOWED_ASSET_EXT.has(ext)) {
        warnings.push(`不支持的主题资源类型：${target}`)
        continue
      }
      const info = await stat(abs).catch(() => null)
      if (!info?.isFile() || info.size > MAX_ASSET_BYTES) {
        warnings.push(`主题资源缺失或过大：${target}`)
        continue
      }
      let fileName = seen.get(abs)
      if (!fileName) {
        fileName = `${newId('asset')}${ext}`
        await copyFile(abs, join(assetDir, fileName))
        seen.set(abs, fileName)
        imported += 1
      }
      replacements.push({ from: match[0], to: `url("mdtheme://${themeId}/assets/${fileName}")` })
    }
    for (const item of replacements) output = output.split(item.from).join(item.to)
    return { css: output, imported, remoteBlocked, warnings }
  }
}
