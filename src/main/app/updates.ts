import { app, net } from 'electron'
import { dirname } from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { AppError } from '@shared/errors'
import { initialUpdateState, newerVersion, stableVersion, type UpdateRelease, type UpdateState } from '@shared/update'
import type { SettingsStore } from '../settings/store'
import { logger } from '../utils/logger'

const owner = 'WangLang1216'
const repo = 'MarkdownAiIDE'
const releaseUrl = 'https://github.com/' + owner + '/' + repo + '/releases'
const endpoint = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/latest'

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
      const response = await net.fetch(endpoint, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MarkdownAiIDE-Updater' },
        signal: AbortSignal.timeout(15000)
      })
      if (response.status === 404) return this.set({ phase: 'current', release: null, message: '暂未找到公开发行版。' })
      if (!response.ok) throw new Error('GitHub HTTP ' + response.status)
      const data = await response.json() as {
        tag_name?: string; name?: string; body?: string; published_at?: string
        draft?: boolean; prerelease?: boolean; assets?: Array<{ name?: string }>
      }
      if (data.draft || data.prerelease || !data.tag_name || !newerVersion(data.tag_name, app.getVersion())) {
        return this.set({ phase: 'current', release: null, message: '当前已是最新版本。' })
      }
      const version = stableVersion(data.tag_name)!
      const release: UpdateRelease = {
        version,
        title: data.name?.slice(0, 160) || '版本 ' + version,
        notes: data.body?.slice(0, 16000) || '',
        publishedAt: data.published_at ?? '',
        url: releaseUrl + '/tag/' + encodeURIComponent(data.tag_name),
        canInstall: Boolean(this.updater && data.assets?.some((asset) => asset.name === 'latest.yml'))
      }
      this.set({ phase: 'available', release, percent: 0 })
      if (release.canInstall && this.settings.get().appBehavior.autoUpdate) void this.download()
      return this.state
    } catch (error) {
      logger.warn('updates', '检查 GitHub 发行版失败', { message: String(error) })
      return this.set({ phase: 'error', message: '无法检查更新，请检查网络后重试。' })
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
