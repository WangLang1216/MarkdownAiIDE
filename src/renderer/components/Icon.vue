<script setup lang="ts">
/** 统一图标组件：内联 SVG，颜色与尺寸由父级样式控制 */
import { computed } from 'vue'
import { ICON_PATHS } from '../lib/icons'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 17 })
const path = computed(() => ICON_PATHS[props.name] ?? ICON_PATHS.file)
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    :style="{ width: `${size}px`, height: `${size}px` }"
    v-html="path"
  />
</template>
