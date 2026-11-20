<script setup lang="ts">
/**
 * 分屏预览：防抖渲染 + Mermaid 异步增强 + 比例滚动同步。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { hydrateMermaid, renderMarkdown } from '../lib/markdown'

const props = defineProps<{ text: string; documentId: string | null }>()
const emit = defineEmits<{ scroll: [ratio: number] }>()

const settings = useSettingsStore()
const scroller = ref<HTMLElement | null>(null)
const html = ref('')
let renderTimer = 0

function render(): void {
  html.value = renderMarkdown(props.text, {
    documentId: props.documentId,
    loadRemoteImages: settings.settings.editor.loadRemoteImages
  })
  void nextTick(async () => {
    if (!scroller.value) return
    await hydrateMermaid(scroller.value, settings.isDark)
  })
}

function scheduleRender(): void {
  window.clearTimeout(renderTimer)
  renderTimer = window.setTimeout(render, 160)
}

watch(() => props.text, scheduleRender)
watch(() => props.documentId, render)
watch(() => settings.settings.editor.loadRemoteImages, render)
watch(() => settings.isDark, render)
watch(
  () => settings.activeTheme.themeId,
  () => {
    // 主题 CSS 由全局样式注入，无需重渲染
  }
)

onMounted(render)
onBeforeUnmount(() => window.clearTimeout(renderTimer))

function onScroll(): void {
  const element = scroller.value
  if (!element) return
  const max = Math.max(1, element.scrollHeight - element.clientHeight)
  emit('scroll', element.scrollTop / max)
}

function onClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href') ?? ''
  if (href.startsWith('#')) {
    // 标题 ID / 目录：在预览容器内跳转，避免把渲染进程导航走
    event.preventDefault()
    const id = href.slice(1)
    if (!id || !scroller.value) return
    const target = scroller.value.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }
  if (/^https?:\/\//i.test(href)) {
    event.preventDefault()
    void window.api.app.openExternal(href)
  }
}

defineExpose({
  /** 接受编辑器的滚动比例，将预览定位到对应的相对高度。 */
  setScrollRatio(ratio: number) {
    const element = scroller.value
    if (!element) return
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    element.scrollTop = max * Math.min(1, Math.max(0, ratio))
  }
})
</script>

<template>
  <div ref="scroller" class="preview-pane" @scroll.passive="onScroll" @click="onClick">
    <article
      class="markdown-body"
      :data-doc-theme="settings.activeTheme.cssScopeId ?? undefined"
      v-html="html"
    />
  </div>
</template>
