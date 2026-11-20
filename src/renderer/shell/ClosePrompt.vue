<script setup lang="ts">
/**
 * 关闭窗口询问：最小化到托盘还是退出程序，可记住选择。
 * 由主进程的 close 事件触发，用户取消时窗口保持打开。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'

const ui = useUiStore()
const visible = ref(false)
const remember = ref(false)
const busy = ref(false)
let unsubscribe: (() => void) | null = null

function onKeydown(event: KeyboardEvent): void {
  if (visible.value && event.key === 'Escape') {
    event.preventDefault()
    visible.value = false
  }
}

onMounted(() => {
  unsubscribe = window.api.on.closeRequested(() => {
    remember.value = false
    visible.value = true
  })
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  window.removeEventListener('keydown', onKeydown)
})

async function choose(action: 'tray' | 'quit'): Promise<void> {
  if (busy.value) return
  busy.value = true
  visible.value = false
  try {
    await window.api.app.resolveClose(action, remember.value)
  } catch (error) {
    ui.toast((error as Error).message || '关闭操作未完成', 'error')
    visible.value = true
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="visible" class="modal-backdrop" @click.self="visible = false">
    <section class="modal narrow close-prompt" role="dialog" aria-modal="true" aria-label="关闭小彭友">
      <div class="modal-title">
        <div>
          <span class="eyebrow">BEFORE YOU GO</span>
          <h2>要关闭小彭友吗？</h2>
          <p>最小化到托盘后，文稿与进行中的 AI 任务都会保留，随时可以从托盘恢复。</p>
        </div>
      </div>

      <div class="close-choices">
        <button class="choice" :disabled="busy" @click="choose('tray')">
          <span class="choice-icon"><Icon name="minus" :size="16" /></span>
          <span>
            <b>最小化到托盘</b>
            <small>后台继续运行，点击托盘图标即可恢复窗口</small>
          </span>
        </button>
        <button class="choice quit" :disabled="busy" @click="choose('quit')">
          <span class="choice-icon"><Icon name="power" :size="16" /></span>
          <span>
            <b>退出程序</b>
            <small>结束所有任务并释放窗口，未保存内容会写入恢复区</small>
          </span>
        </button>
      </div>

      <label class="checkbox remember">
        <input v-model="remember" type="checkbox" />
        记住我的选择，下次不再询问
      </label>

      <div class="modal-footer">
        <span class="note">按 Esc 继续编辑</span>
        <div class="actions">
          <button class="ghostbtn" @click="visible = false">取消</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.close-prompt {
  width: min(520px, calc(100vw - 60px));
}

.close-choices {
  display: grid;
  gap: 10px;
  margin-top: 18px;
}

.choice {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--page);
  text-align: left;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.choice:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--selection) 45%, var(--page));
}

.choice:disabled {
  opacity: 0.6;
  cursor: default;
}

.choice-icon {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--selection) 60%, var(--card));
  color: color-mix(in srgb, var(--accent) 70%, var(--text));
  flex: none;
}

.choice.quit .choice-icon {
  background: color-mix(in srgb, #8d4436 12%, var(--card));
  color: #8d4436;
}

.choice b {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.choice small {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  line-height: 1.6;
  color: var(--muted);
}

.remember {
  margin-top: 16px;
}

.actions {
  display: flex;
  gap: 10px;
}
</style>
