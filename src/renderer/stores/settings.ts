/**
 * 设置与外观：应用主题、文稿排版、文稿主题 CSS 注入。
 * 应用外观与文稿主题严格分离。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AppInfo, AppSettings, DocThemeInfo, PartialSettings, ThemeMode } from '@shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  appearance: { themeMode: 'light' },
  typography: { fontFamily: 'sans', fontSize: 14, lineHeight: 1.95, maxWidth: 740, docThemeId: 'default' },
  editor: {
    autosave: true,
    autosaveDelayMs: 1200,
    typewriter: false,
    showLineNumbers: true,
    loadRemoteImages: false,
    spellcheck: false
  },
  agent: { autoApplyCurrentDocument: false, maxRounds: 12, temperature: 0.3 },
  prediction: { enabled: true, auto: true, debounceMs: 800, maxPerMinute: 6, maxTokens: 120 },
  export: { includeTheme: true, includeSources: true, pageSize: 'A4', marginMm: 18 },
  storage: { assetsFolder: 'assets', cacheDir: '' },
  appBehavior: { closeAction: 'ask', restoreSession: true },
  openFiles: [],
  recentFiles: [],
  recentWorkspaces: []
}

/** 维护渲染端应用设置和 Provider 列表，并同步主进程更新。 */
export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS))
  const appInfo = ref<AppInfo | null>(null)
  const themes = ref<DocThemeInfo[]>([])
  const loaded = ref(false)
  const systemDark = ref(false)
  const themeCss = ref('')

  const resolvedTheme = computed<'light' | 'dark'>(() => {
    const mode: ThemeMode = settings.value.appearance.themeMode
    if (mode === 'system') return systemDark.value ? 'dark' : 'light'
    return mode
  })

  const activeTheme = computed<DocThemeInfo>(() => {
    const id = settings.value.typography.docThemeId
    return (
      themes.value.find((theme) => theme.themeId === id) ??
      themes.value[0] ?? {
        themeId: 'default',
        name: '小彭友 · 默认',
        kind: 'builtin',
        builtinFont: 'sans',
        cssScopeId: null,
        report: null,
        createdAt: 0
      }
    )
  })

  const isDark = computed(() => resolvedTheme.value === 'dark')

  let media: MediaQueryList | null = null

  async function load(): Promise<void> {
    const [nextSettings, info, themeList] = await Promise.all([
      window.api.settings.get(),
      window.api.app.info(),
      window.api.themes.list()
    ])
    settings.value = nextSettings
    appInfo.value = info
    themes.value = themeList
    loaded.value = true
    apply()
    await refreshThemeCss()
  }

  async function update(patch: PartialSettings): Promise<void> {
    settings.value = await window.api.settings.update(patch)
    apply()
    appInfo.value = appInfo.value ? { ...appInfo.value } : null
  }

  async function reset(): Promise<void> {
    settings.value = await window.api.settings.reset()
    apply()
    await refreshThemeCss()
  }

  function apply(): void {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme.value
    root.dataset.docFont = settings.value.typography.fontFamily
    root.style.setProperty('--article-size', `${settings.value.typography.fontSize}px`)
    root.style.setProperty('--article-line', String(settings.value.typography.lineHeight))
    root.style.setProperty('--article-width', `${settings.value.typography.maxWidth}px`)
    const font =
      settings.value.typography.fontFamily === 'serif'
        ? 'Georgia, "Times New Roman", "SimSun", serif'
        : settings.value.typography.fontFamily === 'mono'
          ? 'var(--mono-font)'
          : '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    root.style.setProperty('--article-font', font)
  }

  function initSystemTheme(): void {
    if (media) return
    media = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = media.matches
    media.addEventListener('change', (event) => {
      systemDark.value = event.matches
      if (settings.value.appearance.themeMode === 'system') apply()
    })
    apply()
  }

  async function refreshThemeCss(): Promise<void> {
    const theme = activeTheme.value
    if (theme.kind !== 'imported') {
      themeCss.value = ''
      removeThemeStyle()
      return
    }
    themeCss.value = await window.api.themes.css(theme.themeId)
    let style = document.getElementById('doc-theme-style') as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = 'doc-theme-style'
      document.head.append(style)
    }
    style.textContent = themeCss.value
  }

  function removeThemeStyle(): void {
    document.getElementById('doc-theme-style')?.remove()
  }

  async function importTheme(): Promise<{ theme: DocThemeInfo; report: unknown } | null> {
    const result = await window.api.themes.import()
    if (!result) return null
    // 先导入并展示兼容报告，由用户确认后再启用，避免突然改变正文排版
    themes.value = await window.api.themes.list()
    return result as unknown as { theme: DocThemeInfo; report: unknown }
  }

  async function activateTheme(themeId: string): Promise<void> {
    themes.value = await window.api.themes.activate(themeId)
    settings.value = await window.api.settings.get()
    await refreshThemeCss()
  }

  async function removeTheme(themeId: string): Promise<void> {
    themes.value = await window.api.themes.remove(themeId)
    settings.value = await window.api.settings.get()
    await refreshThemeCss()
  }

  async function refreshThemes(): Promise<void> {
    themes.value = await window.api.themes.list()
    await refreshThemeCss()
  }

  async function refreshAppInfo(): Promise<void> {
    appInfo.value = await window.api.app.info()
  }

  watch(resolvedTheme, () => apply())

  return {
    settings,
    appInfo,
    themes,
    loaded,
    themeCss,
    activeTheme,
    resolvedTheme,
    isDark,
    load,
    update,
    reset,
    apply,
    initSystemTheme,
    refreshThemeCss,
    importTheme,
    activateTheme,
    removeTheme,
    refreshThemes,
    refreshAppInfo
  }
})
