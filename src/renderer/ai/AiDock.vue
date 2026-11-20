<script setup lang="ts">
/**
 * AI 面板：任务进度、澄清、审阅入口、附件与参考材料、模型选择与预测触发。
 * 面板占据布局空间，不覆盖正文。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ReferenceRole } from '@shared/types'
import { useAgentStore } from '../stores/agent'
import { useDocumentsStore } from '../stores/documents'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { editorApi } from '../lib/editorApi'
import Icon from '../components/Icon.vue'

const agent = useAgentStore()
const documents = useDocumentsStore()
const settings = useSettingsStore()
const ui = useUiStore()

const attachOpen = ref(false)
const urlOpen = ref(false)
const urlValue = ref('')
const answerText = ref('')
const scrollArea = ref<HTMLElement | null>(null)

const hasSelection = computed(() => ui.selectionFrom !== ui.selectionTo)
const contextTitle = computed(() => documents.activeTab?.snapshot.title ?? '工作区')
const hasTask = computed(() => agent.task.status !== 'idle')
const running = computed(() => agent.task.status === 'running' || agent.task.status === 'waiting_input')
const providerReady = computed(() => Boolean(agent.selectedProvider))

const roleOptions: Array<{ value: ReferenceRole; label: string }> = [
  { value: 'facts', label: '事实依据' },
  { value: 'data', label: '待提取数据' },
  { value: 'writing_style', label: '写作风格' },
  { value: 'visual_style', label: '视觉样式' }
]

/** 附件缩略图：按需读取 data URL，点击可放大预览 */
const thumbnails = ref<Record<string, string>>({})

async function loadThumbnails(): Promise<void> {
  for (const item of agent.selectedAttachments.slice(0, 8)) {
    if (thumbnails.value[item.attachmentId]) continue
    const url = await window.api.attachments.dataUrl(item.attachmentId).catch(() => null)
    if (url) thumbnails.value = { ...thumbnails.value, [item.attachmentId]: url }
  }
}

function previewAttachment(item: { attachmentId: string; name: string; mime: string; size: number }): void {
  const src = thumbnails.value[item.attachmentId]
  if (!src) return
  const size =
    item.size > 1024 * 1024
      ? `${(item.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(item.size / 1024)} KB`
  ui.openImage(src, item.name, `${item.mime} · ${size}`)
}

watch(
  () => agent.selectedAttachments.map((item) => item.attachmentId).join(','),
  () => void loadThumbnails(),
  { immediate: true }
)

function toggleAttach(): void {
  attachOpen.value = !attachOpen.value
  urlOpen.value = false
}

/* ------------------------- 拖入与粘贴文件 ------------------------- */

const dropActive = ref(false)
let dragDepth = 0

function hasFiles(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types.includes('Files'))
}

function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.stopPropagation()
  dragDepth += 1
  dropActive.value = true
}

function onDragOver(event: DragEvent): void {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent): void {
  if (!hasFiles(event)) return
  // 拖出窗口时 relatedTarget 为空，直接收起提示
  if (!event.relatedTarget) {
    dragDepth = 0
    dropActive.value = false
    return
  }
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropActive.value = false
}

/** 图片作为视觉附件，文档作为参考材料；单个文件失败不影响其余文件 */
async function ingestFiles(files: File[]): Promise<void> {
  for (const file of files.slice(0, 6)) {
    try {
      const buffer = await file.arrayBuffer()
      if (file.type.startsWith('image/')) {
        await agent.addAttachmentBytes(file.name || '粘贴的图片.png', file.type, buffer)
      } else {
        await agent.addReferenceBytes(file.name || '参考文件', buffer)
      }
    } catch (error) {
      ui.toast(`${file.name || '文件'} 添加失败：${(error as Error).message}`, 'error', 4200)
    }
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])]
  if (!files.length) return
  event.preventDefault()
  void ingestFiles(files)
}

async function onDrop(event: DragEvent): Promise<void> {
  dragDepth = 0
  dropActive.value = false
  const files = [...(event.dataTransfer?.files ?? [])]
  if (!files.length) return
  event.preventDefault()
  event.stopPropagation()
  await ingestFiles(files)
}

async function pickImages(): Promise<void> {
  attachOpen.value = false
  try {
    await agent.addAttachmentDialog()
  } catch (error) {
    ui.toast((error as Error).message || '添加图片失败', 'error')
  }
}

async function pickFile(): Promise<void> {
  attachOpen.value = false
  try {
    await agent.addReferenceFile()
  } catch (error) {
    ui.toast((error as Error).message || '添加参考文件失败', 'error')
  }
}

function openUrlInput(): void {
  attachOpen.value = false
  urlOpen.value = true
  urlValue.value = ''
}

async function confirmUrl(): Promise<void> {
  const value = urlValue.value.trim()
  if (!value) return
  try {
    await agent.addReferenceWeb(value)
    urlOpen.value = false
    ui.toast('已读取网页正文并加入参考', 'success')
  } catch (error) {
    ui.toast((error as Error).message || '读取网页失败', 'error')
  }
}

async function addCurrentDocument(): Promise<void> {
  attachOpen.value = false
  try {
    await agent.addReferenceDocument()
  } catch (error) {
    ui.toast((error as Error).message || '添加当前文档失败', 'error')
  }
}

async function changeRole(sourceId: string, event: Event): Promise<void> {
  const role = (event.target as HTMLSelectElement).value as ReferenceRole
  try {
    await agent.setSourceRoles(sourceId, [role])
  } catch (error) {
    ui.toast((error as Error).message || '更新用途失败', 'error')
  }
}

function send(): void {
  if (running.value) {
    void agent.cancel()
    return
  }
  if (!agent.prompt.trim()) {
    ui.toast('先写下一点想法，或选择一个快捷指令', 'warning')
    return
  }
  if (!providerReady.value) {
    ui.toast('请先添加模型服务', 'warning')
    ui.modal = 'providers'
    return
  }
  void agent.start()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    send()
  }
}

function usePrompt(text: string): void {
  agent.prompt = text
}

async function submitAnswer(option?: string): Promise<void> {
  const value = (option ?? answerText.value).trim()
  if (!value) return
  await agent.answer(value, option)
  answerText.value = ''
}

function openReview(): void {
  if (!agent.task.proposalId) return
  void agent.openReview(agent.task.proposalId)
}

async function rejectProposal(): Promise<void> {
  if (!agent.task.proposalId) return
  await window.api.changes.reject(agent.task.proposalId)
  ui.toast('已放弃本次建议', 'info')
  agent.task.status = 'cancelled'
  agent.task.phaseLabel = '已放弃'
}

function undoApplied(): void {
  const ok = editorApi.current?.undo() ?? false
  ui.toast(ok ? '已撤销本次编辑' : '没有可撤销的编辑', ok ? 'success' : 'info')
}

function restoreApplied(): void {
  const transactionId = agent.task.applied?.transactionId
  if (!transactionId) return
  void agent.restoreTransaction(transactionId)
}

function retry(): void {
  if (!agent.task.prompt) return
  agent.prompt = agent.task.prompt
  void agent.start()
}

function predict(): void {
  void agent.requestPrediction('manual')
}

async function removePreviewSource(): Promise<void> {
  const source = agent.previewSource
  if (!source) return
  await agent.removeSource(source.sourceId)
  agent.closeSourcePreview()
}

function closePopups(): void {
  attachOpen.value = false
  urlOpen.value = false
}

onMounted(() => document.addEventListener('click', closePopups))
onBeforeUnmount(() => document.removeEventListener('click', closePopups))

watch(
  () => [agent.task.text, agent.task.tools.length, agent.task.clarification, agent.task.status],
  async () => {
    await nextTick()
    if (scrollArea.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight
  }
)
</script>

<template>
  <div class="ai-dock" :class="{ collapsed: ui.aiCollapsed }">
    <div class="ai-grab">
      <button
        :aria-label="ui.aiCollapsed ? '展开 AI 助手' : '收起 AI 助手'"
        :title="ui.aiCollapsed ? '展开 AI 助手' : '收起 AI 助手'"
        @click="ui.toggleAi()"
      >
        <Icon :name="ui.aiCollapsed ? 'chevron-up' : 'chevron-down'" :size="12" />
      </button>
    </div>

    <div class="ai-collapsed">
      <button @click="ui.setAiCollapsed(false)">
        <Icon name="sparkles" :size="14" />
        AI 写作助手
        <span class="muted">改写、整理，让想法更清晰</span>
        <Icon name="chevron-up" :size="13" />
      </button>
    </div>

    <div
      class="ai-expanded"
      :class="{ 'drop-active': dropActive }"
      @paste="onPaste"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div v-if="dropActive" class="drop-hint"><Icon name="upload" :size="16" />松开以添加图片或参考文件</div>
      <div class="ai-topline">
        <span class="ai-label"><Icon name="sparkles" :size="14" />写作助手</span>
        <span class="context-chip">
          <Icon name="file" :size="11" />
          <span>{{ contextTitle }}</span>
          <select v-model="agent.scope" aria-label="AI 作用范围">
            <option value="document">仅此文档</option>
            <option value="selection" :disabled="!hasSelection">选中部分</option>
            <option value="workspace">工作区</option>
          </select>
        </span>
        <span class="ai-privacy"><Icon name="shield" :size="11" />内容由你掌控</span>
      </div>

      <div v-if="hasTask" ref="scrollArea" class="ai-scroll">
        <div class="task-panel">
          <div class="task-head">
            <span class="green-dot" />
            <span>{{ agent.task.documentTitle || '工作区' }}</span>
            <span class="time">{{ agent.task.phaseLabel || '处理中' }}</span>
            <button v-if="!running" class="textbtn clear-task" @click="agent.resetTask()">清空</button>
          </div>

          <div v-if="agent.task.tools.length" class="tool-log">
            <div v-for="tool in agent.task.tools" :key="tool.callId" class="tool-row">
              <Icon
                :name="tool.status === 'running' ? 'loader' : tool.status === 'failed' ? 'warning' : 'check'"
                :class="{ spin: tool.status === 'running' }"
                :size="11"
              />
              <span class="name">{{ tool.title }}</span>
              <span class="summary">{{ tool.summary }}</span>
              <span class="status">{{
                tool.status === 'running' ? '进行中' : tool.status === 'failed' ? '失败' : '完成'
              }}</span>
            </div>
          </div>

          <div v-if="agent.task.text" class="task-text">{{ agent.task.text }}</div>

          <div v-if="agent.task.clarification" class="clarify-box">
            <div class="q">{{ agent.task.clarification.question }}</div>
            <div v-if="agent.task.clarification.options.length" class="clarify-options">
              <button
                v-for="option in agent.task.clarification.options"
                :key="option"
                class="ghostbtn"
                @click="submitAnswer(option)"
              >
                {{ option }}
              </button>
            </div>
            <div class="clarify-input">
              <input
                v-model="answerText"
                type="text"
                placeholder="输入你的回答…"
                aria-label="澄清回答"
                @keydown.enter.prevent="submitAnswer()"
              />
              <button class="darkbtn" @click="submitAnswer()">回答</button>
            </div>
          </div>

          <div v-if="agent.task.status === 'reviewing' && agent.task.proposalId" class="task-result">
            <span class="title">修改建议已准备好</span>
            <span class="meta">目标：{{ agent.task.documentTitle }} · 需确认后才会写入</span>
            <div class="task-actions">
              <button class="darkbtn" @click="openReview"><Icon name="eye" :size="12" />查看差异</button>
              <button class="textbtn" @click="rejectProposal">放弃</button>
            </div>
          </div>

          <div v-if="agent.task.applied" class="task-result">
            <span class="title">{{ agent.task.applied.message }}</span>
            <span class="meta"
              >状态：{{ agent.task.applied.status === 'applied' ? '已应用' : '部分应用' }}</span
            >
            <div class="task-actions">
              <button class="ghostbtn" @click="undoApplied">撤销编辑</button>
              <button v-if="agent.task.applied.transactionId" class="ghostbtn" @click="restoreApplied">
                恢复快照
              </button>
            </div>
          </div>

          <div v-if="agent.task.error" class="task-error">
            {{ agent.task.error.message }}
            <button v-if="agent.task.error.retryable" class="textbtn" @click="retry">重试</button>
          </div>
        </div>
      </div>

      <div v-if="agent.selectedAttachments.length || agent.selectedSources.length" class="chips">
        <span v-for="item in agent.selectedAttachments" :key="item.attachmentId" class="chip attachment-chip">
          <button
            class="chip-thumb"
            :title="`预览 ${item.name}`"
            :aria-label="`预览 ${item.name}`"
            @click="previewAttachment(item)"
          >
            <img v-if="thumbnails[item.attachmentId]" :src="thumbnails[item.attachmentId]" :alt="item.name" />
            <Icon v-else name="image" :size="10" />
          </button>
          <button class="chip-title" :title="`预览 ${item.name}`" @click="previewAttachment(item)">
            {{ item.name }}
          </button>
          <button class="x" aria-label="移除附件" @click="agent.toggleAttachment(item.attachmentId)">
            <Icon name="x" :size="9" />
          </button>
        </span>
        <span v-for="source in agent.selectedSources" :key="source.sourceId" class="chip">
          <Icon
            :name="source.kind === 'web' ? 'globe' : source.kind === 'image' ? 'image' : 'file'"
            :size="10"
          />
          <button
            class="chip-title"
            :title="`查看 ${source.title} 的片段`"
            @click.stop="agent.openSourcePreview(source.sourceId)"
          >
            {{ source.title }}
          </button>
          <select
            :value="source.roles[0]"
            class="role-select"
            aria-label="参考用途"
            @change="changeRole(source.sourceId, $event)"
          >
            <option v-for="role in roleOptions" :key="role.value" :value="role.value">
              {{ role.label }}
            </option>
          </select>
          <button class="x" aria-label="移除参考" @click="agent.toggleSource(source.sourceId)">
            <Icon name="x" :size="9" />
          </button>
        </span>
      </div>

      <textarea
        v-model="agent.prompt"
        class="ai-input"
        :placeholder="'让 AI 帮你整理思路、润色文字，或从这里开始写作…'"
        aria-label="向 AI 提问"
        @keydown="onKeydown"
      />

      <div class="ai-bottom">
        <button
          class="iconbtn"
          title="添加参考（可直接拖入或粘贴图片/文件）"
          aria-label="添加参考"
          @click.stop="toggleAttach"
        >
          <Icon name="plus" :size="15" />
        </button>
        <div class="provider-control">
          <span class="online-dot" :class="{ off: !providerReady }" />
          <select
            v-model="agent.selectedProviderId"
            aria-label="模型来源"
            @change="agent.setProvider(agent.selectedProviderId)"
          >
            <option v-if="!agent.providers.length" value="">未配置模型</option>
            <option
              v-for="provider in agent.providers"
              :key="provider.providerId"
              :value="provider.providerId"
            >
              {{ provider.name }} · {{ provider.model }}
            </option>
          </select>
          <Icon name="chevron-down" :size="10" />
        </div>
        <span class="ai-shortcut">Enter 发送 · Shift Enter 换行</span>
        <button
          class="send-btn"
          :class="{ stop: running }"
          :title="running ? '停止任务' : '发送'"
          :aria-label="running ? '停止任务' : '发送'"
          @click="send"
        >
          <Icon :name="running ? 'stop' : 'arrow-up'" :size="15" />
        </button>
      </div>

      <div class="quick-prompts">
        <button @click="usePrompt('帮我润色当前文档的开头')">润色文字</button>
        <button @click="usePrompt('为当前文档提炼一段摘要')">提炼摘要</button>
        <button @click="usePrompt('根据当前文档继续写作，延续现有语气')">继续写作</button>
        <button class="predict-btn" :disabled="!settings.settings.prediction.enabled" @click="predict">
          <Icon name="wand" :size="11" />续写一句
        </button>
      </div>

      <div v-if="attachOpen" class="attach-popup" @click.stop>
        <button @click="pickImages">
          <Icon name="image" :size="14" />添加图片<span>PNG / JPEG / WebP</span>
        </button>
        <button @click="pickFile">
          <Icon name="file" :size="14" />参考文件<span>MD / TXT / DOCX / PDF</span>
        </button>
        <button @click="addCurrentDocument">
          <Icon name="file-plus" :size="14" />当前文档<span>作为事实依据</span>
        </button>
        <button @click="openUrlInput">
          <Icon name="globe" :size="14" />网页链接<span>只读取公开正文</span>
        </button>
      </div>

      <div v-if="urlOpen" class="attach-popup url-popup" @click.stop>
        <label>读取公开网页作为参考</label>
        <input
          v-model="urlValue"
          type="url"
          placeholder="https://example.com/article"
          @keydown.enter.prevent="confirmUrl"
        />
        <div class="url-actions">
          <button class="textbtn" @click="urlOpen = false">取消</button>
          <button class="darkbtn" @click="confirmUrl">读取</button>
        </div>
        <p>仅获取正文文本，不加载脚本，不携带登录信息。</p>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="agent.previewOpen && agent.previewSource"
        class="modal-backdrop"
        @click.self="agent.closeSourcePreview()"
      >
        <section
          class="modal narrow source-preview"
          role="dialog"
          aria-modal="true"
          aria-label="参考材料片段"
        >
          <div class="modal-title">
            <div>
              <span class="eyebrow">SOURCE PREVIEW</span>
              <h2>{{ agent.previewSource.title }}</h2>
              <p>
                {{ agent.previewSource.kind.toUpperCase() }} · {{ agent.previewSource.chunkCount }} 个片段 ·
                {{ agent.previewSource.status === 'ready' ? '已就绪' : agent.previewSource.status }}
              </p>
            </div>
            <button class="iconbtn" aria-label="关闭" @click="agent.closeSourcePreview()">
              <Icon name="x" :size="15" />
            </button>
          </div>
          <p v-if="agent.previewSource.message" class="source-message">{{ agent.previewSource.message }}</p>
          <div class="source-chunks">
            <div v-for="chunk in agent.previewChunks" :key="chunk.chunkId" class="source-chunk">
              <span class="source-label"
                >{{ chunk.label }}<span v-if="chunk.uncertain" class="tag">待核对</span></span
              >
              <p>{{ chunk.text }}</p>
            </div>
            <p v-if="!agent.previewChunks.length" class="empty-hint">没有可展示的片段。</p>
          </div>
          <div class="modal-footer">
            <span class="note">片段按章节/页/段落切分，引用会定位到这些范围。</span>
            <div class="source-actions">
              <button class="ghostbtn" @click="removePreviewSource()">移除参考</button>
              <button class="darkbtn" @click="agent.closeSourcePreview()">完成</button>
            </div>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  padding: 2px 0 6px;
}

.chip .role-select {
  border: 0;
  background: transparent;
  font-size: 9px;
  color: var(--muted);
  max-width: 72px;
}

.clarify-input {
  display: flex;
  gap: 8px;
}

.clarify-input input {
  flex: 1;
  height: 30px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 9px;
  font-size: 11px;
  background: var(--page);
}

.attach-popup {
  position: absolute;
  bottom: 96px;
  left: 16px;
  z-index: 30;
  min-width: 220px;
  border: 1px solid var(--line);
  background: var(--card);
  border-radius: 9px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
  padding: 6px;
}

.attach-popup button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  border-radius: 5px;
  font-size: 11px;
  text-align: left;
}

.attach-popup button span {
  margin-left: auto;
  font-size: 9px;
  color: var(--muted);
}

.url-popup {
  width: 300px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.url-popup label {
  font-size: 10px;
  color: var(--soft);
}

.url-popup input {
  height: 30px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 9px;
  font-size: 11px;
  background: var(--page);
}

.url-popup p {
  margin: 0;
  font-size: 9px;
  color: var(--muted);
}

.url-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.predict-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.quick-prompts {
  align-items: center;
}

.chip-title {
  border: 0;
  background: transparent;
  padding: 0;
  font-size: 9px;
  color: inherit;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--page);
  overflow: hidden;
  cursor: zoom-in;
}

.chip-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.clear-task {
  margin-left: 6px;
  font-size: 9px;
}

.chip-title:hover {
  background: transparent;
  color: var(--accent);
}

.source-preview {
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
}

.source-message {
  font-size: 10px;
  color: #9a6a3f;
  margin: 0 0 10px;
}

.source-chunks {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}

.source-chunk {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--side);
}

.source-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  color: var(--muted);
  margin-bottom: 6px;
}

.source-chunk p {
  margin: 0;
  font-size: 11px;
  line-height: 1.8;
  color: var(--soft);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 140px;
  overflow: hidden;
}

.empty-hint {
  font-size: 11px;
  color: var(--muted);
}

.source-actions {
  display: flex;
  gap: 10px;
}
</style>
