/**
 * 变更执行服务：提案冻结、审阅差异、授权校验、事务执行与比较恢复。
 * 多文件操作不声称文件系统级原子性，而是持久化步骤账本并支持补偿恢复。
 */

import { copyFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { buildDiff } from '@shared/diff'
import type {
  ApplyResult,
  ChangeOperation,
  ChangeSetRecord,
  ChangeSetTarget,
  OperationResult,
  ProposalIssue,
  RestoreResult,
  ReviewData,
  ReviewFile,
  TransactionRecord
} from '@shared/types'
import { AppError, messageOf } from '@shared/errors'
import { ProposalSchema, formatIssues } from '@shared/schemas'
import { renderTable } from '@shared/markdown/table'
import { appPaths } from '../utils/paths'
import { atomicWriteFile, newId, pathExists, sha256, toDiskText } from '../utils/fs'
import { logger } from '../utils/logger'
import type { WorkspaceService } from '../workspace/service'
import type { ReferenceService } from '../references/service'
import type { DocumentService } from '../documents/service'
import type { EditorBridge } from '../bridge'
import { assessRisk, isLargeEdit, planOperation, type DocumentContext } from './engine'
import { applyEditsToText, type TextEdit } from '@shared/markdown/edits'

const MAX_DIFF_LINES = 600
type Step = TransactionRecord['steps'][number]

interface DocGroup {
  key: string
  documentId: string | null
  relativePath: string | null
  title: string
  before: string
  edits: TextEdit[]
  kinds: Set<ChangeOperation['kind']>
  issues: ProposalIssue[]
  tablePreview?: {
    header: Array<{ text: string; status: 'recognized' | 'uncertain' | 'empty' }>
    rows: Array<Array<{ text: string; status: 'recognized' | 'uncertain' | 'empty' }>>
  }
  markdownPreview?: string
}

interface TextBatch {
  session: ReturnType<DocumentService['getSession']>
  operations: ChangeOperation[]
  edits: TextEdit[]
  afterText: string
}

const isTextOperation = (operation: ChangeOperation): boolean =>
  operation.kind === 'insert_table' ||
  operation.kind === 'insert_markdown' ||
  operation.kind === 'replace_range'

/** 负责提案校验、差异预览、授权应用、事务落账与比较恢复。 */
export class ChangeService {
  private changeSets = new Map<string, ChangeSetRecord>()
  private transactions = new Map<string, TransactionRecord>()

  /** 注入文稿、工作区和编辑器桥等变更执行依赖。 */
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly documents: DocumentService,
    private readonly bridge: EditorBridge,
    private readonly references: ReferenceService
  ) {}

  /** 加载本地提案与事务账本以恢复可审阅记录。 */
  async load(): Promise<void> {
    const dir = appPaths().changesDir
    const files = await readdir(dir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await readFile(join(dir, file), 'utf8').catch(() => null)
      if (!raw) continue
      try {
        if (file.endsWith('.txn.json')) {
          const record = JSON.parse(raw) as TransactionRecord
          this.transactions.set(record.transactionId, record)
        } else {
          const record = JSON.parse(raw) as ChangeSetRecord
          this.changeSets.set(record.changeSetId, record)
        }
      } catch {
        logger.warn('changes', '无法解析变更记录', { file })
      }
    }
  }

  /** 返回保留的变更提案清单。 */
  list(): ChangeSetRecord[] {
    return [...this.changeSets.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
  }

  /** 按 ID 取得提案，不存在时抛出应用错误。 */
  get(changeSetId: string): ChangeSetRecord {
    const record = this.changeSets.get(changeSetId)
    if (!record) throw new AppError('FILE_NOT_FOUND', '变更提案不存在或已过期。')
    return record
  }

  /** 解析模型提交的原始提案；结构错误在此拦截，不进入执行阶段 */
  async createProposalFromModel(taskId: string, raw: unknown): Promise<ChangeSetRecord> {
    const parsed = ProposalSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppError('INVALID_PROPOSAL', `修改提案结构不合法：${formatIssues(parsed.error)}`)
    }
    const proposal = parsed.data
    const operations = proposal.operations.map((operation, index) => ({
      ...operation,
      operationId: operation.operationId ?? `op_${index + 1}`
    })) as ChangeOperation[]

    const targets: ChangeSetTarget[] = []
    for (const operation of operations) {
      if (!('guard' in operation)) {
        targets.push({
          documentId: null,
          workspaceId: operation.workspaceId,
          relativePath: operation.relativePath,
          title: operation.relativePath,
          kind: operation.kind
        })
        continue
      }
      let session
      try {
        session = this.documents.getSession(operation.guard.documentId)
      } catch {
        throw new AppError('INVALID_PROPOSAL', '提案引用的文档会话已失效，请重新读取文档。')
      }
      targets.push({
        documentId: session.documentId,
        workspaceId: session.workspaceId,
        relativePath: session.relativePath,
        title: session.title,
        kind: operation.kind
      })
    }

    const { risk } = assessRisk(operations)
    const changeSet: ChangeSetRecord = {
      changeSetId: newId('cs'),
      taskId,
      summary: proposal.summary.trim(),
      operations,
      proposalDigest: digestOf(proposal.summary, operations),
      risk,
      targets,
      sourceIds: proposal.sourceIds ?? [],
      sourceSetDigest: proposal.sourceSetDigest ?? null,
      styleDigest: proposal.styleDigest ?? null,
      status: 'pending',
      issues: [],
      createdAt: Date.now()
    }
    this.changeSets.set(changeSet.changeSetId, changeSet)
    await this.persistChangeSet(changeSet)
    logger.info('changes', '创建变更提案', {
      changeSetId: changeSet.changeSetId,
      operations: operations.length,
      risk
    })
    return changeSet
  }

  /** 计算审阅数据：文件级摘要、统一差异与表格预览 */
  async review(changeSetId: string): Promise<ReviewData> {
    const changeSet = this.get(changeSetId)
    const groups = new Map<string, DocGroup>()
    const issues: ProposalIssue[] = []

    for (const operation of changeSet.operations) {
      try {
        if (operation.kind === 'create_document') {
          const key = `create:${operation.relativePath}`
          groups.set(key, {
            key,
            documentId: null,
            relativePath: operation.relativePath,
            title: operation.relativePath.split('/').pop() ?? operation.relativePath,
            before: '',
            edits: [],
            kinds: new Set(['create_document']),
            issues: [],
            markdownPreview: operation.content
          })
          continue
        }
        if (operation.kind === 'delete_document') {
          const session = this.documents.getSession(operation.guard.documentId)
          const group = this.ensureGroup(
            groups,
            session.documentId,
            session.relativePath,
            session.title,
            session.text
          )
          group.kinds.add(operation.kind)
          continue
        }

        const session = this.documents.getSession(operation.guard.documentId)
        const group = this.ensureGroup(
          groups,
          session.documentId,
          session.relativePath,
          session.title,
          session.text
        )
        const context: DocumentContext = {
          documentId: session.documentId,
          title: session.title,
          revision: session.revision,
          text: session.text,
          contentHash: session.contentHash
        }
        const planned = planOperation(operation, context)
        group.edits.push(...planned.edits)
        group.kinds.add(operation.kind)
        group.issues.push(...planned.issues)
        if (operation.kind === 'insert_table') {
          group.tablePreview = { header: operation.table.header, rows: operation.table.rows }
          group.markdownPreview = renderTable(operation.table)
        } else if (operation.kind === 'insert_markdown') {
          group.markdownPreview = operation.markdown
        }
        issues.push(...planned.issues)
      } catch (error) {
        issues.push({
          operationId: operation.operationId,
          code: error instanceof AppError ? error.code : 'INVALID_PROPOSAL',
          message: messageOf(error),
          severity: 'error'
        })
      }
    }

    const files: ReviewFile[] = [...groups.values()].map((group) => {
      const after = applyEditsToText(group.before, group.edits)
      const diff = buildDiff(group.before, after)
      return {
        key: group.key,
        title: group.title,
        relativePath: group.relativePath,
        documentId: group.documentId,
        kind: [...group.kinds][0] ?? 'insert_markdown',
        summary: summarizeGroup(group),
        additions: diff.filter((line) => line.type === 'add').length,
        deletions: diff.filter((line) => line.type === 'del').length,
        diff: diff.slice(0, MAX_DIFF_LINES),
        tablePreview: group.tablePreview,
        markdownPreview: group.markdownPreview,
        issues: group.issues
      }
    })

    if (changeSet.sourceSetDigest && (changeSet.sourceIds ?? []).length) {
      if (this.references.digest(changeSet.sourceIds ?? []) !== changeSet.sourceSetDigest) {
        issues.push({
          operationId: null,
          code: 'SOURCE_STALE',
          message: '参考材料在提案生成后发生变化，需要重新生成。',
          severity: 'error'
        })
      }
    }

    const autoApplicable =
      changeSet.risk === 'low' &&
      files.length === 1 &&
      issues.length === 0 &&
      [...groups.values()].every((group, index) =>
        !isLargeEdit(group.before, group.edits, Math.max(files[index].additions, files[index].deletions))
      )

    return { changeSet: { ...changeSet, issues }, files, autoApplicable }
  }

  /** 拒绝仍待审阅的提案，不写入目标文稿。 */
  async reject(changeSetId: string): Promise<void> {
    const changeSet = this.get(changeSetId)
    if (changeSet.status !== 'pending') return
    changeSet.status = 'rejected'
    await this.persistChangeSet(changeSet)
  }

  /**
   * 用户确认后执行：先复核 digest、版本与全部文本计划，再按“修改 → 新建 → 删除”顺序落账。
   * 文本计划校验失败时不改写目标文件，但会记录失败的提案和事务状态。
   */
  async accept(changeSetId: string, proposalDigest: string): Promise<ApplyResult> {
    const changeSet = this.get(changeSetId)
    if (changeSet.status !== 'pending') {
      return { status: 'failed', transactionId: null, results: [], message: '该提案已被处理，不能重复应用。' }
    }
    if (proposalDigest !== changeSet.proposalDigest) {
      throw new AppError('INVALID_PROPOSAL', '提案内容已变化，请重新审阅。')
    }
    if (changeSet.sourceSetDigest && (changeSet.sourceIds ?? []).length) {
      const current = this.references.digest(changeSet.sourceIds ?? [])
      if (current !== changeSet.sourceSetDigest) {
        throw new AppError('SOURCE_STALE', '参考材料已变化，原提案失效，请重新生成。')
      }
    }

    const transaction: TransactionRecord = {
      transactionId: newId('txn'),
      changeSetId,
      createdAt: Date.now(),
      status: 'prepared',
      steps: changeSet.operations.map((operation) => ({
        operationId: operation.operationId,
        kind: operation.kind,
        relativePath: null,
        documentId: 'guard' in operation ? operation.guard.documentId : null,
        beforeHash: null,
        afterHash: null,
        backupPath: null,
        status: 'pending'
      }))
    }
    this.transactions.set(transaction.transactionId, transaction)
    await this.persistTransaction(transaction)

    const results: OperationResult[] = []
    let textBatches: TextBatch[]
    try {
      textBatches = await this.prepareTextBatches(changeSet.operations, transaction)
    } catch (error) {
      transaction.status = 'recovery_needed'
      changeSet.status = 'failed'
      await this.persistTransaction(transaction)
      await this.persistChangeSet(changeSet)
      return {
        status: 'conflict',
        transactionId: transaction.transactionId,
        results: changeSet.operations.map((operation) => ({
          operationId: operation.operationId,
          kind: operation.kind,
          status: 'failed',
          message: messageOf(error),
          relativePath: null,
          documentId: 'guard' in operation ? operation.guard.documentId : null
        })),
        message: messageOf(error)
      }
    }

    transaction.status = 'applying'
    let stopped = false
    const markSkipped = (operation: ChangeOperation, step: Step, reason: string): void => {
      step.status = 'skipped'
      results.push({
        operationId: operation.operationId,
        kind: operation.kind,
        status: 'skipped',
        message: reason,
        relativePath: step.relativePath,
        documentId: step.documentId
      })
    }

    // 1. 文本修改：按文档合并为单次编辑器事务
    for (const batch of textBatches) {
      if (stopped) {
        for (const operation of batch.operations) {
          markSkipped(
            operation,
            transaction.steps.find((item) => item.operationId === operation.operationId)!,
            '前序步骤失败，未执行。'
          )
        }
        continue
      }
      try {
        await this.applyTextBatch(batch, transaction)
        for (const operation of batch.operations) {
          const step = transaction.steps.find((item) => item.operationId === operation.operationId)!
          step.status = 'applied'
          results.push({
            operationId: operation.operationId,
            kind: operation.kind,
            status: 'applied',
            message: `已修改 ${batch.session.title}`,
            relativePath: batch.session.relativePath,
            documentId: batch.session.documentId,
            revision: batch.session.revision
          })
        }
      } catch (error) {
        stopped = true
        for (const operation of batch.operations) {
          const step = transaction.steps.find((item) => item.operationId === operation.operationId)!
          step.status = 'failed'
          step.message = messageOf(error)
          results.push({
            operationId: operation.operationId,
            kind: operation.kind,
            status: 'failed',
            message: messageOf(error),
            relativePath: step.relativePath,
            documentId: step.documentId
          })
        }
      }
      await this.persistTransaction(transaction)
    }

    // 2. 新建文档
    for (const operation of changeSet.operations.filter((item) => item.kind === 'create_document')) {
      const step = transaction.steps.find((item) => item.operationId === operation.operationId)!
      if (stopped) {
        markSkipped(operation, step, '前序步骤失败，未执行。')
        continue
      }
      try {
        results.push(await this.executeCreate(operation, step))
        step.status = 'applied'
      } catch (error) {
        stopped = true
        step.status = 'failed'
        step.message = messageOf(error)
        results.push({
          operationId: operation.operationId,
          kind: operation.kind,
          status: 'failed',
          message: messageOf(error),
          relativePath: step.relativePath,
          documentId: null
        })
      }
      await this.persistTransaction(transaction)
    }

    // 3. 删除文档：最后执行，减少不可逆影响
    for (const operation of changeSet.operations.filter((item) => item.kind === 'delete_document')) {
      const step = transaction.steps.find((item) => item.operationId === operation.operationId)!
      if (stopped) {
        markSkipped(operation, step, '前序步骤失败，未执行。')
        continue
      }
      try {
        results.push(await this.executeDelete(operation, step))
        step.status = 'applied'
      } catch (error) {
        stopped = true
        step.status = 'failed'
        step.message = messageOf(error)
        results.push({
          operationId: operation.operationId,
          kind: operation.kind,
          status: 'failed',
          message: messageOf(error),
          relativePath: step.relativePath,
          documentId: step.documentId
        })
      }
      await this.persistTransaction(transaction)
    }

    const appliedCount = results.filter((item) => item.status === 'applied').length
    const failed = results.some((item) => item.status === 'failed')
    const status: ApplyResult['status'] = failed
      ? appliedCount > 0
        ? 'partially_applied'
        : results.some((item) => /版本|冲突/.test(item.message))
          ? 'conflict'
          : 'failed'
      : 'applied'

    transaction.status =
      status === 'applied' ? 'committed' : appliedCount > 0 ? 'partially_applied' : 'recovery_needed'
    changeSet.status = status === 'applied' ? 'applied' : appliedCount > 0 ? 'partially_applied' : 'failed'
    await this.persistTransaction(transaction)
    await this.persistChangeSet(changeSet)

    const message =
      status === 'applied'
        ? `已应用 ${appliedCount} 项修改`
        : status === 'partially_applied'
          ? `部分修改已应用（${appliedCount} 项成功），失败项保留在事务记录中。`
          : '修改未应用，请查看失败原因。'

    return { status, transactionId: transaction.transactionId, results, message }
  }

  /** 同步目标会话并校验文本操作，生成按文档合并的计划；此处不应用目标编辑。 */
  private async prepareTextBatches(
    operations: ChangeOperation[],
    transaction: TransactionRecord
  ): Promise<TextBatch[]> {
    const grouped = new Map<string, ChangeOperation[]>()
    for (const operation of operations) {
      if (!isTextOperation(operation)) continue
      const documentId = (operation as ChangeOperation & { guard: { documentId: string } }).guard.documentId
      const list = grouped.get(documentId) ?? []
      list.push(operation)
      grouped.set(documentId, list)
    }

    const batches: TextBatch[] = []
    for (const [documentId, list] of grouped) {
      const session = this.documents.getSession(documentId)
      await this.documents.syncForAgent(documentId)
      for (const operation of list) {
        const guard = (
          operation as ChangeOperation & { guard: { baseRevision: number; expectedContentHash: string } }
        ).guard
        if (guard.baseRevision !== session.revision || guard.expectedContentHash !== session.contentHash) {
          throw new AppError('REVISION_CONFLICT', '文档在提案生成后已被修改，请重新读取并生成提案。')
        }
      }
      const context: DocumentContext = {
        documentId: session.documentId,
        title: session.title,
        revision: session.revision,
        text: session.text,
        contentHash: session.contentHash
      }
      const plans = list.map((operation) => planOperation(operation, context))
      const edits = plans.flatMap((plan) => plan.edits)
      // 重叠检测：同一文档内的多个编辑不得交叉
      const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].from < sorted[i - 1].to) {
          throw new AppError('INVALID_PROPOSAL', '提案中的多个操作范围重叠，请拆分为独立提案。')
        }
      }
      batches.push({ session, operations: list, edits, afterText: applyEditsToText(session.text, edits) })
      for (const operation of list) {
        const step = transaction.steps.find((item) => item.operationId === operation.operationId)
        if (step) step.documentId = session.documentId
      }
    }
    return batches
  }

  /** 备份编辑前正文；从编辑器取得应用结果，或为后台会话直接写盘。 */
  private async applyTextBatch(batch: TextBatch, transaction: TransactionRecord): Promise<void> {
    const { session, edits, afterText } = batch
    const before = session.text
    const beforeHash = session.contentHash
    const afterHash = sha256(afterText)
    const backupPath =
      session.dirty || !session.absPath
        ? await this.backupText(before, batch.operations[0].operationId)
        : await this.backupBefore(session.absPath, batch.operations[0].operationId)
    const lastOperationId = batch.operations[batch.operations.length - 1].operationId

    if (session.attached) {
      const response = await this.bridge.apply({
        documentId: session.documentId,
        expectedRevision: session.revision,
        undoGroupId: newId('undo'),
        edits,
        reveal: { from: edits[0].from, to: edits[0].from + (edits[0].insert?.length ?? 0) }
      })
      if (typeof response.text !== 'string') {
        throw new AppError('REVISION_CONFLICT', '编辑器未返回修改后的文本。')
      }
      if (sha256(response.text) !== afterHash) {
        logger.warn('changes', '编辑器结果与预期不一致，以编辑器结果为准', {
          documentId: session.documentId
        })
      }
      await this.documents.applyTextFromAgent(session.documentId, response.text)
    } else {
      if (!session.absPath) throw new AppError('SAVE_FAILED', '未保存的文档无法在后台写入。')
      const buffer = toDiskText(afterText, session.eol, session.hasBom)
      await atomicWriteFile(session.absPath, buffer)
      session.applyText(afterText, { markSaved: true })
      session.markSaved(sha256(buffer))
    }

    for (const operation of batch.operations) {
      const step = transaction.steps.find((item) => item.operationId === operation.operationId)
      if (!step) continue
      step.relativePath = session.relativePath
      step.beforeHash = beforeHash
      step.afterHash = operation.operationId === lastOperationId ? afterHash : null
      step.backupPath = backupPath
    }
  }

  private async executeCreate(
    operation: ChangeOperation & { kind: 'create_document' },
    step: Step
  ): Promise<OperationResult> {
    const workspace = this.workspace.getCurrent()
    if (!workspace || workspace.workspaceId !== operation.workspaceId) {
      throw new AppError('OUT_OF_SCOPE', '目标工作区已变化，无法创建文件。')
    }
    const created = await this.workspace.createFile(operation.relativePath, operation.content)
    const abs = await this.workspace.resolveExisting(created)
    const snapshot = await this.documents.openPath(abs, true)
    step.relativePath = created
    step.documentId = snapshot.documentId
    step.afterHash = sha256(operation.content)
    return {
      operationId: operation.operationId,
      kind: operation.kind,
      status: 'applied',
      message: `已创建 ${created}`,
      relativePath: created,
      documentId: snapshot.documentId,
      revision: snapshot.revision
    }
  }

  private async executeDelete(
    operation: ChangeOperation & { kind: 'delete_document' },
    step: Step
  ): Promise<OperationResult> {
    const session = this.documents.getSession(operation.guard.documentId)
    await this.documents.syncForAgent(session.documentId)
    if (session.revision !== operation.guard.baseRevision || session.contentHash !== operation.guard.expectedContentHash) {
      throw new AppError('REVISION_CONFLICT', '文档在删除前已被修改，请重新确认。')
    }
    const { relativePath, workspaceId } = session
    if (!relativePath || !workspaceId || this.workspace.getCurrent()?.workspaceId !== workspaceId) {
      throw new AppError('OUT_OF_SCOPE', '只能删除当前工作区内的文档。')
    }
    if (session.dirty) {
      if (!session.absPath) throw new AppError('SAVE_FAILED', '文档尚未保存，无法删除。')
      const saved = await this.documents.save(session.documentId, session.revision)
      if (saved.status !== 'saved') throw new AppError('SAVE_FAILED', '删除前保存失败，操作已中止。')
    }
    step.beforeHash = session.contentHash
    step.backupPath = await this.backupBefore(session.absPath, operation.operationId)
    step.relativePath = relativePath
    await this.workspace.remove(relativePath, workspaceId)
    await this.documents.close(session.documentId)
    return {
      operationId: operation.operationId,
      kind: operation.kind,
      status: 'applied',
      message: `已删除 ${relativePath}（可在回收站或事务记录中恢复）`,
      relativePath,
      documentId: session.documentId
    }
  }

  /** 比较并恢复：只有当前内容仍等于 afterHash 时才覆盖，避免抹掉用户新修改 */
  async restore(transactionId: string): Promise<RestoreResult> {
    const transaction = this.transactions.get(transactionId)
    if (!transaction) throw new AppError('FILE_NOT_FOUND', '事务记录不存在。')
    const results: OperationResult[] = []
    const handledDocuments = new Set<string>()
    let conflict = false

    for (const step of [...transaction.steps].reverse()) {
      if (step.status !== 'applied') continue
      try {
        if (step.kind === 'create_document') {
          if (!step.relativePath) throw new AppError('FILE_NOT_FOUND')
          const abs = await this.workspace.resolveExisting(step.relativePath)
          const current = await readFile(abs)
          if (step.afterHash && sha256(current) !== step.afterHash) {
            conflict = true
            throw new AppError('RECOVERY_CONFLICT', '文件在创建后又被修改，未删除。')
          }
          await this.workspace.remove(step.relativePath)
          step.status = 'restored'
          results.push({
            operationId: step.operationId,
            kind: step.kind,
            status: 'applied',
            message: `已撤销创建 ${step.relativePath}`,
            relativePath: step.relativePath,
            documentId: step.documentId
          })
          continue
        }

        if (step.kind === 'delete_document') {
          if (!step.relativePath || !step.backupPath) {
            conflict = true
            throw new AppError('RECOVERY_CONFLICT', '缺少恢复副本，无法恢复已删除文件。')
          }
          const workspace = this.workspace.getCurrent()
          if (!workspace) throw new AppError('OUT_OF_SCOPE')
          const target = join(workspace.rootPath, step.relativePath)
          if (await pathExists(target)) {
            conflict = true
            throw new AppError('RECOVERY_CONFLICT', '原位置已有同名文件，未覆盖。')
          }
          await mkdir(dirname(target), { recursive: true })
          await copyFile(step.backupPath, target)
          step.status = 'restored'
          results.push({
            operationId: step.operationId,
            kind: step.kind,
            status: 'applied',
            message: `已恢复 ${step.relativePath}`,
            relativePath: step.relativePath,
            documentId: step.documentId
          })
          continue
        }

        // 文本修改：同文档只恢复一次（仅批次最后一步记录 afterHash）
        if (!step.documentId) {
          conflict = true
          throw new AppError('RECOVERY_CONFLICT', '缺少恢复到原内容所需的信息。')
        }
        if (handledDocuments.has(step.documentId)) {
          step.status = 'restored'
          continue
        }
        if (!step.afterHash || !step.backupPath) {
          // 同批次中较早的步骤，交给记录 afterHash 的最后一步处理
          continue
        }
        const before = await readFile(step.backupPath, 'utf8')
        const session = this.documents.getSession(step.documentId)
        if (sha256(session.text) !== step.afterHash) {
          conflict = true
          throw new AppError('RECOVERY_CONFLICT', '文档在修改后又被编辑，请手动处理。')
        }
        if (session.attached) {
          const response = await this.bridge.apply({
            documentId: session.documentId,
            expectedRevision: session.revision,
            undoGroupId: newId('restore'),
            edits: [{ from: 0, to: session.text.length, insert: before }]
          })
          await this.documents.applyTextFromAgent(session.documentId, response.text ?? before)
        } else if (session.absPath) {
          await atomicWriteFile(session.absPath, toDiskText(before, session.eol, session.hasBom))
          session.applyText(before, { markSaved: true })
        }
        handledDocuments.add(step.documentId)
        step.status = 'restored'
        results.push({
          operationId: step.operationId,
          kind: step.kind,
          status: 'applied',
          message: `已恢复 ${session.title} 的修改前内容`,
          relativePath: session.relativePath,
          documentId: session.documentId,
          revision: session.revision
        })
      } catch (error) {
        results.push({
          operationId: step.operationId,
          kind: step.kind,
          status: 'failed',
          message: messageOf(error),
          relativePath: step.relativePath,
          documentId: step.documentId
        })
      }
    }

    transaction.status = conflict ? 'recovery_needed' : 'restored'
    await this.persistTransaction(transaction)
    return {
      status: conflict ? 'partially_restored' : 'restored',
      results,
      message: conflict ? '部分步骤因内容已变化未能恢复。' : '已恢复到修改前状态。'
    }
  }

  /** 未保存缓冲区直接写入恢复副本，避免恢复时丢失 AI 修改之前的草稿内容 */
  private async backupText(text: string, operationId: string): Promise<string | null> {
    try {
      const dir = join(appPaths().recoveryDir, 'transactions')
      await mkdir(dir, { recursive: true })
      const target = join(dir, `${Date.now()}-${operationId}-draft.md`)
      await atomicWriteFile(target, text)
      return target
    } catch {
      return null
    }
  }

  private async backupBefore(absPath: string | null, operationId: string): Promise<string | null> {
    if (!absPath) return null
    try {
      const dir = join(appPaths().recoveryDir, 'transactions')
      await mkdir(dir, { recursive: true })
      const target = join(dir, `${Date.now()}-${operationId}-${basename(absPath)}`)
      await copyFile(absPath, target)
      return target
    } catch {
      return null
    }
  }

  private ensureGroup(
    groups: Map<string, DocGroup>,
    documentId: string,
    relativePath: string | null,
    title: string,
    before: string
  ): DocGroup {
    const key = `doc:${documentId}`
    const existing = groups.get(key)
    if (existing) return existing
    const group: DocGroup = {
      key,
      documentId,
      relativePath,
      title,
      before,
      edits: [],
      kinds: new Set(),
      issues: []
    }
    groups.set(key, group)
    return group
  }

  private async persistChangeSet(record: ChangeSetRecord): Promise<void> {
    await atomicWriteFile(
      join(appPaths().changesDir, `${record.changeSetId}.json`),
      JSON.stringify(record, null, 2)
    ).catch((error) => logger.warn('changes', '提案持久化失败', { message: messageOf(error) }))
  }

  private async persistTransaction(record: TransactionRecord): Promise<void> {
    await atomicWriteFile(
      join(appPaths().changesDir, `${record.transactionId}.txn.json`),
      JSON.stringify(record, null, 2)
    ).catch((error) => logger.warn('changes', '事务日志写入失败', { message: messageOf(error) }))
  }

  /** 清理 7 天前的待审提案；事务与恢复副本不自动清理 */
  async cleanup(maxAgeMs = 7 * 24 * 3600 * 1000): Promise<void> {
    const now = Date.now()
    for (const [id, record] of this.changeSets) {
      if (record.status !== 'pending' || now - record.createdAt < maxAgeMs) continue
      record.status = 'expired'
      await this.persistChangeSet(record)
      this.changeSets.delete(id)
    }
  }

  /** 从内存与本地存储移除指定提案记录。 */
  async removeChangeSet(changeSetId: string): Promise<void> {
    this.changeSets.delete(changeSetId)
    await unlink(join(appPaths().changesDir, `${changeSetId}.json`)).catch(() => undefined)
  }
}

function digestOf(summary: string, operations: ChangeOperation[]): string {
  return sha256(
    JSON.stringify({
      summary: summary.trim(),
      operations: operations.map((operation) => ({ ...operation, operationId: undefined }))
    })
  )
}

function summarizeGroup(group: DocGroup): string {
  const labels: Record<string, string> = {
    insert_table: '插入表格',
    insert_markdown: '插入内容',
    replace_range: '替换文本',
    create_document: '新建文档',
    delete_document: '删除文档'
  }
  return [...group.kinds].map((kind) => labels[kind] ?? kind).join('、')
}
