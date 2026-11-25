import { app, net } from 'electron'
import { dirname } from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { AppError } from '@shared/errors'
import {
  initialUpdateState,
  newerVersion,
  releasePageUrl,
  stableVersion,
  type UpdateRelease,
  type UpdateState
} from '@shared/update'
import type { SettingsStore } from '../settings/store'
import { logger } from '../utils/logger'

const owner = 'WangLang1216'
const repo = 'MarkdownAiIDE'
const releaseUrl = releasePageUrl
const latestPageUrl = releaseUrl + '/latest'
const apiLatest = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/latest'
const apiTags = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/tags/'

const TIMEOUT = 15000

export class UpdateService {
  private readonly updater = process.platform === 'win32' && app.isPackaged
    ? new NsisUpdater({ provider: 'github', owner, repo })
    : null
  private state: UpdateState = { ...initialUpdateState }
  private checking: Promise<UpdateState> | null = null
  private downloading: Promise<UpdateState> | null = null

  constructor(private readonly settings: SettingsStore, private readonly publish: (state: UpdateState) => void) {
    if (!this.updater) return
    this.updater.installDirectory = dirname(process.execPath)
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.allowPrerelease = false
    this.updater.allowDowngrade = false
    this.updater.disableWebInstaller = true
    this.updater.on('download-progress', ({ percent }) => this.set({ percent: Math.round(percent) }))
    this.updater.on('error', (error) => {
      logger.warn('updates', '更新流程出错', { message: error.message })
      if (this.state.phase === 'installing') this.set({ phase: 'ready', message: '启动安装失败，可稍后重试。' })
    })
  }

  get snapshot(): UpdateState { return this.state }

  get readyForAutomaticInstall(): boolean {
    return this.state.phase === 'ready' && this.settings.get().appBehavior.autoUpdate
  }

  check(): Promise<UpdateState> {
    if (this.downloading) return this.downloading
    if (this.state.phase === 'ready' || this.state.phase === 'installing') return Promise.resolve(this.state)
    if (!this.checking) this.checking = this.fetchLatest().finally(() => { this.checking = null })
    return this.checking
  }

  private async fetchLatest(): Promise<UpdateState> {
    this.set({ phase: 'checking', message: '' })
    try {
      const tag = await this.resolveLatestTag()
      if (!tag) return this.set({ phase: 'current', release: null, message: '暂未找到公开发行版。' })
      if (!newerVersion(tag, app.getVersion())) {
        return this.set({ phase: 'current', release: null, message: '当前已是最新版本。' })
      }
      const version = stableVersion(tag)!
      const meta = await this.releaseMeta(tag)
      const release: UpdateRelease = {
        version,
        title: meta.title || '版本 ' + version,
        notes: meta.notes,
        publishedAt: meta.publishedAt,
        url: releaseUrl + '/tag/' + encodeURIComponent(tag),
        canInstall: Boolean(this.updater) && (await this.hasUpdateManifest(tag))
      }
      this.set({ phase: 'available', release, percent: 0 })
      if (release.canInstall && this.settings.get().appBehavior.autoUpdate) void this.download()
      return this.state
    } catch (error) {
      logger.warn('updates', '检查 GitHub 发行版失败', { message: String(error) })
      const rateLimited = /403|rate limit|API rate/i.test(String(error))
      return this.set({
        phase: 'error',
        message: rateLimited
          ? 'GitHub 接口访问受限（匿名请求限流），可稍后重试，或直接到发行页下载。'
          : '无法连接 GitHub，请检查网络后重试。'
      })
    }
  }

  /**
   * 取最新版本号。
   * 优先跟随 github.com/…/releases/latest 的 302 定位到 tag——这是普通网页请求，
   * 不受 GitHub 匿名接口 60 次/小时 的限流；只有它失败时才退回 API。
   */
  private async resolveLatestTag(): Promise<string | null> {
    const redirected = await this.latestTagByRedirect().catch(() => null)
    if (redirected) return redirected
    return this.latestTagByApi().catch((error) => {
      throw error
    })
  }

  /** 跟随重定向拿 tag，不消耗接口配额 */
  private latestTagByRedirect(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const request = net.request({ url: latestPageUrl, redirect: 'manual' })
      const timer = setTimeout(() => {
        request.abort()
        reject(new Error('TIMEOUT'))
      }, TIMEOUT)
      const finish = (value: string | null): void => {
        clearTimeout(timer)
        resolve(value)
      }
      request.on('redirect', (_status, _method, url) => {
        request.abort()
        const matched = /\/tag\/([^/?#]+)$/.exec(url)
        finish(matched ? decodeURIComponent(matched[1]) : null)
      })
      request.on('response', () => {
        request.abort()
        finish(null)
      })
      request.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      request.end()
    })
  }

  /** 接口兜底：匿名调用可能被限流 */
  private async latestTagByApi(): Promise<string | null> {
    const response = await net.fetch(apiLatest, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MarkdownAiIDE-Updater' },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error('GitHub HTTP ' + response.status)
    const data = await response.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean }
    if (data.draft || data.prerelease || !data.tag_name) return null
    return data.tag_name
  }

  /** 发行说明属于锦上添花：拿不到就留空，不影响是否提示更新 */
  private async releaseMeta(tag: string): Promise<{ title: string; notes: string; publishedAt: string }> {
    try {
      const response = await net.fetch(apiTags + encodeURIComponent(tag), {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MarkdownAiIDE-Updater' },
        signal: AbortSignal.timeout(TIMEOUT)
      })
      if (!response.ok) return { title: '', notes: '', publishedAt: '' }
      const data = await response.json() as { name?: string; body?: string; published_at?: string }
      return {
        title: data.name?.slice(0, 160) ?? '',
        notes: data.body?.slice(0, 16000) ?? '',
        publishedAt: data.published_at ?? ''
      }
    } catch {
      return { title: '', notes: '', publishedAt: '' }
    }
  }

  /** 发行资产里是否带 latest.yml；HEAD 请求，同样不走接口 */
  private async hasUpdateManifest(tag: string): Promise<boolean> {
    try {
      const response = await net.fetch(releaseUrl + '/download/' + encodeURIComponent(tag) + '/latest.yml', {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000)
      })
      return response.ok
    } catch {
      return false
    }
  }

  download(): Promise<UpdateState> {
    if (this.state.phase === 'ready') return Promise.resolve(this.state)
    if (!this.downloading) this.downloading = this.downloadRelease().finally(() => { this.downloading = null })
    return this.downloading
  }

  private async downloadRelease(): Promise<UpdateState> {
    const { release } = this.state
    if (!this.updater || !release?.canInstall) return this.state
    this.set({ phase: 'downloading', percent: 0, message: '' })
    try {
      const result = await this.updater.checkForUpdates()
      if (!result?.isUpdateAvailable || result.updateInfo.version !== release.version) {
        throw new Error('发布版本与更新清单不匹配')
      }
      await this.updater.downloadUpdate()
      return this.set({ phase: 'ready', percent: 100 })
    } catch (error) {
      logger.warn('updates', '下载更新失败', { message: String(error) })
      return this.set({ phase: 'available', message: '下载失败，请重试或前往发行页下载。' })
    }
  }

  async install(prepare: () => Promise<void>, relaunch: boolean): Promise<void> {
    if (!this.updater || this.state.phase !== 'ready') return
    this.set({ phase: 'installing', message: '' })
    try {
      await prepare()
      this.updater.quitAndInstall(true, relaunch)
    } catch (error) {
      this.set({ phase: 'ready', message: '无法保存当前会话，安装已暂停。' })
      throw new AppError('SAVE_FAILED', '无法保存当前会话，安装已暂停。', { details: String(error) })
    }
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch }
    this.publish(this.state)
    return this.state
  }
}
