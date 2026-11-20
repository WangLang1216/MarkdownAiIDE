<script setup lang="ts">
/** 轻量提示队列 */
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <div v-for="item in ui.toasts" :key="item.id" class="toast" :class="item.tone">
      {{ item.message }}
    </div>
  </div>
</template>
