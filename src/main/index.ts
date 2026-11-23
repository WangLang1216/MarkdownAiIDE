/**
 * 主进程入口：服务装配、窗口与工作区引导、事件广播。
 * 长任务不阻塞事件循环；所有子服务共享同一个 userData 目录与授权模型。
 */

import { stat } from 'node:fs/promises'
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { appIconPath } from './app/icon'
import { UpdateService } from './app/updates'
import { appPaths, configureCacheDir, ensureAppDirectories } from './utils/paths'
import { logger } from './utils/logger'
import { SettingsStore } from './settings/store'
import { SecretService } from './secrets/service'
import { ProviderService } from './providers/service'
import { WorkspaceService } from './workspace/service'
import { EditorBridge } from './bridge'
import { DocumentService } from './documents/service'
import { ChangeService } from './changes/service'
import { AttachmentService } from './attachments/service'
import { ReferenceService } from './references/service'
import { StyleService } from './styles/service'
import { PredictionService } from './prediction/service'
import { ThemeService } from './themes/service'
import { ExportService } from './exports/service'
import { AgentTools } from './agent/tools'
import { AgentController } from './agent/controller'
import { MediaService, registerMediaScheme } from './media'
import { applyContentSecurityPolicy, createMainWindow, lockDownPermissions } from './app/window'
import { isolateDevUserData } from './app/devProfile'
import { createNotifier, registerIpc, type IpcContext } from './ipc'
import { demoDefaultDocument, ensureDemoWorkspace } from './app/demo'
import { runVisualHarness } from './dev/harness'
import { pathExists } from './utils/fs'

function createUnreadDot(): Electron.NativeImage {
  const size = 16
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 8.5, y - 6.5)
      if (distance > 5.5) continue
      const offset = (y * size + x) * 4
      bitmap[offset] = 47
      bitmap[offset + 1] = 46
      bitmap[offset + 2] = 223
      bitmap[offset + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

registerMediaScheme()
if (process.platform === 'win32') app.setAppUserModelId('cn.moye.markdownide')
app.setName('墨页')
/** 开发/预览进程改用独立数据目录，避免与已安装版本争用单实例锁与磁盘缓存 */
const devUserData = isolateDevUserData()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 常见于已安装版本常驻托盘时又启动开发进程：旧实例持有同一 userData 的锁与缓存目录
  console.error(
    devUserData
      ? `[启动] 另一个「小彭友」实例正占用开发数据目录 ${devUserData}，本次启动已退出。`
      : '[启动] 已有一个「小彭友」实例在运行（可能在系统托盘），本次启动已退出。请先从托盘退出旧实例。'
  )
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 关闭询问与“退出”路径需要绕开 close 拦截 */
const closeState = { allow: false }

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  const iconPath = appIconPath()
  if (!iconPath) {
    logger.warn('tray', '未找到托盘图标，跳过托盘创建')
    return
  }
  const image = nativeImage.createFromPath(iconPath)
  tray = new Tray(image.isEmpty() ? iconPath : image.resize({ width: 18, height: 18 }))
  tray.setToolTip('小彭友 · Markdown AI IDE')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '打开本地数据目录', click: () => void shell.openPath(appPaths().userData) },
      { type: 'separator' },
      {
        label: '退出小彭友',
        click: () => {
          closeState.allow = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible()) mainWindow.focus()
    else showMainWindow()
  })
  logger.info('tray', '系统托盘已创建')
}

function hideToTray(): void {
  if (!mainWindow) return
  mainWindow.hide()
  if (process.platform === 'win32' && tray) {
    tray.displayBalloon({
      iconType: 'info',
      title: '小彭友仍在运行',
      content: '窗口已最小化到托盘，点击托盘图标可以重新打开。'
    })
  }
}

async function bootstrap(): Promise<void> {
  ensureAppDirectories()
  applyContentSecurityPolicy()
  lockDownPermissions()

  const settings = new SettingsStore()
  const secrets = new SecretService()
  await settings.load()
  configureCacheDir(settings.get().storage.cacheDir)
  await secrets.load()

  const providers = new ProviderService(secrets)
  await providers.load()
  await seedProviderFromEnv(providers)

  const workspace = new WorkspaceService()
  const bridge = new EditorBridge()
  const documents = new DocumentService(workspace, bridge, settings)
  const attachments = new AttachmentService()
  await attachments.load()
  const references = new ReferenceService(documents, workspace, attachments)
  await references.load()
  const changes = new ChangeService(workspace, documents, bridge, references)
  await changes.load()
  const styles = new StyleService()
  await styles.load()
  const prediction = new PredictionService(providers, documents, references, styles, settings)
  const themes = new ThemeService(settings)
  await themes.load()
  const media = new MediaService(documents, workspace)
  const exports = new ExportService(documents, media, settings)
  media.registerProtocols(() => appPaths().themesDir)

  const tools = new AgentTools({ documents, workspace, changes, references })
  const agent = new AgentController({
    providers,
    documents,
    workspace,
    changes,
    references,
    attachments,
    media,
    settings,
    tools
  })

  await bootstrapWorkspace(settings, workspace, documents)

  mainWindow = createMainWindow()
  bridge.attach(mainWindow)
  createTray()

  /** 记录当前打开的文稿，供下次启动恢复 */
  const persistOpenFiles = async (): Promise<void> => {
    const paths = documents
      .listOpen()
      .filter((item) => item.attached)
      .map((item) => documents.getAbsPath(item.documentId))
      .filter((path): path is string => Boolean(path))
    await settings.setOpenFiles(paths)
  }

  mainWindow.on('close', (event) => {
    if (closeState.allow) return
    const action = settings.get().appBehavior.closeAction
    logger.info('window', '关闭窗口', { action })
    if (action === 'quit') {
      // 先落盘打开列表，再真正退出
      event.preventDefault()
      closeState.allow = true
      void persistOpenFiles().finally(() => app.quit())
      return
    }
    event.preventDefault()
    if (action === 'tray') {
      void persistOpenFiles()
      hideToTray()
      return
    }
    mainWindow?.webContents.send(IPC.events.closeRequested)
  })

  ;(globalThis as { __moyeDocuments?: DocumentService }).__moyeDocuments = documents
  const updates = new UpdateService(settings, (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.events.updateChanged, state)
  })
  const prepareUpdate = async (): Promise<void> => {
    await documents.preserveUpdateSession(app.getVersion())
    await persistOpenFiles()
  }
  const onQuitForUpdate = (event: Electron.Event): void => {
    if (!updates.readyForAutomaticInstall || !mainWindow || mainWindow.isDestroyed()) return
    event.preventDefault()
    void updates.install(prepareUpdate, false).catch((error) => {
      closeState.allow = false
      mainWindow?.webContents.send(IPC.events.toast, { tone: 'error', message: (error as Error).message })
    })
  }
  app.on('before-quit', onQuitForUpdate)
  const initialUpdateCheck = setTimeout(() => void updates.check(), 8000)
  const periodicUpdateCheck = setInterval(() => void updates.check(), 6 * 60 * 60 * 1000)
  mainWindow.once('closed', () => {
    clearTimeout(initialUpdateCheck)
    clearInterval(periodicUpdateCheck)
    app.removeListener('before-quit', onQuitForUpdate)
  })

  const context: IpcContext = {
    window: mainWindow,
    settings,
    updates,
    installUpdate: () => updates.install(prepareUpdate, true),
    secrets,
    providers,
    workspace,
    documents,
    bridge,
    changes,
    agent,
    attachments,
    references,
    styles,
    prediction,
    themes,
    exports,
    media,
    lifecycle: {
      async resolveClose(action, remember) {
        logger.info('lifecycle', '用户选择关闭方式', { action, remember })
        if (remember) {
          const next = await settings.update({ appBehavior: { closeAction: action } })
          mainWindow?.webContents.send(IPC.events.settingsChanged, next)
        }
        await persistOpenFiles()
        if (action === 'tray') {
          hideToTray()
          return
        }
        closeState.allow = true
        app.quit()
      },
      persistOpenFiles
    }
  }
  registerIpc(context)
  const notifier = createNotifier(context)

  const unreadDot = createUnreadDot()
  const notifiedTasks = new Set<string>()
  agent.setSink((event) => {
    notifier.agent(event)
    const window = mainWindow
    if (!window || window.isDestroyed() || (window.isFocused() && window.isVisible())) return
    if (event.type !== 'completed' && event.type !== 'applied' && event.type !== 'proposal_ready' &&
        event.type !== 'failed') return
    if (process.platform === 'win32') window.setOverlayIcon(unreadDot, '有新的 AI 任务结果')
    else if (process.platform === 'darwin') app.dock?.setBadge('●')
    else window.flashFrame(true)
    if (Notification.isSupported() && !notifiedTasks.has(event.taskId)) {
      notifiedTasks.add(event.taskId)
      if (notifiedTasks.size > 100) {
        const oldest = notifiedTasks.values().next().value
        if (oldest) notifiedTasks.delete(oldest)
      }
      const task = agent.snapshot(event.taskId)?.task
      const failed = event.type === 'failed' ||
        (event.type === 'applied' && (event.status === 'failed' || event.status === 'conflict'))
      const notification = new Notification({
        title: failed ? 'AI 任务失败' : event.type === 'proposal_ready' ? 'AI 建议待审阅' : 'AI 任务已完成',
        body: task?.documentTitle ?? '写作助手',
        icon: appIconPath() ?? undefined
      })
      notification.on('click', showMainWindow)
      notification.show()
    }
  })
  documents.onChanged((snapshot, origin) => {
    if (snapshot.existsOnDisk) agent.linkDraftHistory(snapshot.documentId)
    notifier.document({ snapshot, origin })
  })
  documents.onConflict((conflict) => notifier.conflict(conflict))
  workspace.onWorkspaceChange((event) => {
    notifier.workspace(event)
    void documents.handleWorkspaceEvent(event.reason, event.relativePath)
  })

  mainWindow.on('focus', () => {
    if (process.platform === 'win32') mainWindow?.setOverlayIcon(null, '')
    else if (process.platform === 'darwin') app.dock?.setBadge('')
    else mainWindow?.flashFrame(false)
    for (const snapshot of documents.listOpen()) {
      if (snapshot.existsOnDisk) void documents.checkExternal(snapshot.documentId)
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (mainWindow) void runVisualHarness(mainWindow)
  })

  // 系统“用小彭友打开”或命令行传入的文档
  const launchFile = await resolveLaunchFile(process.argv)
  if (launchFile) await openLaunchFile(launchFile, documents)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  void changes.cleanup()
  void attachments.cleanup()
  logger.info('app', '应用启动完成', {
    electron: process.versions.electron,
    platform: process.platform,
    userData: appPaths().userData
  })
}

/**
 * 开发期从环境变量注入模型配置，便于无界面自动化测试真实 Provider。
 * 只在显式设置环境变量时生效，密钥不写入仓库。
 */
async function seedProviderFromEnv(providers: ProviderService): Promise<void> {
  const raw = process.env.MDIDE_SEED_PROVIDER
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as {
      providerId?: string
      name: string
      kind: 'openai' | 'ollama' | 'custom' | 'mock'
      baseUrl: string
      model: string
      capabilities?: Record<string, boolean>
    }
    const saved = await providers.save({
      ...parsed,
      ...(process.env.MDIDE_SEED_PROVIDER_KEY ? { apiKey: process.env.MDIDE_SEED_PROVIDER_KEY } : {})
    })
    await providers.setDefault(saved.providerId)
    logger.info('provider', '已注入测试配置', { providerId: saved.providerId, model: saved.model })
  } catch (error) {
    logger.warn('provider', '注入测试配置失败', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

/** 从命令行参数中提取待打开的 Markdown 文件 */
async function resolveLaunchFile(argv: string[]): Promise<string | null> {
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-') || arg === '.') continue
    if (!/\.(md|markdown|txt)$/i.test(arg)) continue
    const info = await stat(arg).catch(() => null)
    if (info?.isFile()) return arg
  }
  return null
}

async function openLaunchFile(path: string, documents: DocumentService): Promise<void> {
  try {
    const snapshot = await documents.openPath(path, true)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('event:document-opened', snapshot)
    }
  } catch (error) {
    logger.warn('app', '打开命令行文档失败', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

/** 首次启动准备示例工作区；有最近工作区时优先恢复 */
async function bootstrapWorkspace(
  settings: SettingsStore,
  workspace: WorkspaceService,
  documents: DocumentService
): Promise<void> {
  let opened = false
  for (const path of settings.get().recentWorkspaces) {
    if (!(await pathExists(path))) continue
    try {
      await workspace.open(path)
      opened = true
      break
    } catch {
      continue
    }
  }
  if (!opened) {
    const demo = appPaths().demoWorkspace
    await ensureDemoWorkspace(demo)
    await workspace.open(demo)
    await settings.rememberWorkspace(demo)
  }

  let restored = await documents.restoreUpdateSession(app.getVersion())
  if (!restored && settings.get().appBehavior.restoreSession) {
    for (const path of settings.get().openFiles) {
      if (!(await pathExists(path))) continue
      if (!/\.(md|markdown|mdx|txt)$/i.test(path)) continue
      try {
        await documents.openPath(path, true)
        restored += 1
      } catch (error) {
        logger.warn('app', '恢复上次文稿失败', {
          path,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  if (restored === 0) {
    // 记录过上次文稿但都不可用时，回到示例默认文稿；从未记录过则沿用最近文件
    const saved = settings.get().openFiles
    const preferDefault = saved.length > 0 && settings.get().appBehavior.restoreSession
    const candidates = preferDefault
      ? [demoDefaultDocument(appPaths().demoWorkspace)]
      : [
          ...settings.get().recentFiles.map((entry) => entry.path),
          demoDefaultDocument(appPaths().demoWorkspace)
        ]
    for (const candidate of candidates) {
      if (!(await pathExists(candidate))) continue
      if (!candidate.toLowerCase().endsWith('.md') && !candidate.toLowerCase().endsWith('.txt')) continue
      try {
        await documents.openPath(candidate, true)
        break
      } catch (error) {
        logger.warn('app', '恢复上次文档失败', {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  // 首次启动或回退到默认文稿时，也把当前结果记为“上次打开”
  const paths = documents
    .listOpen()
    .filter((item) => item.attached)
    .map((item) => documents.getAbsPath(item.documentId))
    .filter((path): path is string => Boolean(path))
  if (paths.length) await settings.setOpenFiles(paths)
}

/** 开发期截图钩子，用于自动化视觉检查；生产环境不会触发 */
if (gotLock) {
  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      logger.error('app', '启动失败', {
        message: error instanceof Error ? error.message : String(error)
      })
      app.quit()
    })
}

app.on('second-instance', (_event, argv) => {
  if (!mainWindow) return
  showMainWindow()
  void resolveLaunchFile(argv).then((file) => {
    if (!file) return
    const documentsService = (globalThis as { __moyeDocuments?: DocumentService }).__moyeDocuments
    if (documentsService) void openLaunchFile(file, documentsService)
  })
})

app.on('open-file', (event, path) => {
  event.preventDefault()
  const documentsService = (globalThis as { __moyeDocuments?: DocumentService }).__moyeDocuments
  if (documentsService) void openLaunchFile(path, documentsService)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  // macOS 点击 Dock 图标时恢复窗口
  showMainWindow()
})

app.on('before-quit', () => {
  closeState.allow = true
  logger.info('app', '应用退出')
})

process.on('unhandledRejection', (reason) => {
  logger.error('process', '未处理的 Promise 拒绝', {
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

process.on('uncaughtException', (error) => {
  logger.error('process', '未捕获异常', { message: error.message })
})
