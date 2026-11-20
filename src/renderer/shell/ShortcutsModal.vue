<script setup lang="ts">
/** 快捷键、运行环境与数据位置说明 */
import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'

const settings = useSettingsStore()
const ui = useUiStore()

const shortcuts = computed(() => [
  { keys: 'Ctrl N', label: '新建文稿' },
  { keys: 'Ctrl O', label: '打开 Markdown' },
  { keys: 'Ctrl S', label: '保存' },
  { keys: 'Ctrl Shift S', label: '另存为' },
  { keys: 'Ctrl W', label: '关闭标签' },
  { keys: 'Ctrl F', label: '查找与替换' },
  { keys: 'Ctrl K', label: '搜索元素' },
  { keys: 'Ctrl B / I', label: '加粗 / 斜体' },
  { keys: 'Ctrl Z / Shift Z', label: '撤销 / 重做' },
  { keys: 'Tab', label: '接受 AI 续写候选' },
  { keys: 'Esc', label: '忽略候选 / 关闭弹层' },
  { keys: 'Ctrl 缩放', label: '调整缩放（状态栏）' }
])

function openUserData(): void {
  void window.api.app.openUserData()
}

const env = computed(() => {
  const info = settings.appInfo
  if (!info) return []
  return [
    { label: 'Electron', value: info.electron },
    { label: 'Chromium', value: info.chrome },
    { label: 'Node', value: info.node },
    { label: '系统', value: info.platform },
    {
      label: '凭据存储',
      value: info.safeStorage.available ? info.safeStorage.backend : '不可用（仅本次会话）'
    },
    { label: 'Pandoc', value: info.pandoc.available ? (info.pandoc.version ?? '可用') : '未安装' }
  ]
})
</script>

<template>
  <div class="modal-backdrop" @click.self="ui.modal = null">
    <section class="modal" role="dialog" aria-modal="true" aria-label="快捷键与运行环境">
      <div class="modal-title">
        <div>
          <span class="eyebrow">REFERENCE</span>
          <h2>快捷键与运行环境</h2>
          <p>键盘优先的写作流程；所有文稿保存在本地。</p>
        </div>
        <button class="iconbtn" aria-label="关闭" @click="ui.modal = null">
          <Icon name="x" :size="15" />
        </button>
      </div>

      <div class="shortcut-grid">
        <div v-for="item in shortcuts" :key="item.keys" class="shortcut-row">
          <span>{{ item.label }}</span>
          <kbd>{{ item.keys }}</kbd>
        </div>
      </div>

      <div class="settings-label">运行信息</div>
      <div class="env-grid">
        <div v-for="item in env" :key="item.label" class="env-row">
          <span>{{ item.label }}</span>
          <b>{{ item.value }}</b>
        </div>
      </div>

      <div class="data-row">
        <div>
          <b>本地数据目录</b>
          <small>{{ settings.appInfo?.userDataPath ?? '—' }}</small>
        </div>
        <button class="ghostbtn" @click="openUserData()"><Icon name="folder-open" :size="13" />打开</button>
      </div>

      <div class="modal-footer">
        <span class="note"
          >小彭友 v{{ settings.appInfo?.version ?? '1.0.0' }} · MIT 许可 · 不建立账号与云同步</span
        >
        <button class="darkbtn" @click="ui.modal = null">完成</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.shortcut-grid {
  margin-top: 22px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 22px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  font-size: 11px;
  color: var(--soft);
  padding: 6px 0;
  border-bottom: 1px dashed var(--line);
}

.shortcut-row kbd {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 2px 6px;
  background: var(--side);
}

.env-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 22px;
}

.env-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted);
  padding: 4px 0;
}

.env-row b {
  color: var(--soft);
  font-weight: 500;
}

.data-row {
  margin-top: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--side);
}

.data-row b {
  display: block;
  font-size: 11px;
  font-weight: 500;
}

.data-row small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-top: 4px;
  word-break: break-all;
}

.data-row .ghostbtn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
</style>
