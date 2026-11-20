<script setup lang="ts">
/**
 * 模型服务设置：本地 / 自定义远程 / 官方兼容接口 + 内置演示。
 * 密钥只交给主进程安全存储，不在界面回显。
 */
import { computed, onMounted, ref } from 'vue'
import type {
  ConnectionResult,
  ModelCapabilities,
  ProviderConfig,
  ProviderInput,
  ProviderKind
} from '@shared/types'
import { useAgentStore } from '../stores/agent'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'

const agent = useAgentStore()
const settings = useSettingsStore()
const ui = useUiStore()

const editing = ref<ProviderInput | null>(null)
const apiKey = ref('')
const testing = ref<string | null>(null)
const results = ref<Record<string, ConnectionResult>>({})
const saving = ref(false)

const capabilityLabels: Array<{ key: keyof ModelCapabilities; label: string; hint: string }> = [
  { key: 'text', label: '文本生成', hint: '基础能力' },
  { key: 'vision', label: '视觉输入', hint: '读取图片（需模型支持）' },
  { key: 'toolCalling', label: '工具调用', hint: '文档 Agent 必需' },
  { key: 'structuredOutput', label: '结构化输出', hint: '严格 JSON 约束' },
  { key: 'streaming', label: '流式响应', hint: '逐字展示进度' }
]

const presets: Array<{ label: string; apply: () => void }> = [
  {
    label: 'DeepSeek',
    apply: () => {
      editing.value = {
        name: 'DeepSeek',
        kind: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        capabilities: {
          text: true,
          streaming: true,
          toolCalling: true,
          structuredOutput: false,
          vision: true
        }
      }
      apiKey.value = ''
    }
  },
  {
    label: 'Ollama 本地',
    apply: () => {
      editing.value = {
        name: 'Ollama 本地',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        capabilities: {
          text: true,
          streaming: true,
          toolCalling: true,
          structuredOutput: false,
          vision: false
        }
      }
      apiKey.value = ''
    }
  },
  {
    label: 'OpenAI 官方',
    apply: () => {
      editing.value = {
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1-mini',
        capabilities: { text: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true }
      }
      apiKey.value = ''
    }
  },
  {
    label: 'LM Studio',
    apply: () => {
      editing.value = {
        name: 'LM Studio',
        kind: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        capabilities: {
          text: true,
          streaming: true,
          toolCalling: false,
          structuredOutput: false,
          vision: false
        }
      }
      apiKey.value = ''
    }
  }
]

const encryptionNote = computed(() => {
  const info = settings.appInfo
  if (!info) return ''
  return info.safeStorage.available
    ? `密钥通过 ${info.safeStorage.backend} 加密保存。`
    : '系统安全存储不可用：密钥只保留在本次会话，不会写入磁盘。'
})

function startCreate(): void {
  editing.value = {
    name: '',
    kind: 'openai',
    baseUrl: '',
    model: '',
    capabilities: { text: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false }
  }
  apiKey.value = ''
}

function startEdit(config: ProviderConfig): void {
  editing.value = {
    providerId: config.providerId,
    name: config.name,
    kind: config.kind,
    baseUrl: config.baseUrl,
    model: config.model,
    capabilities: { ...config.capabilities },
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {})
  }
  apiKey.value = ''
}

function cancel(): void {
  editing.value = null
  apiKey.value = ''
}

async function save(): Promise<void> {
  if (!editing.value) return
  saving.value = true
  try {
    // 逐字段构造普通对象：响应式代理无法通过 IPC 的结构化克隆
    const current = editing.value
    const caps = current.capabilities
    const input: ProviderInput = {
      name: current.name,
      kind: current.kind,
      baseUrl: current.baseUrl,
      model: current.model,
      capabilities: {
        text: caps?.text ?? true,
        vision: caps?.vision ?? false,
        toolCalling: caps?.toolCalling ?? false,
        structuredOutput: caps?.structuredOutput ?? false,
        streaming: caps?.streaming ?? true
      }
    }
    if (current.providerId) input.providerId = current.providerId
    if (current.temperature !== undefined) input.temperature = current.temperature
    if (current.maxOutputTokens !== undefined) input.maxOutputTokens = current.maxOutputTokens
    if (apiKey.value.trim()) input.apiKey = apiKey.value.trim()
    if (input.kind === 'mock') input.baseUrl = input.baseUrl || 'mock://local'
    const saved = await window.api.providers.save(input)
    await agent.refreshProviders()
    agent.setProvider(saved.providerId)
    editing.value = null
    apiKey.value = ''
    ui.toast('模型配置已保存', 'success')
  } catch (error) {
    ui.toast((error as Error).message || '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

async function test(config: ProviderConfig): Promise<void> {
  testing.value = config.providerId
  try {
    results.value = {
      ...results.value,
      [config.providerId]: await window.api.providers.test(config.providerId)
    }
  } catch (error) {
    results.value = {
      ...results.value,
      [config.providerId]: {
        ok: false,
        latencyMs: 0,
        message: (error as Error).message,
        capabilities: config.capabilities
      }
    }
  } finally {
    testing.value = null
  }
}

async function setDefault(config: ProviderConfig): Promise<void> {
  await window.api.providers.setDefault(config.providerId)
  await agent.refreshProviders()
  agent.setProvider(config.providerId)
  ui.toast(`默认模型已切换为 ${config.name}`, 'success')
}

async function remove(config: ProviderConfig): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: '删除模型配置',
    message: `将删除《${config.name}》及其保存的密钥。`,
    confirmText: '删除',
    danger: true
  })
  if (!confirmed) return
  await window.api.providers.remove(config.providerId)
  await agent.refreshProviders()
  ui.toast('已删除', 'success')
}

const kindLabels: Record<ProviderKind, string> = {
  mock: '内置演示',
  openai: 'OpenAI 兼容',
  ollama: '本地 Ollama',
  custom: '自定义远程'
}

onMounted(() => {
  void settings.refreshAppInfo()
})
</script>

<template>
  <div class="modal-backdrop" @click.self="ui.modal = null">
    <section class="modal wide" role="dialog" aria-modal="true" aria-label="模型服务">
      <div class="modal-title">
        <div>
          <span class="eyebrow">MODEL PROVIDERS</span>
          <h2>连接你信任的模型</h2>
          <p>使用你自己的密钥；应用不提供模型额度，也不会上传未授权的内容。</p>
        </div>
        <button class="iconbtn" aria-label="关闭" @click="ui.modal = null">
          <Icon name="x" :size="15" />
        </button>
      </div>

      <div class="provider-list">
        <div v-for="config in agent.providers" :key="config.providerId" class="provider-card">
          <div class="provider-main">
            <div class="provider-title">
              <b>{{ config.name }}</b>
              <span class="tag">{{ kindLabels[config.kind] }}</span>
              <span v-if="config.isDefault" class="tag accent">默认</span>
            </div>
            <div class="provider-meta">
              <span>{{ config.model }}</span>
              <span>{{ config.baseUrl }}</span>
              <span>{{
                config.hasSecret ? '密钥已保存' : config.kind === 'mock' ? '无需密钥' : '无密钥'
              }}</span>
            </div>
            <div class="capabilities">
              <span
                v-for="item in capabilityLabels"
                :key="item.key"
                class="cap"
                :class="{ on: config.capabilities[item.key] }"
                :title="item.hint"
              >
                {{ item.label }}
              </span>
            </div>
            <div
              v-if="results[config.providerId]"
              class="test-result"
              :class="{ bad: !results[config.providerId].ok }"
            >
              {{ results[config.providerId].ok ? '连接成功' : '连接失败' }} ·
              {{ results[config.providerId].latencyMs }}ms ·
              {{ results[config.providerId].message }}
              <template v-if="results[config.providerId].models?.length">
                · 模型 {{ results[config.providerId].models!.slice(0, 5).join(', ') }}
              </template>
            </div>
          </div>
          <div class="provider-actions">
            <button class="textbtn" :disabled="testing === config.providerId" @click="test(config)">
              {{ testing === config.providerId ? '测试中…' : '测试连接' }}
            </button>
            <button class="textbtn" @click="startEdit(config)">编辑</button>
            <button class="textbtn" :disabled="config.isDefault" @click="setDefault(config)">设为默认</button>
            <button class="textbtn danger" @click="remove(config)">删除</button>
          </div>
        </div>
        <div v-if="!agent.providers.length" class="empty-state">
          <Icon name="server" :size="24" />
          <p>还没有模型配置。添加一个本地或远程服务开始使用文档助手。</p>
        </div>
      </div>

      <div class="add-row">
        <button class="darkbtn" @click="startCreate"><Icon name="plus" :size="12" />添加配置</button>
        <div class="presets">
          <span>快速填入：</span>
          <button v-for="preset in presets" :key="preset.label" class="preset" @click="preset.apply()">
            {{ preset.label }}
          </button>
        </div>
      </div>

      <form v-if="editing" class="provider-form" @submit.prevent="save">
        <div class="settings-label">
          配置详情<span>{{ encryptionNote }}</span>
        </div>
        <div class="field-row">
          <div class="field">
            <label>名称</label>
            <input v-model="editing.name" type="text" placeholder="例如：DeepSeek" required />
          </div>
          <div class="field">
            <label>服务类型</label>
            <select v-model="editing.kind">
              <option value="openai">OpenAI 兼容（官方 / 第三方）</option>
              <option value="ollama">本地 Ollama</option>
              <option value="custom">自定义远程</option>
              <option value="mock">内置演示（离线）</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>服务地址</label>
            <input
              v-model="editing.baseUrl"
              type="text"
              placeholder="https://api.deepseek.com/v1"
              :disabled="editing.kind === 'mock'"
            />
            <span class="hint">OpenAI 兼容接口应包含 /v1；本地服务示例 http://127.0.0.1:11434/v1</span>
          </div>
          <div class="field">
            <label>模型名称</label>
            <input v-model="editing.model" type="text" placeholder="deepseek-chat" required />
          </div>
        </div>
        <div class="field">
          <label>API Key</label>
          <input
            v-model="apiKey"
            type="password"
            autocomplete="off"
            :placeholder="editing.providerId ? '留空表示保持现有密钥' : 'sk-…'"
            :disabled="editing.kind === 'mock'"
          />
          <span class="hint">密钥由主进程保管，不会进入渲染进程的持久化配置或日志。</span>
        </div>
        <div class="field">
          <label>能力声明</label>
          <div class="capability-grid">
            <label v-for="item in capabilityLabels" :key="item.key" class="checkbox">
              <input v-model="editing.capabilities![item.key]" type="checkbox" />
              {{ item.label }}<small>{{ item.hint }}</small>
            </label>
          </div>
        </div>
        <div class="form-footer">
          <button type="button" class="ghostbtn" @click="cancel">取消</button>
          <button type="submit" class="darkbtn" :disabled="saving">
            {{ saving ? '保存中…' : '保存配置' }}
          </button>
        </div>
      </form>

      <div class="modal-footer">
        <span class="note">工具调用与视觉能力需按实际模型逐项确认；能力不足时任务会明确降级。</span>
        <button class="darkbtn" @click="ui.modal = null">完成</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 20px;
}

.provider-card {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 12px 14px;
  display: flex;
  gap: 14px;
  justify-content: space-between;
  align-items: flex-start;
}

.provider-main {
  min-width: 0;
  flex: 1;
}

.provider-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.provider-meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--muted);
  margin-top: 5px;
}

.capabilities {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.cap {
  font-size: 9px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--muted);
  text-decoration: line-through;
}

.cap.on {
  color: color-mix(in srgb, var(--accent) 75%, var(--text));
  border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
  text-decoration: none;
}

.test-result {
  margin-top: 8px;
  font-size: 10px;
  color: color-mix(in srgb, var(--accent) 70%, var(--soft));
  line-height: 1.6;
}

.test-result.bad {
  color: #9a4a38;
}

.provider-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
  flex-shrink: 0;
}

.provider-actions .textbtn {
  font-size: 10px;
}

.provider-actions .danger {
  color: #9a4a38;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.presets {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--muted);
  flex-wrap: wrap;
}

.preset {
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 4px 8px;
  font-size: 10px;
  color: var(--soft);
}

.provider-form {
  margin-top: 8px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}

.capability-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 10px 12px;
}

.capability-grid .checkbox {
  font-size: 11px;
}

.capability-grid small {
  color: var(--muted);
  font-size: 9px;
  margin-left: 4px;
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
</style>
