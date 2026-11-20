/**
 * IPC 契约：通道常量与 DesktopAPI 类型。
 * 渲染进程只能通过 preload 暴露的这些方法访问本地能力。
 */

import type {
  AddSourceInput,
  AppInfo,
  AppSettings,
  ApplyResult,
  Attachment,
  ClarificationAnswer,
  ConnectionResult,
  DiskConflictInfo,
  DocumentSnapshot,
  FileOperationResult,
  PandocConvertInput,
  PandocConvertResult,
  PandocStatus,
  PartialSettings,
  PredictionRequestInput,
  PredictionResult,
  ProviderConfig,
  ProviderInput,
  RecentEntry,
  RecoveryEntry,
  RestoreResult,
  ReviewData,
  SaveResult,
  SourceAsset,
  SourcePreviewChunk,
  StartTaskInput,
  StyleProfile,
  TaskEvent,
  TaskSnapshot,
  ThemeCompatibilityReport,
  DocThemeInfo,
  WorkspaceInfo,
  WorkspaceSearchHit,
  WorkspaceTree,
  ExportPdfInput,
  ExportPdfResult,
  ChangeSetRecord,
  ImagePreviewData,
  InsertedImage
} from './types'
import type { ErrorCode } from './errors'

/** 集中定义预加载层和主进程共同使用的 IPC 通道名。 */
export const IPC = {
  app: {
    info: 'app:info',
    openExternal: 'app:open-external',
    windowControl: 'app:window-control',
    openUserData: 'app:open-user-data',
    chooseDirectory: 'app:choose-directory',
    readClipboardText: 'app:read-clipboard-text',
    writeClipboardText: 'app:write-clipboard-text',
    resolveClose: 'app:resolve-close'
  },
  documents: {
    openDialog: 'documents:open-dialog',
    openPath: 'documents:open-path',
    openDropped: 'documents:open-dropped',
    newDocument: 'documents:new',
    snapshot: 'documents:snapshot',
    update: 'documents:update',
    save: 'documents:save',
    saveAs: 'documents:save-as',
    close: 'documents:close',
    listOpen: 'documents:list-open',
    recent: 'documents:recent',
    resolveConflict: 'documents:resolve-conflict',
    recoveryList: 'documents:recovery-list',
    recoveryRestore: 'documents:recovery-restore',
    recoveryDiscard: 'documents:recovery-discard',
    inlineImages: 'documents:inline-images',
    pickImage: 'documents:pick-image',
    saveImage: 'documents:save-image'
  },
  workspace: {
    current: 'workspace:current',
    openDialog: 'workspace:open-dialog',
    openPath: 'workspace:open-path',
    tree: 'workspace:tree',
    readFile: 'workspace:read-file',
    createFile: 'workspace:create-file',
    imagePreview: 'workspace:image-preview',
    createFolder: 'workspace:create-folder',
    rename: 'workspace:rename',
    remove: 'workspace:remove',
    search: 'workspace:search',
    reveal: 'workspace:reveal',
    recent: 'workspace:recent'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    reset: 'settings:reset'
  },
  providers: {
    list: 'providers:list',
    save: 'providers:save',
    remove: 'providers:remove',
    test: 'providers:test',
    setDefault: 'providers:set-default'
  },
  agent: {
    start: 'agent:start',
    cancel: 'agent:cancel',
    answer: 'agent:answer',
    snapshot: 'agent:snapshot'
  },
  changes: {
    review: 'changes:review',
    accept: 'changes:accept',
    reject: 'changes:reject',
    restore: 'changes:restore',
    list: 'changes:list'
  },
  attachments: {
    addFromDialog: 'attachments:add-dialog',
    addFromBytes: 'attachments:add-bytes',
    list: 'attachments:list',
    remove: 'attachments:remove',
    dataUrl: 'attachments:data-url'
  },
  references: {
    add: 'references:add',
    addFileDialog: 'references:add-file-dialog',
    addFromBytes: 'references:add-bytes',
    list: 'references:list',
    remove: 'references:remove',
    preview: 'references:preview',
    setRoles: 'references:set-roles'
  },
  styles: {
    list: 'styles:list',
    save: 'styles:save',
    remove: 'styles:remove'
  },
  prediction: {
    request: 'prediction:request',
    cancel: 'prediction:cancel'
  },
  themes: {
    list: 'themes:list',
    import: 'themes:import',
    activate: 'themes:activate',
    remove: 'themes:remove',
    css: 'themes:css'
  },
  exports: {
    saveHtml: 'export:save-html',
    saveMarkdown: 'export:save-markdown',
    saveMarkdownBundle: 'export:save-markdown-bundle',
    saveMarkdownInline: 'export:save-markdown-inline',
    savePdf: 'export:save-pdf',
    pandocStatus: 'export:pandoc-status',
    pandocConvert: 'export:pandoc-convert'
  },
  bridge: {
    request: 'bridge:editor-request',
    response: 'bridge:editor-response'
  },
  events: {
    agent: 'event:agent',
    workspaceChanged: 'event:workspace-changed',
    documentChanged: 'event:document-changed',
    documentConflict: 'event:document-conflict',
    settingsChanged: 'event:settings-changed',
    documentOpened: 'event:document-opened',
    closeRequested: 'event:close-requested',
    toast: 'event:toast'
  }
} as const

/* ------------------------------------------------------------------ */
/* 主进程 → 渲染进程的编辑器桥接                                        */
/* ------------------------------------------------------------------ */

/** 表示一次基于同一编辑前文本坐标的区间替换。 */
export interface EditorEdit {
  /** 区间起点，使用 JavaScript 字符串的 UTF-16 码元偏移。 */
  from: number
  /** 区间终点（不含），使用 UTF-16 码元偏移。 */
  to: number
  /** 替换该区间的文本；空串表示删除区间。 */
  insert: string
}

/** 区分主进程发给编辑器的同步、应用与定位请求。 */
export type EditorRequest =
  | { requestId: string; type: 'sync'; documentId: string }
  | {
      requestId: string
      type: 'apply'
      documentId: string
      expectedRevision: number
      undoGroupId: string
      edits: EditorEdit[]
      reveal?: { from: number; to: number }
    }
  | { requestId: string; type: 'reveal'; documentId: string; from: number; to: number }

/** 按请求 ID 回传编辑器处理结果、版本信息或错误。 */
export interface EditorResponse {
  /** 用于关联发起请求与响应或后续取消的标识。 */
  requestId: string
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 当前记录承载的文本内容。 */
  text?: string
  /** 当前文稿的修订号；用于识别基于旧内容的请求。 */
  revision?: number
  /** 当前 LF 正文的哈希，用来断言内容是否仍与规划基线一致。 */
  contentHash?: string
  /** 失败时供调用方分支处理和展示的结构化错误。 */
  error?: { code: ErrorCode; message: string }
}

/* ------------------------------------------------------------------ */
/* 事件载荷                                                            */
/* ------------------------------------------------------------------ */

/** 描述广播给渲染端的任务、工作区、文稿、设置及提示事件。 */
export type AppEvent =
  | { type: 'agent'; event: TaskEvent }
  | {
      type: 'workspace-changed'
      workspaceId: string
      reason: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'reset'
    }
  | {
      type: 'document-changed'
      snapshot: DocumentSnapshot
      origin: 'renderer' | 'external' | 'agent' | 'reload' | 'save'
    }
  | { type: 'document-conflict'; conflict: DiskConflictInfo }
  | { type: 'settings-changed'; settings: AppSettings }
  | { type: 'toast'; message: string; tone: 'info' | 'success' | 'warning' | 'error' }

/* ------------------------------------------------------------------ */
/* 桌面 API                                                            */
/* ------------------------------------------------------------------ */

/** 为新建文稿提供可选工作区、目标路径、标题和初始正文。 */
export interface NewDocumentInput {
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId?: string | null
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath?: string | null
  /** 供标签、列表或审阅界面显示的标题。 */
  title?: string
  /** 新文稿的可选初始正文，未提供时使用空文本。 */
  content?: string
}

/** 描述在工作区新建文件时使用的相对路径、初始内容及打开选项。 */
export interface CreateFileInput {
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string
  /** 工作区文件的可选初始内容。 */
  content?: string
  /** 创建后是否以标签页打开 */
  open?: boolean
}

/** 报告已创建的文件路径以及按需打开后生成的文稿快照。 */
export interface CreateFileResult {
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string
  /** 创建后打开所得的文稿快照；不打开时为 null。 */
  document: DocumentSnapshot | null
}

/** 将打开的工作区及其初始文件树作为一次调用结果返回。 */
export interface WorkspaceTreeResult {
  /** 与返回的文件树对应的工作区信息。 */
  workspace: WorkspaceInfo
  /** 扫描当前工作区并返回供文件侧栏展示的目录树。 */
  tree: WorkspaceTree
}

/** 描述新建或更新风格配置所需的输入；版本和时间由服务维护。 */
export interface StyleProfileInput extends Omit<StyleProfile, 'profileId' | 'version' | 'updatedAt'> {
  /** 用于定位已保存写作风格配置的标识。 */
  profileId?: string
}

/** 返回导入主题的注册信息和 CSS 兼容性报告。 */
export interface ImportThemeResult {
  /** 导入并登记的主题配置。 */
  theme: DocThemeInfo
  /** 本次导入的规则覆盖与资源兼容结果。 */
  report: ThemeCompatibilityReport
}

/** 定义预加载层暴露给渲染进程的类型化桌面能力与事件订阅接口。 */
export interface DesktopAPI {
  /** 窗口生命周期、运行环境、系统选择器与剪贴板能力。 */
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>
    openUserData(): Promise<void>
    chooseDirectory(title: string): Promise<string | null>
    readClipboardText(): Promise<string>
    /** 写入纯文本剪贴板；用于锁定阅读态的复制菜单，避免受页面焦点限制 */
    writeClipboardText(text: string): Promise<void>
    /** 取拖入文件的本地绝对路径；Electron 已移除 File.path，改由 webUtils 解析 */
    pathForFile(file: unknown): string
    /** 关闭窗口时用户的选择：最小化到托盘或退出；remember 为 true 时写入设置 */
    resolveClose(action: 'tray' | 'quit', remember: boolean): Promise<void>
  }
  /** 文稿打开、编辑同步、保存、冲突和草稿恢复能力。 */
  documents: {
    openDialog(): Promise<DocumentSnapshot[]>
    openPath(path: string): Promise<DocumentSnapshot>
    /** 打开用户从桌面拖入的文稿；不受工作区白名单限制，其余校验与 openPath 相同 */
    openDropped(path: string): Promise<DocumentSnapshot>
    newDocument(input?: NewDocumentInput): Promise<DocumentSnapshot>
    snapshot(documentId: string): Promise<DocumentSnapshot>
    update(documentId: string, text: string, baseRevision: number): Promise<DocumentSnapshot>
    save(documentId: string, expectedRevision: number): Promise<SaveResult>
    saveAs(documentId: string): Promise<SaveResult | null>
    close(documentId: string): Promise<void>
    listOpen(): Promise<DocumentSnapshot[]>
    recent(): Promise<RecentEntry[]>
    resolveConflict(
      documentId: string,
      choice: 'reload' | 'overwrite' | 'saveAs'
    ): Promise<SaveResult | DocumentSnapshot | null>
    recoveryList(): Promise<RecoveryEntry[]>
    recoveryRestore(documentId: string): Promise<DocumentSnapshot>
    recoveryDiscard(documentId: string): Promise<void>
    /** 导出前把本地图片内联为 data URL */
    inlineImages(documentId: string, urls: string[]): Promise<Record<string, string>>
    /** 选择本地图片，复制到文稿同级资源目录并返回相对路径 */
    pickImage(documentId: string): Promise<InsertedImage | null>
    /** 把粘贴/拖入的图片写入文稿同级资源目录 */
    saveImage(
      documentId: string | null,
      name: string,
      mime: string,
      bytes: ArrayBuffer
    ): Promise<InsertedImage>
  }
  /** 工作区文件树、搜索、定位与文件操作能力。 */
  workspace: {
    current(): Promise<WorkspaceInfo | null>
    openDialog(): Promise<WorkspaceInfo | null>
    openPath(path: string): Promise<WorkspaceInfo>
    tree(): Promise<WorkspaceTreeResult | null>
    readFile(relativePath: string): Promise<string>
    createFile(input: CreateFileInput): Promise<CreateFileResult>
    imagePreview(relativePath: string): Promise<ImagePreviewData>
    createFolder(relativePath: string): Promise<void>
    rename(from: string, to: string): Promise<FileOperationResult>
    remove(relativePath: string): Promise<FileOperationResult>
    search(query: string, limit?: number): Promise<WorkspaceSearchHit[]>
    reveal(relativePath: string): Promise<void>
    recent(): Promise<RecentEntry[]>
  }
  /** 应用设置读取、修改和重置能力。 */
  settings: {
    get(): Promise<AppSettings>
    update(patch: PartialSettings): Promise<AppSettings>
    reset(): Promise<AppSettings>
  }
  /** 模型配置、默认选择和连接测试能力。 */
  providers: {
    list(): Promise<ProviderConfig[]>
    save(input: ProviderInput): Promise<ProviderConfig>
    remove(providerId: string): Promise<void>
    test(providerId: string): Promise<ConnectionResult>
    setDefault(providerId: string): Promise<ProviderConfig[]>
  }
  /** 显式 Agent 任务的启动、响应、取消与状态恢复能力。 */
  agent: {
    start(input: StartTaskInput): Promise<{ taskId: string }>
    cancel(taskId: string): Promise<void>
    answer(answer: ClarificationAnswer): Promise<void>
    snapshot(taskId: string): Promise<TaskSnapshot | null>
  }
  /** 变更提案审阅、应用、拒绝和事务恢复能力。 */
  changes: {
    review(changeSetId: string): Promise<ReviewData>
    accept(changeSetId: string, proposalDigest: string): Promise<ApplyResult>
    reject(changeSetId: string): Promise<void>
    restore(transactionId: string): Promise<RestoreResult>
    list(): Promise<ChangeSetRecord[]>
  }
  /** 任务附件导入、列表和删除能力。 */
  attachments: {
    addFromDialog(): Promise<Attachment[]>
    addFromBytes(name: string, mime: string, bytes: ArrayBuffer): Promise<Attachment>
    list(): Promise<Attachment[]>
    remove(attachmentId: string): Promise<void>
    dataUrl(attachmentId: string): Promise<string | null>
  }
  /** 材料导入、预览及用途维护能力。 */
  references: {
    add(input: AddSourceInput): Promise<SourceAsset>
    addFileDialog(): Promise<SourceAsset[]>
    /** 拖入或粘贴的文件：由主进程落到参考目录后再解析 */
    addFromBytes(name: string, bytes: ArrayBuffer): Promise<SourceAsset>
    list(): Promise<SourceAsset[]>
    remove(sourceId: string): Promise<void>
    preview(sourceId: string): Promise<SourcePreviewChunk[]>
    setRoles(sourceId: string, roles: AddSourceInput['roles']): Promise<SourceAsset>
  }
  /** 写作风格配置维护能力。 */
  styles: {
    list(): Promise<StyleProfile[]>
    save(input: StyleProfileInput): Promise<StyleProfile>
    remove(profileId: string): Promise<void>
  }
  /** 独立的光标续写请求及取消能力。 */
  prediction: {
    request(input: PredictionRequestInput): Promise<PredictionResult | null>
    cancel(requestId: string): Promise<void>
  }
  /** 文稿主题导入、选择及样式读取能力。 */
  themes: {
    list(): Promise<DocThemeInfo[]>
    import(): Promise<ImportThemeResult | null>
    activate(themeId: string): Promise<DocThemeInfo[]>
    remove(themeId: string): Promise<DocThemeInfo[]>
    css(themeId: string): Promise<string>
  }
  /** 本地文稿导出、打印和格式转换能力。 */
  exports: {
    saveHtml(
      html: string,
      suggestedName: string
    ): Promise<{ ok: boolean; path: string | null; message: string }>
    saveMarkdown(
      text: string,
      suggestedName: string
    ): Promise<{ ok: boolean; path: string | null; message: string }>
    /** 导出为 .zip：内含 Markdown 与相对路径的 assets 图片 */
    saveMarkdownBundle(
      documentId: string,
      text: string,
      suggestedName: string
    ): Promise<{ ok: boolean; path: string | null; message: string }>
    /** 导出单文件 Markdown：本地图片内联为 Base64 */
    saveMarkdownInline(
      documentId: string,
      text: string,
      suggestedName: string
    ): Promise<{ ok: boolean; path: string | null; message: string }>
    savePdf(input: ExportPdfInput): Promise<ExportPdfResult>
    pandocStatus(): Promise<PandocStatus>
    pandocConvert(input: PandocConvertInput): Promise<PandocConvertResult>
  }
  /** 响应主进程发来的编辑器同步、应用和定位请求。 */
  bridge: {
    onRequest(handler: (request: EditorRequest) => Promise<EditorResponse> | EditorResponse): () => void
    respond(response: EditorResponse): void
  }
  /** 订阅主进程广播，返回用于释放相应监听器的回调。 */
  on: {
    agentEvent(listener: (event: TaskEvent) => void): () => void
    workspaceChanged(listener: (event: Extract<AppEvent, { type: 'workspace-changed' }>) => void): () => void
    documentChanged(listener: (event: Extract<AppEvent, { type: 'document-changed' }>) => void): () => void
    documentConflict(listener: (event: Extract<AppEvent, { type: 'document-conflict' }>) => void): () => void
    settingsChanged(listener: (settings: AppSettings) => void): () => void
    documentOpened(listener: (snapshot: DocumentSnapshot) => void): () => void
    closeRequested(listener: () => void): () => void
    toast(listener: (event: Extract<AppEvent, { type: 'toast' }>) => void): () => void
  }
}

declare global {
  /** 声明 Electron 预加载层为页面注入的桌面能力。 */
  interface Window {
    /** 仅包含应用预加载层白名单所公开的方法和订阅。 */
    api: DesktopAPI
  }
}
