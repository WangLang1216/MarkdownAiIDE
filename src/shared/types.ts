/**
 * 主进程与渲染进程共享的领域类型。
 * 约定：所有文本偏移均为零基 UTF-16 code unit，范围结束位置不包含在内。
 */

import type { ErrorCode } from './errors'

/* ------------------------------------------------------------------ */
/* 文档模型                                                            */
/* ------------------------------------------------------------------ */

/** 标识内存文本归一化之前检测到的磁盘换行风格。 */
export type EolStyle = 'lf' | 'crlf' | 'mixed'

/** 记录文稿正文、修订及磁盘基线，供跨进程同步和界面渲染。 */
export interface DocumentSnapshot {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId: string | null
  /** 工作区相对路径；新建且未落盘的文档为 null */
  relativePath: string | null
  /** 绝对路径仅用于主进程内部，不向渲染进程暴露 */
  title: string
  /** 当前文稿的修订号；用于识别基于旧内容的请求。 */
  revision: number
  /** 供编辑器及变更规划使用的 LF 归一化 Markdown 正文。 */
  text: string
  /** 当前 LF 正文的哈希，用来断言内容是否仍与规划基线一致。 */
  contentHash: string
  /** 指示当前正文是否有尚未保存的变更。 */
  dirty: boolean
  /** 最近接受的磁盘原始字节指纹；与 LF 正文哈希不同。 */
  diskFingerprint: string | null
  /** 保存时用于恢复磁盘换行风格的标志。 */
  eol: EolStyle
  /** 标记原始文本是否带 UTF-8 BOM，以便保存时保留。 */
  hasBom: boolean
  /** 指示会话是否对应一个已存在于磁盘的文件。 */
  existsOnDisk: boolean
  /** 是否在界面标签页中打开；false 表示 Agent 为读写而创建的会话 */
  attached: boolean
}

/** 区分保存成功、外部冲突和失败，并返回当前文稿快照。 */
export interface SaveResult {
  /** 当前记录的处理状态。 */
  status: 'saved' | 'conflict' | 'failed'
  /** 保存处理完成时的最新文稿会话快照。 */
  snapshot: DocumentSnapshot
  /** 供界面显示的结果或错误说明。 */
  message?: string
}

/** 描述内存文稿与外部磁盘内容的冲突，供界面提示和选择处理方式。 */
export interface DiskConflictInfo {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 检测到的外部磁盘字节指纹。 */
  diskHash: string
  /** 出现冲突时内存 LF 正文的哈希。 */
  sessionHash: string
  /** 供界面显示的结果或错误说明。 */
  message: string
}

/** 记录最近打开文件的路径、标题和打开时间。 */
export interface RecentEntry {
  /** 最近打开的文稿绝对路径。 */
  path: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 打开时间的 Unix 毫秒时间戳。 */
  openedAt: number
}

/** 描述恢复中心可列出的未保存草稿元数据。 */
export interface RecoveryEntry {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string | null
  /** 写入恢复草稿的 Unix 毫秒时间戳。 */
  savedAt: number
  /** 关联内容占用的大小，单位为字节。 */
  size: number
}

/* ------------------------------------------------------------------ */
/* 工作区与文件树                                                      */
/* ------------------------------------------------------------------ */

/** 标识当前工作区及其本地根目录。 */
export interface WorkspaceInfo {
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId: string
  /** 当前工作区根目录的绝对路径。 */
  rootPath: string
  /** 用于界面或列表显示的名称。 */
  name: string
}

/** 区分工作区树中的文件与目录。 */
export type FileNodeKind = 'file' | 'directory'

/** 表示工作区树节点及可选的文件属性或子节点。 */
export interface FileNode {
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string
  /** 用于分派该记录的类别标记。 */
  kind: FileNodeKind
  /** 文件扩展名（小写，不含点） */
  ext?: string
  /** 关联内容占用的大小，单位为字节。 */
  size?: number
  /** 最近一次更新的 Unix 毫秒时间戳。 */
  updatedAt?: number
  /** 目录节点下的子节点列表。 */
  children?: FileNode[]
  /** 目录直接子项数量（原型展示用） */
  childCount?: number
}

/** 表示某个工作区在一次扫描时生成的文件树快照。 */
export interface WorkspaceTree {
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId: string
  /** 文件树根节点，包含供侧栏展开的工作区条目。 */
  root: FileNode
  /** 文件树扫描结果的生成时间戳。 */
  generatedAt: number
}

/** 表示工作区文本搜索结果及其行定位信息。 */
export interface WorkspaceSearchHit {
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 命中正文所在的行号，用于展示定位线索。 */
  line: number
  /** 命中行上下文（截断） */
  excerpt: string
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId?: string
}

/** 报告文件操作是否成功、目标路径及是否移入回收站。 */
export interface FileOperationResult {
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 供界面显示的结果或错误说明。 */
  message?: string
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath?: string
  /** 标记删除通过系统回收站完成。 */
  trashed?: boolean
}

/* ------------------------------------------------------------------ */
/* 章节与大纲                                                          */
/* ------------------------------------------------------------------ */

/** 把 Markdown 章节的层级身份映射到标题及正文所在的源码区间。 */
export interface SectionRef {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId?: string
  /** 当前文稿的修订号；用于识别基于旧内容的请求。 */
  revision?: number
  /** 快照内稳定，重新解析或重新打开后可能变化 */
  sectionId: string
  /** Markdown 标题的层级，通常为 1 至 6。 */
  level: number
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 从祖先标题到当前标题的层级路径。 */
  headingPath: string[]
  /** 在当前上级章节内按标题层级计算的从 1 开始的序号。 */
  ordinalAtLevel: number
  /** 标题在 Markdown 源码中的 UTF-16 起点。 */
  headingStart: number
  /** 标题结束处的源码偏移，供标题后插入定位。 */
  headingEnd: number
  /** 章节结束处的源码偏移，供章节读取和插入定位。 */
  sectionEnd: number
}

/** 供大纲渲染和跳转使用的标题节点，包含层级及源码位置。 */
export interface OutlineNode {
  /** 用于定位章节和匹配大纲节点的标识。 */
  sectionId: string
  /** Markdown 标题的层级，通常为 1 至 6。 */
  level: number
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 从祖先标题到当前标题的层级路径。 */
  headingPath: string[]
  /** 在当前上级章节内按标题层级计算的从 1 开始的序号。 */
  ordinalAtLevel: number
  /** 区间起点，使用 JavaScript 字符串的 UTF-16 码元偏移。 */
  from: number
  /** 区间终点（不含），使用 UTF-16 码元偏移。 */
  to: number
}

/** 表示用于状态栏的字词、字符、段落与阅读时间估算。 */
export interface TextStats {
  /** 按文本统计规则得到的字词数。 */
  words: number
  /** 状态栏展示的正文字符数。 */
  characters: number
  /** 统计规则匹配的汉字和假名字符数。 */
  cjkCharacters: number
  /** 跳过标题、围栏和管道表格起始块后得到的段落估算。 */
  paragraphs: number
  /** 按正文规模估算的阅读用时，单位为分钟。 */
  readingMinutes: number
}

/* ------------------------------------------------------------------ */
/* 变更协议                                                            */
/* ------------------------------------------------------------------ */

/** 将文稿变更绑定到规划时看到的修订和正文哈希。 */
export interface VersionGuard {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 执行前必须匹配的基础文稿修订号。 */
  baseRevision: number
  /** 规划时预期的 LF 正文哈希；不同则不能沿用本次操作。 */
  expectedContentHash: string
}

/** 描述插入点相对于章节标题、章节末尾或文末的位置。 */
export interface TargetAnchor {
  /** 为空表示整篇文档范围（配合 position=document_end） */
  sectionId: string | null
  /** 指定在标题之后、章节末尾或整个文稿末尾插入。 */
  position: 'after_heading' | 'section_end' | 'document_end'
}

/** 区分已识别、待核对和空白的表格单元格。 */
export type CellStatus = 'recognized' | 'uncertain' | 'empty'

/** 保存单元格文本及识别状态，供审阅和 Markdown 序列化。 */
export interface TableCell {
  /** 保存应写入 Markdown 的单元格内容。 */
  text: string
  /** 当前记录的处理状态。 */
  status: CellStatus
}

/** 表示带声明行列数、独立表头和数据行的结构化表格。 */
export interface TablePayload {
  /** 声明的表格列数；表头和各数据行以此校验。 */
  columnCount: number
  /** 总行数含表头，不含 Markdown 分隔行 */
  totalRows: number
  /** 表格第一行的有序表头单元格。 */
  header: TableCell[]
  /** 表头以外、按原顺序排列的数据行。 */
  rows: TableCell[][]
}

/** 按 kind 区分 Agent 可提出的文稿插入、替换、新建与删除操作。 */
export type ChangeOperation =
  | {
      kind: 'insert_table'
      operationId: string
      guard: VersionGuard
      anchor: TargetAnchor
      table: TablePayload
      /** 表格前的引导说明，可空 */
      caption?: string
    }
  | {
      kind: 'insert_markdown'
      operationId: string
      guard: VersionGuard
      anchor: TargetAnchor
      markdown: string
    }
  | {
      kind: 'replace_range'
      operationId: string
      guard: VersionGuard
      from: number
      to: number
      expectedOldText: string
      newText: string
    }
  | {
      kind: 'create_document'
      operationId: string
      workspaceId: string
      relativePath: string
      content: string
      ifExists: 'fail'
    }
  | {
      kind: 'delete_document'
      operationId: string
      guard: VersionGuard
      recovery: 'trash_or_recovery'
    }

/** 从变更联合类型派生的操作类别，用于结果及审阅归类。 */
export type OperationKind = ChangeOperation['kind']

/** 描述单项变更或整份提案的校验问题及严重程度。 */
export interface ProposalIssue {
  /** 用于追踪单条变更及其校验或执行结果的标识。 */
  operationId: string | null
  /** 用于调用端分支处理的稳定错误码。 */
  code: ErrorCode
  /** 供界面显示的结果或错误说明。 */
  message: string
  /** 区分影响应用的错误与需留意的警告。 */
  severity: 'error' | 'warning'
}

/** 表示与任务及上下文摘要关联的待校验变更提案。 */
export interface ProposalInput {
  /** 用于关联任务状态、工具调用及事件的任务标识。 */
  taskId: string
  /** 面向用户展示的简短操作说明。 */
  summary: string
  /** 按提案携带的顺序记录待规划的变更操作。 */
  operations: ChangeOperation[]
  /** 本次操作选用的附件标识列表。 */
  attachmentIds: string[]
  /** 标识使用的来源集合及其上下文版本的摘要。 */
  sourceSetDigest?: string
  /** 标识本次任务采用的风格配置版本的摘要。 */
  styleDigest?: string
}

/** 表示提案从待审阅到应用、拒绝、过期或失败的状态。 */
export type ChangeSetStatus = 'pending' | 'applied' | 'partially_applied' | 'rejected' | 'expired' | 'failed'

/** 提供提案影响的工作区、文稿或路径的摘要。 */
export interface ChangeSetTarget {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 所属工作区的标识；无工作区时用 null 表示。 */
  workspaceId: string | null
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string | null
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 用于分派该记录的类别标记。 */
  kind: OperationKind
}

/** 保存可审阅提案、摘要、校验结果和生命周期状态。 */
export interface ChangeSetRecord {
  /** 用于关联审阅、应用及事务的提案标识。 */
  changeSetId: string
  /** 用于关联任务状态、工具调用及事件的任务标识。 */
  taskId: string
  /** 面向用户展示的简短操作说明。 */
  summary: string
  /** 按提案携带的顺序记录待规划的变更操作。 */
  operations: ChangeOperation[]
  /** 将审阅结果与待执行的提案内容绑定的摘要。 */
  proposalDigest: string
  /** 由变更服务用于区分审阅风险的等级。 */
  risk: 'low' | 'high'
  /** 供审阅界面定位受影响文件的目标列表。 */
  targets: ChangeSetTarget[]
  /** 本次操作关联的参考材料标识列表。 */
  sourceIds: string[]
  /** 标识使用的来源集合及其上下文版本的摘要。 */
  sourceSetDigest: string | null
  /** 标识本次任务采用的风格配置版本的摘要。 */
  styleDigest: string | null
  /** 当前记录的处理状态。 */
  status: ChangeSetStatus
  /** 规划或校验得到的错误与警告列表。 */
  issues: ProposalIssue[]
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
}

/** 表示一行审阅差异及其在前后版本中的行号。 */
export interface DiffLine {
  /** 标识该行是上下文、新增还是删除。 */
  type: 'context' | 'add' | 'del'
  /** 当前记录承载的文本内容。 */
  text: string
  /** 差异行在原正文中的行号；新增行没有旧行号。 */
  oldNo: number | null
  /** 差异行在结果正文中的行号；删除行没有新行号。 */
  newNo: number | null
}

/** 聚合一个受影响文件的差异、计数、预览及校验问题。 */
export interface ReviewFile {
  /** 审阅列表中标识该文件分组的键。 */
  key: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string | null
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 用于分派该记录的类别标记。 */
  kind: OperationKind
  /** 面向用户展示的简短操作说明。 */
  summary: string
  /** 此文件审阅中的新增行数。 */
  additions: number
  /** 此文件审阅中的删除行数。 */
  deletions: number
  /** 为审阅展示计算的逐行差异。 */
  diff: DiffLine[]
  /** 表格预览（insert_table 专用） */
  tablePreview?: { header: TableCell[]; rows: TableCell[][] }
  /** 适用于当前操作时提供的候选 Markdown 预览。 */
  markdownPreview?: string
  /** 规划或校验得到的错误与警告列表。 */
  issues: ProposalIssue[]
}

/** 携带审阅弹窗所需的提案、按文件分组的差异和自动应用资格。 */
export interface ReviewData {
  /** 本次审阅所对应的提案及其摘要。 */
  changeSet: ChangeSetRecord
  /** 按受影响文件分组的审阅结果。 */
  files: ReviewFile[]
  /** 是否可在当前文档上低风险自动应用 */
  autoApplicable: boolean
}

/** 报告事务内单个操作的执行状态、定位信息及后续修订。 */
export interface OperationResult {
  /** 用于追踪单条变更及其校验或执行结果的标识。 */
  operationId: string
  /** 用于分派该记录的类别标记。 */
  kind: OperationKind
  /** 当前记录的处理状态。 */
  status: 'applied' | 'skipped' | 'failed'
  /** 供界面显示的结果或错误说明。 */
  message: string
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string | null
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 当前文稿的修订号；用于识别基于旧内容的请求。 */
  revision?: number
}

/** 报告提案应用的整体结果、事务 ID 及逐操作结果。 */
export interface ApplyResult {
  /** 当前记录的处理状态。 */
  status: 'applied' | 'partially_applied' | 'conflict' | 'failed'
  /** 用于查找应用账本及执行恢复的事务标识。 */
  transactionId: string | null
  /** 事务中各操作的结果明细。 */
  results: OperationResult[]
  /** 供界面显示的结果或错误说明。 */
  message: string
}

/** 报告事务恢复的整体结果和逐项恢复状态。 */
export interface RestoreResult {
  /** 当前记录的处理状态。 */
  status: 'restored' | 'partially_restored' | 'conflict' | 'failed'
  /** 事务中各操作的结果明细。 */
  results: OperationResult[]
  /** 供界面显示的结果或错误说明。 */
  message: string
}

/** 持久化变更执行步骤和前后基线，供部分失败诊断及比较恢复。 */
export interface TransactionRecord {
  /** 用于查找应用账本及执行恢复的事务标识。 */
  transactionId: string
  /** 用于关联审阅、应用及事务的提案标识。 */
  changeSetId: string
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
  /** 当前记录的处理状态。 */
  status: 'prepared' | 'applying' | 'committed' | 'partially_applied' | 'recovery_needed' | 'restored'
  /** 记录每个操作的执行状态、前后哈希与可选备份。 */
  steps: Array<{
    operationId: string
    kind: OperationKind
    relativePath: string | null
    documentId: string | null
    beforeHash: string | null
    afterHash: string | null
    /** 修改/删除前的恢复副本路径 */
    backupPath: string | null
    status: 'pending' | 'applied' | 'failed' | 'skipped' | 'restored'
    message?: string
  }>
}

/* ------------------------------------------------------------------ */
/* Agent 任务                                                          */
/* ------------------------------------------------------------------ */

/** 描述任务运行期间展示给用户的细粒度阶段。 */
export type AgentPhase =
  | 'preparing'
  | 'reading'
  | 'thinking'
  | 'generating'
  | 'waiting_input'
  | 'reviewing'
  | 'applying'
  | 'applied'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 表示 Agent 任务的整体状态，独立于界面阶段标签。 */
export type TaskStatus =
  'running' | 'waiting_input' | 'reviewing' | 'applied' | 'completed' | 'failed' | 'cancelled'

/** 将用户答复关联到具体任务及澄清请求。 */
export interface ClarificationAnswer {
  /** 用于关联任务状态、工具调用及事件的任务标识。 */
  taskId: string
  /** 将界面答复交给匹配的等待中任务。 */
  answer: string
  /** 用户从预设选项中选择时提交的选项值。 */
  selectedOption?: string
}

/** 表示任务暂停等待用户确认的信息及可选答案。 */
export interface ClarificationRequest {
  /** 等待用户补充信息的提示文字。 */
  question: string
  /** 可供用户直接选择的候选答复。 */
  options: string[]
  /** 控制界面是否允许自定义澄清答复。 */
  allowFreeText: boolean
}

/** 记录任务结果摘要及关联的提案或事务标识。 */
export interface TaskSummary {
  /** 用于关联任务状态、工具调用及事件的任务标识。 */
  taskId: string
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 任务关联的文稿或工作区展示标题。 */
  documentTitle: string
  /** 在任务列表中展示的提示词摘要。 */
  prompt: string
  /** 当前记录的处理状态。 */
  status: TaskStatus
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
}

/** 按事件类别描述任务状态、文本增量、工具执行与最终结果。 */
export type TaskEventPayload =
  | { type: 'started'; task: TaskSummary }
  | { type: 'phase'; phase: AgentPhase; label: string }
  | { type: 'text_delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool_started'; callId: string; name: string; title: string; argsSummary: string }
  | { type: 'tool_finished'; callId: string; name: string; ok: boolean; summary: string }
  | ({ type: 'clarification' } & ClarificationRequest)
  | { type: 'proposal_ready'; changeSetId: string; summary: string; fileCount: number; risk: 'low' | 'high' }
  | { type: 'applied'; transactionId: string | null; summary: string; status: ApplyResult['status'] }
  | { type: 'failed'; code: ErrorCode; message: string; retryable: boolean }
  | { type: 'cancelled' }
  | { type: 'completed'; text: string }

/** 为任务事件附加任务标识、递增序号和发生时间。 */
export type TaskEvent = TaskEventPayload & { taskId: string; sequence: number; timestamp: number }

/** 聚合任务当前可展示的状态、正文、工具记录与错误。 */
export interface TaskSnapshot {
  /** 任务身份、标题与整体状态的摘要。 */
  task: TaskSummary
  /** 控制器当前执行阶段，用于状态展示。 */
  phase: AgentPhase
  /** 当前记录承载的文本内容。 */
  text: string
  /** 当前任务已记录的工具调用进度及结果。 */
  toolLog: Array<{
    callId: string
    name: string
    title: string
    status: 'running' | 'done' | 'failed'
    summary: string
  }>
  /** 任务需向用户确认时提供的澄清请求。 */
  clarification: ClarificationRequest | null
  /** 与当前工具或任务结果关联的可审阅提案标识。 */
  proposalId: string | null
  /** 失败时供调用方分支处理和展示的结构化错误。 */
  error: { code: ErrorCode; message: string; retryable: boolean } | null
}

/** 声明新任务的提示、编辑范围、模式及所选模型和参考材料。 */
export interface StartTaskInput {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string | null
  /** 用户发给任务的指令文本。 */
  prompt: string
  /** 作用范围，默认当前文档 */
  scope: 'selection' | 'document' | 'workspace'
  /** 用于限定上下文或操作目标的当前源码选区。 */
  selection?: { from: number; to: number }
  /** 用于选择模型连接配置的标识。 */
  providerId?: string
  /** 本次操作选用的附件标识列表。 */
  attachmentIds: string[]
  /** 本次操作关联的参考材料标识列表。 */
  sourceIds: string[]
  /** 区分生成编辑提案的编辑模式和问答模式。 */
  mode: 'edit' | 'ask'
  /** 用于选择任务或续写所需的写作风格预设。 */
  styleProfileId?: string
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

/** 区分模型接入配置的类型，包括离线演示适配器。 */
export type ProviderKind = 'openai' | 'ollama' | 'custom' | 'mock'

/** 声明调用方可使用的文本、视觉、工具、结构化及流式能力。 */
export interface ModelCapabilities {
  /** 当前记录承载的文本内容。 */
  text: boolean
  /** 指示模型是否可接收图片输入。 */
  vision: boolean
  /** 指示是否可让模型请求执行声明过的工具。 */
  toolCalling: boolean
  /** 记录模型的结构化输出能力声明。 */
  structuredOutput: boolean
  /** 记录模型的流式输出能力声明。 */
  streaming: boolean
}

/** 保存模型连接配置及是否有密钥的标志，不包含明文密钥。 */
export interface ProviderConfig {
  /** 用于选择模型连接配置的标识。 */
  providerId: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 用于分派该记录的类别标记。 */
  kind: ProviderKind
  /** 模型服务配置的请求根地址。 */
  baseUrl: string
  /** 在接入服务中标识要调用的模型。 */
  model: string
  /** 控制调用方启用视觉、工具等模型特性的能力声明。 */
  capabilities: ModelCapabilities
  /** 仅标记已配置凭据，不暴露凭据本身。 */
  hasSecret: boolean
  /** 标记未显式选择模型时采用的配置。 */
  isDefault: boolean
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
  /** 最近一次更新的 Unix 毫秒时间戳。 */
  updatedAt: number
  /** 提供给模型用于控制生成随机性的采样参数。 */
  temperature?: number
  /** 限制单轮由模型生成的输出令牌数。 */
  maxOutputTokens?: number
}

/** 描述管理界面提交的模型配置，可附带待安全存放的密钥。 */
export interface ProviderInput {
  /** 用于选择模型连接配置的标识。 */
  providerId?: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 用于分派该记录的类别标记。 */
  kind: ProviderKind
  /** 模型服务配置的请求根地址。 */
  baseUrl: string
  /** 在接入服务中标识要调用的模型。 */
  model: string
  /** 调用模型接口的凭据；不用于可公开的配置输出。 */
  apiKey?: string
  /** 控制调用方启用视觉、工具等模型特性的能力声明。 */
  capabilities?: Partial<ModelCapabilities>
  /** 提供给模型用于控制生成随机性的采样参数。 */
  temperature?: number
  /** 限制单轮由模型生成的输出令牌数。 */
  maxOutputTokens?: number
}

/** 返回连接检查结果、耗时及最终用于界面展示的能力信息。 */
export interface ConnectionResult {
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 连接检查测得的耗时，单位为毫秒。 */
  latencyMs: number
  /** 供界面显示的结果或错误说明。 */
  message: string
  /** 控制调用方启用视觉、工具等模型特性的能力声明。 */
  capabilities: ModelCapabilities
  /** 连接探测可返回的模型标识列表。 */
  models?: string[]
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

/** 定义应用配色的浅色、深色和跟随系统三种模式。 */
export type ThemeMode = 'light' | 'dark' | 'system'
/** 定义文稿可选的无衬线、衬线与等宽字体分类。 */
export type DocFontFamily = 'sans' | 'serif' | 'mono'

/** 定义可持久化的应用设置结构及最近使用状态。 */
export interface AppSettings {
  /** 用于识别所存设置结构的版本号。 */
  schemaVersion: number
  /** 应用外壳配色设置。 */
  appearance: { themeMode: ThemeMode }
  /** 文稿字体、字号、行高、正文宽度和主题设置。 */
  typography: {
    fontFamily: DocFontFamily
    fontSize: number
    lineHeight: number
    maxWidth: number
    docThemeId: string
  }
  /** 编辑交互、自动保存和图片加载设置。 */
  editor: {
    /** 控制是否在编辑缓冲区更新后调度自动保存。 */
    autosave: boolean
    /** 从编辑后等待自动保存的延迟，单位为毫秒。 */
    autosaveDelayMs: number
    /** 决定编辑时是否启用打字机滚动。 */
    typewriter: boolean
    showLineNumbers: boolean
    /** 控制该渲染场景是否加载远程图片。 */
    loadRemoteImages: boolean
    /** 决定编辑输入是否启用拼写检查。 */
    spellcheck: boolean
  }
  /** 显式任务的轮次、采样及自动应用偏好。 */
  agent: {
    /** 允许符合服务端低风险条件的当前文稿提案自动应用。 */
    autoApplyCurrentDocument: boolean
    /** 限制一次显式 Agent 任务的轮次数。 */
    maxRounds: number
    /** 提供给模型用于控制生成随机性的采样参数。 */
    temperature: number
  }
  /** 续写预测的启用、调度、频控和生成长度设置。 */
  prediction: {
    enabled: boolean
    auto: boolean
    /** 自动预测等候用户停止输入的时间，单位为毫秒。 */
    debounceMs: number
    /** 配置单位分钟内允许的预测请求数。 */
    maxPerMinute: number
    /** 限制续写模型生成的输出令牌数。 */
    maxTokens: number
  }
  /** 导出的主题、来源和 PDF 打印默认值。 */
  export: {
    /** 决定导出时是否加入选定文稿主题。 */
    includeTheme: boolean
    includeSources: boolean
    /** PDF 打印使用的纸张尺寸。 */
    pageSize: 'A4' | 'Letter'
    /** 用于打印版式的页边距，单位为毫米。 */
    marginMm: number
  }
  /** 资源目录与缓存写入位置的设置。 */
  storage: {
    /** 文稿同级资源目录名，默认 assets；只允许相对目录名 */
    assetsFolder: string
    /** 缓存目录绝对路径；留空表示使用应用数据目录下的 cache */
    cacheDir: string
  }
  /** 窗口关闭和会话恢复设置。 */
  appBehavior: {
    /** 关闭窗口时的行为：每次询问 / 最小化到托盘 / 直接退出 */
    closeAction: CloseAction
    /** 启动时恢复上次退出时打开的文稿 */
    restoreSession: boolean
  }
  /** 上次退出时仍打开的文稿绝对路径，用于下次启动恢复 */
  openFiles: string[]
  /** 供最近文件入口读取的文稿历史记录。 */
  recentFiles: RecentEntry[]
  /** 用于工作区恢复和切换的根目录历史记录。 */
  recentWorkspaces: string[]
}

/** 定义关闭主窗口时的询问、托盘和退出行为。 */
export type CloseAction = 'ask' | 'tray' | 'quit'

/** 描述设置更新时允许按分组提交的局部补丁。 */
export type PartialSettings = {
  /** 仅提交需要更新的应用外壳配色设置字段。 */
  appearance?: Partial<AppSettings['appearance']>
  /** 仅提交需要更新的文稿字体、字号、行高、正文宽度和主题设置字段。 */
  typography?: Partial<AppSettings['typography']>
  /** 仅提交需要更新的编辑交互、自动保存和图片加载设置字段。 */
  editor?: Partial<AppSettings['editor']>
  /** 仅提交需要更新的显式任务的轮次、采样及自动应用偏好字段。 */
  agent?: Partial<AppSettings['agent']>
  /** 仅提交需要更新的续写预测的启用、调度、频控和生成长度设置字段。 */
  prediction?: Partial<AppSettings['prediction']>
  /** 仅提交需要更新的导出的主题、来源和 PDF 打印默认值字段。 */
  export?: Partial<AppSettings['export']>
  /** 仅提交需要更新的资源目录与缓存写入位置的设置字段。 */
  storage?: Partial<AppSettings['storage']>
  /** 仅提交需要更新的窗口关闭和会话恢复设置字段。 */
  appBehavior?: Partial<AppSettings['appBehavior']>
}

/* ------------------------------------------------------------------ */
/* 附件、参考材料、风格                                                */
/* ------------------------------------------------------------------ */

/** 记录任务可引用的本地附件元数据；临时预览与正文资产分开管理。 */
export interface Attachment {
  /** 关联附件缓存记录的标识。 */
  attachmentId: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 资源数据对应的媒体类型。 */
  mime: string
  /** 关联内容占用的大小，单位为字节。 */
  size: number
  /** 识别到的图片宽度，单位为像素。 */
  width?: number
  /** 识别到的图片高度，单位为像素。 */
  height?: number
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
  /** 仅渲染进程展示用的 data URL，主进程不持久化 */
  previewUrl?: string
  /** 用于关联任务状态、工具调用及事件的任务标识。 */
  taskId?: string
}

/** 插入到文稿的本地图片（已复制到资源目录） */
export interface InsertedImage {
  /** 相对于文稿所在目录的 POSIX 路径，例如 assets/xxx.png */
  relativePath: string
  /** 写入 Markdown 图片语法的替代文字。 */
  alt: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 关联内容占用的大小，单位为字节。 */
  size: number
}

/** 图片预览：统一返回 data URL，避免渲染进程直接读盘 */
export interface ImagePreviewData {
  /** 读取附件并编码为可传给界面或模型的 data URL。 */
  dataUrl: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 资源数据对应的媒体类型。 */
  mime: string
  /** 关联内容占用的大小，单位为字节。 */
  size: number
}

/** 说明材料用于支撑事实或数据，还是仅用于写作或视觉风格参考。 */
export type ReferenceRole = 'facts' | 'data' | 'writing_style' | 'visual_style'

/** 标识参考材料解析后所属的来源类型。 */
export type SourceKind = 'document' | 'file' | 'web' | 'image' | 'pdf' | 'docx'

/** 表示参考材料从排队解析到可用、受限、失败或移除的状态。 */
export type SourceStatus = 'queued' | 'parsing' | 'ready' | 'partial' | 'failed' | 'removed'

/** 按来源类型记录证据位置，例如文稿区间、页码或网页片段。 */
export type SourceLocator =
  | {
      kind: 'document'
      documentId: string | null
      relativePath: string | null
      revision: number | null
      headingPath: string[]
      fromUtf16: number
      toUtf16: number
    }
  | { kind: 'pdf'; page: number; bbox: { x: number; y: number; w: number; h: number } | null }
  | { kind: 'docx'; paragraphId: string; tableId: string | null }
  | { kind: 'web'; finalUrl: string; fragmentId: string }
  | { kind: 'image'; attachmentId: string; region: { x: number; y: number; w: number; h: number } | null }

/** 表示可放入模型上下文或被证据引用的来源片段。 */
export interface SourceChunk {
  /** 用于索引参考材料及其证据片段的标识。 */
  sourceId: string
  /** 用于将片段、证据和可用来源匹配到同一版本。 */
  sourceVersion: number
  /** 材料内供预览和证据定位使用的片段标识。 */
  chunkId: string
  /** 当前记录承载的文本内容。 */
  text: string
  /** 指向原始参考材料中该片段的位置。 */
  locator: SourceLocator
  /** 标记该片段仍需人工核对。 */
  uncertain: boolean
}

/** 保存一份参考材料的身份、角色、解析状态和来源元数据。 */
export interface SourceAsset {
  /** 用于索引参考材料及其证据片段的标识。 */
  sourceId: string
  /** 用于将片段、证据和可用来源匹配到同一版本。 */
  sourceVersion: number
  /** 用于分派该记录的类别标记。 */
  kind: SourceKind
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 指定材料可支撑事实、数据或仅用作风格参考。 */
  roles: ReferenceRole[]
  /** 当前 LF 正文的哈希，用来断言内容是否仍与规划基线一致。 */
  contentHash: string | null
  /** 记录网页材料被读取的时间。 */
  fetchedAt: string | null
  /** 用户最初提供的网页 URL。 */
  requestedUrl: string | null
  /** 完成跳转后实际读取的网页 URL。 */
  finalUrl: string | null
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string | null
  /** 关联附件缓存记录的标识。 */
  attachmentId: string | null
  /** 当前记录的处理状态。 */
  status: SourceStatus
  /** 供界面显示的结果或错误说明。 */
  message: string | null
  /** 当前来源已记录的片段数量。 */
  chunkCount: number
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
}

/** 为界面展示来源片段提供文本、定位标签及不确定标记。 */
export interface SourcePreviewChunk {
  /** 材料内供预览和证据定位使用的片段标识。 */
  chunkId: string
  /** 当前记录承载的文本内容。 */
  text: string
  /** 界面显示的片段位置或来源标签。 */
  label: string
  /** 标记该片段仍需人工核对。 */
  uncertain: boolean
}

/** 指定要加入的材料、各来源类型对应的标识和参考用途。 */
export interface AddSourceInput {
  /** 用于分派该记录的类别标记。 */
  kind: 'file' | 'web' | 'image' | 'document'
  /** 文件类参考材料使用的本地路径。 */
  path?: string
  /** 网页类参考材料使用的 URL。 */
  url?: string
  /** 关联附件缓存记录的标识。 */
  attachmentId?: string
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId?: string
  /** 指定材料可支撑事实、数据或仅用作风格参考。 */
  roles: ReferenceRole[]
  /** 供标签、列表或审阅界面显示的标题。 */
  title?: string
}

/** 把生成内容的证据关系关联到指定版本的来源片段。 */
export interface EvidenceRef {
  /** 用于索引参考材料及其证据片段的标识。 */
  sourceId: string
  /** 用于将片段、证据和可用来源匹配到同一版本。 */
  sourceVersion: number
  /** 材料内供预览和证据定位使用的片段标识。 */
  chunkId: string
  /** 区分证据支撑、直接引用和仅作风格参考的关系。 */
  relation: 'supports' | 'direct_quote' | 'style_only'
  /** 需要随证据保留的摘录；没有摘录时为 null。 */
  quote: string | null
}

/** 保存可纳入模型提示的受众、语气、结构与术语偏好。 */
export interface StyleProfile {
  /** 用于定位已保存写作风格配置的标识。 */
  profileId: string
  /** 随预设更新维护的版本号，用于标识风格上下文。 */
  version: number
  /** 记录预设的任务、文稿或工作区适用范围。 */
  scope: 'task' | 'document' | 'workspace'
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 用户期望的文字语气。 */
  tone: string | null
  /** 文稿面向的目标读者。 */
  audience: string | null
  /** 用户期望生成内容使用的语言。 */
  language: string | null
  /** 需要遵循的术语及对应写法。 */
  terminology: Record<string, string>
  /** 作为风格样例的来源标识。 */
  sampleSourceIds: string[]
  /** 提示模型可优先采用的文稿结构描述。 */
  preferredStructures: string[]
  /** 最近一次更新的 Unix 毫秒时间戳。 */
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* 预测                                                                */
/* ------------------------------------------------------------------ */

/** 绑定候选与文稿区间、正文修订及其模型和参考上下文版本。 */
export interface PredictionContextKey {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 当前文稿的修订号；用于识别基于旧内容的请求。 */
  revision: number
  /** 候选关联区间的 UTF-16 起点。 */
  fromUtf16: number
  /** 候选关联区间的 UTF-16 末端（不含）。 */
  toUtf16: number
  /** 标识使用的来源集合及其上下文版本的摘要。 */
  sourceSetDigest: string
  /** 标识本次任务采用的风格配置版本的摘要。 */
  styleDigest: string
  /** 纳入候选上下文键的模型配置版本。 */
  providerConfigVersion: number
}

/** 描述光标续写请求所依据的修订、光标和参考配置。 */
export interface PredictionRequestInput {
  /** 文稿会话标识；用于关联标签、编辑请求或历史记录。 */
  documentId: string
  /** 不填时使用默认 Provider */
  providerId?: string
  /** 当前文稿的修订号；用于识别基于旧内容的请求。 */
  revision: number
  /** 光标在 LF 正文中的 UTF-16 偏移。 */
  offset: number
  /** 用于限定上下文或操作目标的当前源码选区。 */
  selection?: { from: number; to: number }
  /** 本次操作关联的参考材料标识列表。 */
  sourceIds: string[]
  /** 用于选择任务或续写所需的写作风格预设。 */
  styleProfileId?: string
  /** manual 由用户显式触发；auto 由停顿调度触发 */
  trigger: 'manual' | 'auto'
}

/** 返回候选内容、上下文键、缓存标志和证据列表。 */
export interface PredictionResult {
  /** 用于关联发起请求与响应或后续取消的标识。 */
  requestId: string
  /** 当前记录承载的文本内容。 */
  text: string
  /** 用于核对候选是否仍适用的文稿和上下文标识。 */
  contextKey: PredictionContextKey
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
  /** 命中本地缓存 */
  cached: boolean
  /** 候选附带的证据引用记录。 */
  evidence: EvidenceRef[]
}

/* ------------------------------------------------------------------ */
/* 主题与导出                                                          */
/* ------------------------------------------------------------------ */

/** 记录导入 CSS 的覆盖项、资源处理结果与不兼容提示。 */
export interface ThemeCompatibilityReport {
  /** 处理后用于兼容报告的 CSS 规则数。 */
  ruleCount: number
  /** A 级：正文、标题、列表、表格、引用、代码、图片、任务列表 */
  aLevelCovered: string[]
  /** B 级：公式、图表、目录、脚注 */
  bLevelCovered: string[]
  /** 未覆盖的 A 级文稿元素列表。 */
  missingALevel: string[]
  /** 主题处理时拦截的远程资源数。 */
  remoteAssetsBlocked: number
  /** 主题处理时成功导入的本地资源数。 */
  importedAssets: number
  /** 流程已收集的非阻断问题说明。 */
  warnings: string[]
}

/** 保存内置或导入主题的展示信息及隔离作用域。 */
export interface DocThemeInfo {
  /** 用于查询和切换文稿主题的标识。 */
  themeId: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 用于分派该记录的类别标记。 */
  kind: 'builtin' | 'imported'
  /** 内置主题对应的文稿字体族；导入主题不使用该字段。 */
  builtinFont: DocFontFamily | null
  /** 将导入样式限定在文稿容器内的作用域标识。 */
  cssScopeId: string | null
  /** 导入主题的兼容报告；内置主题可不提供。 */
  report: ThemeCompatibilityReport | null
  /** 记录创建时间的 Unix 毫秒时间戳。 */
  createdAt: number
}

/** 报告 Pandoc 的可用性、检测到的版本和可执行文件信息。 */
export interface PandocStatus {
  /** 是否检测到可执行的 Pandoc。 */
  available: boolean
  /** 检测到的 Pandoc 版本描述。 */
  version: string | null
  /** 检测到的 Pandoc 命令或可执行文件位置。 */
  path: string | null
  /** 供界面显示的结果或错误说明。 */
  message: string
}

/** 描述 Pandoc 转换方向、格式、输入和可选参考文档。 */
export interface PandocConvertInput {
  /** 区分从外部格式导入和从 Markdown 导出。 */
  direction: 'import' | 'export'
  /** Pandoc 转换的外部文档格式。 */
  format: 'docx' | 'odt' | 'epub' | 'html' | 'latex'
  /** 导入时的源文件绝对路径；导出时为临时 Markdown 内容 */
  sourcePath?: string
  /** 导出转换所用的 Markdown 正文。 */
  markdown?: string
  /** 在系统保存对话框中提供的默认文件名。 */
  suggestedName?: string
  /** 导出时可选的参考文档路径，用于支持该选项的格式。 */
  referenceDocPath?: string
}

/** 描述 Pandoc 转换结果、输出位置或导入后的 Markdown。 */
export interface PandocConvertResult {
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 导出产物路径；未生成输出文件时为 null。 */
  outputPath: string | null
  /** 导入时为生成的 Markdown 内容 */
  markdown?: string
  /** 流程已收集的非阻断问题说明。 */
  warnings: string[]
  /** 供界面显示的结果或错误说明。 */
  message: string
}

/** 为 PDF 导出指定 HTML、文件建议名和打印版式。 */
export interface ExportPdfInput {
  /** 用于在打印窗口加载的完整文稿 HTML。 */
  html: string
  /** 在系统保存对话框中提供的默认文件名。 */
  suggestedName: string
  /** PDF 打印使用的纸张尺寸。 */
  pageSize: 'A4' | 'Letter'
  /** 用于打印版式的页边距，单位为毫米。 */
  marginMm: number
  /** 指示 PDF 是否使用横向页面。 */
  landscape?: boolean
}

/** 报告 PDF 导出结果及已保存路径。 */
export interface ExportPdfResult {
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 成功保存后的 PDF 位置。 */
  path: string | null
  /** 供界面显示的结果或错误说明。 */
  message: string
}

/** 为关于及运行环境界面汇总应用、运行时、工作区和本地能力信息。 */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: NodeJS.Platform
  userDataPath: string
  workspace: WorkspaceInfo | null
  safeStorage: { available: boolean; backend: string }
  pandoc: PandocStatus
  demoWorkspacePath: string | null
  /** 桌面应用图标的 data URL，用于“关于”弹窗；读取失败时为 null */
  iconDataUrl: string | null
}

/** 封装 IPC 成功数据或结构化错误，供预加载层解包。 */
export interface ApiResult<T> {
  /** 指示请求或操作是否成功。 */
  ok: boolean
  /** 调用成功时由主进程返回的业务数据。 */
  data?: T
  /** 失败时供调用方分支处理和展示的结构化错误。 */
  error?: { code: ErrorCode; message: string; retryable: boolean; details?: string }
}
