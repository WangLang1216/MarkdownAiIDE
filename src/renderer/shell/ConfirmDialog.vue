<script setup lang="ts">
/** 通用确认对话框：删除、关闭未保存文稿、恢复冲突等场景 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()

function cancel(): void {
  ui.resolveConfirm(false)
}

function confirm(): void {
  ui.resolveConfirm(true)
}

function onKeydown(event: KeyboardEvent): void {
  if (!ui.confirmState) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    confirm()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="ui.confirmState" class="modal-backdrop" @click.self="cancel">
    <section class="modal narrow" role="dialog" aria-modal="true" :aria-label="ui.confirmState.title">
      <div class="modal-title">
        <div>
          <h2>{{ ui.confirmState.title }}</h2>
          <p>{{ ui.confirmState.message }}</p>
        </div>
      </div>
      <div class="modal-footer">
        <span class="note">按 Esc 取消</span>
        <div class="actions">
          <button class="ghostbtn" @click="cancel">取消</button>
          <button class="darkbtn" :class="{ danger: ui.confirmState.danger }" @click="confirm">
            {{ ui.confirmState.confirmText }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.modal-title h2 {
  margin-bottom: 12px;
}

.modal-title p {
  line-height: 1.8;
}

.actions {
  display: flex;
  gap: 10px;
}

.darkbtn.danger {
  background: #8d4436;
}

.darkbtn.danger:hover {
  background: #a5533f;
}

:root[data-theme='dark'] .darkbtn.danger {
  background: #c47f6e;
  color: #2a1b17;
}
</style>
