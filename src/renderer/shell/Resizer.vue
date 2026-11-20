<script setup lang="ts">
/**
 * 可拖动的面板分隔条：左右侧栏独立调宽，双击恢复默认。
 */
import { onBeforeUnmount } from 'vue'
import { useUiStore } from '../stores/ui'

const props = defineProps<{ side: 'left' | 'right' }>()
const ui = useUiStore()
let dragging = false

function onPointerDown(event: PointerEvent): void {
  dragging = true
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return
  if (props.side === 'left') ui.setLeftWidth(event.clientX)
  else ui.setRightWidth(window.innerWidth - event.clientX)
}

function onPointerUp(): void {
  dragging = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
}

function reset(): void {
  if (props.side === 'left') ui.setLeftWidth(244)
  else ui.setRightWidth(238)
}

onBeforeUnmount(onPointerUp)
</script>

<template>
  <div
    class="resizer"
    :class="`${side}-resizer`"
    role="separator"
    aria-label="调整侧栏宽度"
    :aria-orientation="'vertical'"
    tabindex="0"
    @pointerdown.prevent="onPointerDown"
    @dblclick="reset"
  />
</template>
