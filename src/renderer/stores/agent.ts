/**
 * AI Store：Provider 选择、附件与参考材料、任务事件、变更审阅与预测。
 * 界面只消费归一化后的事件，不直接解析模型输出。
 */

import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  Attachment,
  ClarificationRequest,
  ProviderConfig,
  ReferenceRole,
  ReviewData,
  SourceAsset,
  SourcePreviewChunk,
  StyleProfile,
  StartTaskInput,
  TaskEvent,
  TaskSnapshot
} from '@shared/types'
import { useDocumentsStore } from './documents'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'
import { editorApi } from '../lib/editorApi'

/** 表示 Agent 面板中的单次工具调用和显示状态。 */
export interface TaskTool {
  /** 用于匹配一次模型工具请求、执行结果和任务进度的调用标识。 */
  callId: string
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 当前记录的处理状态。 */
  status: 'running' | 'done' | 'failed'
  /** 面向用户展示的简短操作说明。 */
  summary: string
}

/** 聚合 Agent 任务面板使用的文本、步骤、提案和结果状态。 */
export interface TaskView {
  /** 用于关联任务状态、工具调用及事件的任务标识。 */
  taskId: string | null
  /** 任务关联的文稿或工作区展示标题。 */
  documentTitle: string
  /** 用户发给任务的指令文本。 */
  prompt: string
  /** 当前记录的处理状态。 */
  status:
    'idle' | 'running' | 'waiting_input' | 'reviewing' | 'applied' | 'completed' | 'failed' | 'cancelled'
  /** 任务面板展示的当前阶段文案。 */
  phaseLabel: string
  /** 累计任务流式输出的文本，供 AI 面板展示。 */
  text: string
  stepsText: string
  /** 面板按调用标识更新的工具执行步骤。 */
  tools: TaskTool[]
  /** 任务需向用户确认时提供的澄清请求。 */
  clarification: ClarificationRequest | null
  /** 失败时供调用方分支处理和展示的结构化错误。 */
  error: { code: string; message: string; retryable: boolean } | null
  /** 与当前工具或任务结果关联的可审阅提案标识。 */
  proposalId: string | null
  /** 保存提案应用事件携带的事务和状态摘要。 */
  applied: { transactionId: string | null; message: string; status: string } | null
}

const emptyTask = (): TaskView => ({
  taskId: null,
  documentTitle: '',
  prompt: '',
  status: 'idle',
  phaseLabel: '',
  text: '',
  stepsText: '',
  tools: [],
  clarification: null,
  error: null,
  proposalId: null,
  applied: null
})

/** 维护渲染端任务视图，接收 Agent 事件并驱动任务交互。 */
export const useAgentStore = defineStore('agent', () => {
  const providers = ref<ProviderConfig[]>([])
  const selectedProviderId = ref<string>(localStorage.getItem('moye.provider') ?? '')
  const attachments = ref<Attachment[]>([])
  const documents = useDocumentsStore()
  const documentId = computed(() => documents.activeId)
  const tabKey = (id: string | null): string => id ?? 'workspace'
  const currentKey = computed(() => tabKey(documentId.value))
  const drafts = reactive<Record<string, string>>({})
  const attachmentSelections = reactive<Record<string, string[]>>({})
  const sourceSelections = reactive<Record<string, string[]>>({})
  const selectedAttachmentIds = computed({
    get: () => attachmentSelections[currentKey.value] ?? [],
    set: (ids: string[]) => { attachmentSelections[currentKey.value] = ids }
  })
  const sources = ref<SourceAsset[]>([])
  const selectedSourceIds = computed({
    get: () => sourceSelections[currentKey.value] ?? [],
    set: (ids: string[]) => { sourceSelections[currentKey.value] = ids }
  })
  const styles = ref<StyleProfile[]>([])
  const selectedStyleId = ref<string>('')
  const tasks = reactive<Record<string, TaskView>>({})
  const taskKeys = new Map<string, string>()
  const task = computed(() => tasks[currentKey.value] ?? emptyTask())
  const history = ref<TaskSnapshot[]>([])
  const historyHasMore = ref(false)
  const historyLoading = ref(false)
  let historyVersion = 0

  async function loadHistory(append = false): Promise<void> {
    if (append && historyLoading.value) return
    const id = documentId.value
    const version = ++historyVersion
    const offset = append ? history.value.length : 0
    historyLoading.value = true
    if (!append) {
      history.value = []
      historyHasMore.value = false
    }
    try {
      const page = await window.api.agent.history(id, offset)
      if (version !== historyVersion) return
      history.value = append ? [...history.value, ...page] : page
      historyHasMore.value = page.length === 20
    } catch (error) {
      if (version === historyVersion) useUiStore().toast((error as Error).message || '无法读取对话历史', 'error')
    } finally {
      if (version === historyVersion) historyLoading.value = false
    }
  }

  async function deleteHistory(ids: string[] | null): Promise<void> {
    const id = documentId.value
    const key = currentKey.value
    try {
      await window.api.agent.deleteHistory(id, ids)
      const current = tasks[key]
      if (current?.taskId && (!ids || ids.includes(current.taskId)) &&
          !['running', 'waiting_input'].includes(current.status)) {
        taskKeys.delete(current.taskId)
        delete tasks[key]
      }
      if (id === documentId.value) await loadHistory()
    } catch (error) {
      useUiStore().toast((error as Error).message || '无法删除对话', 'error')
    }
  }

  watch(() => [documentId.value, documents.activeTab?.snapshot.title, documents.activeTab?.snapshot.existsOnDisk], () => { void loadHistory() }, { immediate: true })
  const proposal = ref<ReviewData | null>(null)
  const proposalLoading = ref(false)
  let reviewDocumentId: string | null = null
  const prompt = computed({
    get: () => drafts[currentKey.value] ?? '',
    set: (value: string) => { drafts[currentKey.value] = value }
  })
  const scope = ref<StartTaskInput['scope']>('auto')
  const mode = ref<'edit' | 'ask'>('edit')
  const predicting = ref(false)
  /** 自动预测失败时的最近一次提示时间，避免频繁打扰 */
  let lastAutoWarnAt = 0
  const previewSource = ref<SourceAsset | null>(null)
  const previewChunks = ref<SourcePreviewChunk[]>([])
  const previewOpen = ref(false)

  const selectedProvider = computed<ProviderConfig | null>(() => {
    const id = selectedProviderId.value
    return (
      providers.value.find((item) => item.providerId === id) ??
      providers.value.find((item) => item.isDefault) ??
      providers.value[0] ??
      null
    )
  })

  const selectedAttachments = computed(() =>
    attachments.value.filter((item) => selectedAttachmentIds.value.includes(item.attachmentId))
  )

  const selectedSources = computed(() =>
    sources.value.filter((item) => selectedSourceIds.value.includes(item.sourceId))
  )

  const isRunning = computed(() => task.value.status === 'running' || task.value.status === 'waiting_input')

  async function hydrate(): Promise<void> {
    const [providerList, attachmentList, sourceList, styleList] = await Promise.all([
      window.api.providers.list(),
      window.api.attachments.list(),
      window.api.references.list(),
      window.api.styles.list()
    ])
    providers.value = providerList
    attachments.value = attachmentList
    sources.value = sourceList
    styles.value = styleList
    if (!providerList.some((item) => item.providerId === selectedProviderId.value)) {
      selectedProviderId.value =
        (providerList.find((item) => item.isDefault) ?? providerList[0])?.providerId ?? ''
    }
    if (!styleList.some((item) => item.profileId === selectedStyleId.value)) {
      selectedStyleId.value = ''
    }
  }

  async function refreshProviders(): Promise<void> {
    providers.value = await window.api.providers.list()
    if (!providers.value.some((item) => item.providerId === selectedProviderId.value)) {
      selectedProviderId.value =
        (providers.value.find((item) => item.isDefault) ?? providers.value[0])?.providerId ?? ''
    }
  }

  function setProvider(providerId: string): void {
    selectedProviderId.value = providerId
    localStorage.setItem('moye.provider', providerId)
  }

  async function start(): Promise<void> {
    const documents = useDocumentsStore()
    const ui = useUiStore()
    const doc = documents.activeTab
    const text = prompt.value.trim()
    if (!text) {
      ui.toast('先写下想让 AI 做的事', 'warning')
      return
    }
    if (!selectedProvider.value) {
      ui.toast('请先在设置中添加模型服务', 'warning')
      ui.modal = 'providers'
      return
    }
    if (isRunning.value) return
    const id = doc?.snapshot.documentId ?? null
    const key = currentKey.value
    const providerId = selectedProvider.value.providerId
    const selectedScope = scope.value
    const selectedMode = mode.value
    const attachmentIds = [...selectedAttachmentIds.value]
    const sourceIds = [...selectedSourceIds.value]
    const styleProfileId = selectedStyleId.value
    const selection = editorApi.current?.getSelection()
    const useSelection = selectedScope === 'selection' && selection && selection.from !== selection.to && doc
    if (selectedScope === 'selection' && !useSelection) {
      ui.toast('请先选中需要修改的内容', 'warning')
      return
    }
    const previous = tasks[key]
    if (previous?.taskId) taskKeys.delete(previous.taskId)
    try {
      tasks[key] = {
        ...emptyTask(),
        status: 'running',
        documentTitle: doc?.snapshot.title ?? '工作区',
        prompt: text,
        phaseLabel: '准备任务',
        text: ''
      }
      drafts[key] = ''
      if (doc) await documents.flush(doc.snapshot.documentId)
      const result = await window.api.agent.start({
        documentId: id,
        prompt: text,
        scope: selectedScope,
        ...(useSelection ? { selection: { from: selection!.from, to: selection!.to } } : {}),
        providerId,
        attachmentIds,
        sourceIds,
        mode: selectedMode,
        ...(styleProfileId ? { styleProfileId } : {})
      })
      const current = tasks[key]
      if (current?.status === 'running' && !current.taskId) {
        current.taskId = result.taskId
        taskKeys.set(result.taskId, key)
      }
    } catch (error) {
      drafts[key] = text
      tasks[key].status = 'failed'
      tasks[key].error = {
        code: (error as { code?: string }).code ?? 'UNKNOWN',
        message: (error as Error).message,
        retryable: Boolean((error as { retryable?: boolean }).retryable)
      }
      ui.toast((error as Error).message || '无法启动任务', 'error')
    }
  }

  async function cancel(): Promise<void> {
    const taskId = task.value.taskId
    if (!taskId) return
    await window.api.agent.cancel(taskId)
  }

  async function answer(value: string, option?: string): Promise<void> {
    const taskId = task.value.taskId
    if (!taskId) return
    const current = task.value
    try {
      await window.api.agent.answer({ taskId, answer: value, selectedOption: option })
      if (current.status === 'waiting_input') {
        current.clarification = null
        current.status = 'running'
        current.phaseLabel = '继续处理'
      }
    } catch (error) {
      useUiStore().toast((error as Error).message || '无法发送回答', 'error')
    }
  }

  /** 处理主进程推送的任务事件（由 App 统一订阅） */
  /** 将任务事件归并到当前任务视图，包括文本增量、工具状态及提案结果。 */
  function handleEvent(event: TaskEvent): void {
    if (event.type === 'started') {
      const key = tabKey(event.task.documentId)
      const current = tasks[key]
      if (!current) return
      current.taskId = event.taskId
      taskKeys.set(event.taskId, key)
      return
    }
    const key = taskKeys.get(event.taskId)
    const current = key ? tasks[key] : undefined
    if (!current) return
    switch (event.type) {
      case 'phase':
        current.phaseLabel = event.label
        break
      case 'text_delta':
        current.text += event.text
        break
      case 'step_text':
        current.stepsText += (current.stepsText ? '\n\n' : '') + event.text
        current.text = ''
        break
      case 'message':
        current.text += `${current.text ? '\n' : ''}${event.text}`
        break
      case 'tool_started':
        current.tools = [
          ...current.tools,
          {
            callId: event.callId,
            name: event.name,
            title: event.title,
            status: 'running',
            summary: event.argsSummary
          }
        ]
        break
      case 'tool_finished':
        current.tools = current.tools.map((tool) =>
          tool.callId === event.callId
            ? { ...tool, status: event.ok ? 'done' : 'failed', summary: event.summary }
            : tool
        )
        break
      case 'clarification':
        current.clarification = {
          question: event.question,
          options: event.options,
          allowFreeText: event.allowFreeText
        }
        current.status = 'waiting_input'
        break
      case 'proposal_ready':
        current.status = 'reviewing'
        current.clarification = null
        current.phaseLabel = '等待审阅'
        current.proposalId = event.changeSetId
        break
      case 'applied':
        current.status = event.status === 'applied' || event.status === 'partially_applied' ? 'applied' : 'failed'
        current.phaseLabel =
          event.status === 'applied' ? '已应用' : event.status === 'partially_applied' ? '部分应用' : '未能应用'
        current.applied = {
          transactionId: event.transactionId,
          message: event.summary,
          status: event.status
        }
        break
      case 'failed':
        current.status = 'failed'
        current.clarification = null
        current.error = { code: event.code, message: event.message, retryable: event.retryable }
        break
      case 'cancelled':
        current.status = 'cancelled'
        current.clarification = null
        current.phaseLabel = '已停止'
        break
      case 'completed':
        current.status = 'completed'
        current.clarification = null
        current.phaseLabel = '已完成'
        current.text = event.text
        break
      default:
        break
    }
    if (key === currentKey.value && ['completed', 'applied', 'proposal_ready', 'cancelled', 'failed'].includes(event.type)) {
      void loadHistory()
    }
  }

  /** 获取可审阅差异，将指定提案交给审阅界面展示。 */
  async function openReview(changeSetId: string): Promise<void> {
    if (proposalLoading.value) return
    reviewDocumentId = documentId.value
    proposalLoading.value = true
    useUiStore().reviewOpen = true
    try {
      proposal.value = await window.api.changes.review(changeSetId)
    } catch (error) {
      useUiStore().toast((error as Error).message || '无法加载提案', 'error')
      useUiStore().reviewOpen = false
    } finally {
      proposalLoading.value = false
    }
  }

  /** 提交当前审阅的提案及摘要，并根据执行结果更新审阅窗口。 */
  async function acceptProposal(): Promise<void> {
    const review = proposal.value
    if (!review || proposalLoading.value) return
    const id = reviewDocumentId
    const ui = useUiStore()
    proposalLoading.value = true
    try {
      const result = await window.api.changes.accept(review.changeSet.changeSetId, review.changeSet.proposalDigest, id)
      const current = tasks[tabKey(id)]
      if (current?.proposalId === review.changeSet.changeSetId) {
        current.applied = { transactionId: result.transactionId, message: result.message, status: result.status }
        current.status = result.status === 'applied' ? 'applied' : 'reviewing'
        current.phaseLabel = result.status === 'applied' ? '已应用' : '等待审阅'
      }
      ui.toast(result.message, result.status === 'applied' ? 'success' : 'warning', 4200)
      if (result.status === 'applied') {
        ui.reviewOpen = false
      } else {
        proposal.value = await window.api.changes.review(review.changeSet.changeSetId).catch(() => review)
      }
      if (id === documentId.value) await loadHistory()
    } catch (error) {
      ui.toast((error as Error).message || '应用失败', 'error')
    } finally {
      proposalLoading.value = false
    }
  }

  async function rejectProposal(changeSetId = proposal.value?.changeSet.changeSetId): Promise<void> {
    if (!changeSetId || proposalLoading.value) return
    const fromDialog = changeSetId === proposal.value?.changeSet.changeSetId && useUiStore().reviewOpen
    const id = fromDialog ? reviewDocumentId : documentId.value
    const ui = useUiStore()
    proposalLoading.value = true
    try {
      await window.api.changes.reject(changeSetId, id)
      if (fromDialog) {
        proposal.value = null
        ui.reviewOpen = false
      }
      const current = tasks[tabKey(id)]
      if (current?.proposalId === changeSetId) {
        current.status = 'cancelled'
        current.phaseLabel = '已放弃'
      }
      if (id === documentId.value) await loadHistory()
      ui.toast('已放弃本次建议', 'info')
    } catch (error) {
      ui.toast((error as Error).message || '放弃建议失败', 'error')
    } finally {
      proposalLoading.value = false
    }
  }

  async function restoreTransaction(transactionId: string): Promise<void> {
    const ui = useUiStore()
    try {
      const result = await window.api.changes.restore(transactionId)
      ui.toast(result.message, result.status === 'restored' ? 'success' : 'warning', 4200)
    } catch (error) {
      ui.toast((error as Error).message || '恢复失败', 'error')
    }
  }

  /* --------------------------- 附件与参考材料 --------------------------- */

  async function addAttachmentDialog(): Promise<void> {
    const key = currentKey.value
    const added = await window.api.attachments.addFromDialog()
    if (!added.length) return
    attachments.value = [...added, ...attachments.value]
    attachmentSelections[key] = [...new Set([...(attachmentSelections[key] ?? []), ...added.map((item) => item.attachmentId)])]
  }

  async function addAttachmentBytes(name: string, mime: string, bytes: ArrayBuffer, key = currentKey.value): Promise<void> {
    const added = await window.api.attachments.addFromBytes(name, mime, bytes)
    attachments.value = [added, ...attachments.value]
    attachmentSelections[key] = [...new Set([...(attachmentSelections[key] ?? []), added.attachmentId])]
  }

  function toggleAttachment(attachmentId: string): void {
    selectedAttachmentIds.value = selectedAttachmentIds.value.includes(attachmentId)
      ? selectedAttachmentIds.value.filter((id) => id !== attachmentId)
      : [...selectedAttachmentIds.value, attachmentId]
  }

  async function addReferenceFile(): Promise<void> {
    const key = currentKey.value
    const added = await window.api.references.addFileDialog()
    if (!added.length) return
    sources.value = [...added, ...sources.value]
    sourceSelections[key] = [...new Set([...(sourceSelections[key] ?? []), ...added.map((item) => item.sourceId)])]
  }

  /** 拖入/粘贴的文件：主进程先落到参考目录再解析，不读取任意路径 */
  async function addReferenceBytes(name: string, bytes: ArrayBuffer, key = currentKey.value): Promise<SourceAsset> {
    const added = await window.api.references.addFromBytes(name, bytes)
    sources.value = [added, ...sources.value]
    sourceSelections[key] = [...new Set([...(sourceSelections[key] ?? []), added.sourceId])]
    return added
  }

  async function addReferenceWeb(url: string): Promise<void> {
    const added = await window.api.references.add({ kind: 'web', url, roles: ['facts'] })
    sources.value = [added, ...sources.value]
    selectedSourceIds.value = [...new Set([...selectedSourceIds.value, added.sourceId])]
  }

  async function addReferenceDocument(): Promise<void> {
    const documents = useDocumentsStore()
    const doc = documents.activeTab
    if (!doc) return
    const added = await window.api.references.add({
      kind: 'document',
      documentId: doc.snapshot.documentId,
      roles: ['facts'],
      title: doc.snapshot.title
    })
    sources.value = [added, ...sources.value]
    selectedSourceIds.value = [...new Set([...selectedSourceIds.value, added.sourceId])]
  }

  function toggleSource(sourceId: string): void {
    selectedSourceIds.value = selectedSourceIds.value.includes(sourceId)
      ? selectedSourceIds.value.filter((id) => id !== sourceId)
      : [...selectedSourceIds.value, sourceId]
  }

  async function setSourceRoles(sourceId: string, roles: ReferenceRole[]): Promise<void> {
    const updated = await window.api.references.setRoles(sourceId, roles)
    sources.value = sources.value.map((item) => (item.sourceId === sourceId ? updated : item))
  }

  async function openSourcePreview(sourceId: string): Promise<void> {
    const asset = sources.value.find((item) => item.sourceId === sourceId)
    if (!asset) return
    previewSource.value = asset
    previewChunks.value = await window.api.references.preview(sourceId)
    previewOpen.value = true
  }

  function closeSourcePreview(): void {
    previewOpen.value = false
    previewSource.value = null
    previewChunks.value = []
  }

  async function removeSource(sourceId: string): Promise<void> {
    await window.api.references.remove(sourceId)
    sources.value = sources.value.filter((item) => item.sourceId !== sourceId)
    selectedSourceIds.value = selectedSourceIds.value.filter((id) => id !== sourceId)
  }

  /* ------------------------------ 预测 ------------------------------ */

  /** 请求光标续写；只在活动文稿、修订和选区仍匹配时装饰编辑器。 */
  async function requestPrediction(trigger: 'manual' | 'auto' = 'manual'): Promise<void> {
    const settings = useSettingsStore()
    const ui = useUiStore()
    const documents = useDocumentsStore()
    const editor = editorApi.current
    const doc = documents.activeTab
    if (!editor || !doc || predicting.value) return
    if (isRunning.value) return
    if (editor.hasGhost()) return
    const selection = editor.getSelection()
    predicting.value = true
    try {
      const result = await window.api.prediction.request({
        documentId: doc.snapshot.documentId,
        ...(selectedProvider.value ? { providerId: selectedProvider.value.providerId } : {}),
        revision: doc.snapshot.revision,
        offset: selection.to,
        ...(selection.from !== selection.to ? { selection: { from: selection.from, to: selection.to } } : {}),
        sourceIds: [...selectedSourceIds.value],
        ...(selectedStyleId.value ? { styleProfileId: selectedStyleId.value } : {}),
        trigger
      })
      if (!result) return
      const current = editorApi.current
      if (!current || documents.activeId !== doc.snapshot.documentId) return
      if (doc.snapshot.revision !== result.contextKey.revision) return
      const snapshotSelection = current.getSelection()
      if (snapshotSelection.from !== selection.from || snapshotSelection.to !== selection.to) return
      current.showGhost(result.text)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (trigger === 'manual' && code !== 'PREDICTION_STALE') {
        ui.toast((error as Error).message || '预测失败', 'warning')
      }
      // 自动预测默认静默，但供应商限流时给一次轻提示，避免“完全没反应”的错觉
      if (
        trigger === 'auto' &&
        code === 'PROVIDER_RATE_LIMIT' &&
        Date.now() - lastAutoWarnAt > 60_000
      ) {
        lastAutoWarnAt = Date.now()
        ui.toast('预测请求过于频繁，稍后会自动继续', 'warning', 3200)
      }
      if (code === 'PREDICTION_DISABLED' && trigger === 'auto') {
        settings.settings.prediction.auto = false
      }
    } finally {
      predicting.value = false
    }
  }

  return {
    providers,
    selectedProviderId,
    selectedProvider,
    attachments,
    selectedAttachmentIds,
    selectedAttachments,
    sources,
    selectedSourceIds,
    selectedSources,
    styles,
    selectedStyleId,
    task,
    proposal,
    proposalLoading,
    prompt,
    scope,
    mode,
    isRunning,
    predicting,
    previewSource,
    previewChunks,
    previewOpen,
    hydrate,
    refreshProviders,
    setProvider,
    start,
    cancel,
    answer,
    handleEvent,
    openReview,
    acceptProposal,
    rejectProposal,
    restoreTransaction,
    addAttachmentDialog,
    addAttachmentBytes,
    toggleAttachment,
    addReferenceFile,
    addReferenceBytes,
    addReferenceWeb,
    addReferenceDocument,
    toggleSource,
    setSourceRoles,
    removeSource,
    openSourcePreview,
    closeSourcePreview,
    requestPrediction,
    currentKey,
    history,
    historyHasMore,
    historyLoading,
    loadHistory,
    deleteHistory
  }
})
