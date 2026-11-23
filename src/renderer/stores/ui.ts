/**
 * 界面状态：布局宽度、面板可见性、编辑模式、锁定、缩放、弹窗与轻量提示。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ContentWidth, EditorMode } from '../types'

/** 限定界面状态库可切换的弹窗类型。 */
export type ModalName = 'appearance' | 'providers' | 'shortcuts' | 'review' | 'about' | 'update' | null

/** 保存图片预览弹窗需要的图像地址和说明。 */
export interface ImagePreviewState {
  /** 预览弹窗直接显示的图片地址。 */
  src: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 供图片预览显示的类型或大小等补充信息。 */
  meta?: string
}

interface ToastItem {
  id: number
  message: string
  tone: 'info' | 'success' | 'warning' | 'error'
}

interface ConfirmState {
  title: string
  message: string
  confirmText: string
  danger: boolean
  resolve: (value: boolean) => void
}

const readNumber = (key: string, fallback: number, min: number, max: number): number => {
  const raw = localStorage.getItem(key)
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** 只接受已知宽度档位，历史脏数据回落到默认居中 */
function readContentWidth(): ContentWidth {
  const raw = localStorage.getItem('moye.contentWidth')
  return raw === 'full' || raw === 'narrow' ? raw : 'default'
}

/** 维护面板布局、弹窗、提示和界面交互偏好。 */
export const useUiStore = defineStore('ui', () => {
  const leftWidth = ref(readNumber('moye.leftWidth', 244, 190, 380))
  const rightWidth = ref(readNumber('moye.rightWidth', 238, 170, 420))
  const leftTab = ref<'elements' | 'files'>(
    (localStorage.getItem('moye.leftTab') as 'elements' | 'files') || 'elements'
  )
  const outlineVisible = ref(localStorage.getItem('moye.outline') !== '0')
  const focusMode = ref(false)
  const aiCollapsed = ref(localStorage.getItem('moye.aiCollapsed') === '1')
  const mode = ref<EditorMode>((localStorage.getItem('moye.mode') as EditorMode) || 'live')
  const contentWidth = ref<ContentWidth>(readContentWidth())
  // 锁定只作用于当次阅读：不持久化，打开或切换文稿时由 App 重置
  const locked = ref(false)
  const zoom = ref(readNumber('moye.zoom', 100, 80, 140))
  const modal = ref<ModalName>(null)
  const toasts = ref<ToastItem[]>([])
  const confirmState = ref<ConfirmState | null>(null)
  const reviewOpen = ref(false)
  const findOpen = ref(false)
  const imagePreview = ref<ImagePreviewState | null>(null)
  const outlineJump = ref<{ from: number; to: number } | null>(null)
  const cursorLine = ref(1)
  const cursorOffset = ref(0)
  const selectionFrom = ref(0)
  const selectionTo = ref(0)
  const scrollRatio = ref(0)
  let toastSeq = 0

  const workspaceClass = computed(() => ({
    focus: focusMode.value,
    'outline-hidden': !outlineVisible.value
  }))

  function setLeftWidth(value: number): void {
    leftWidth.value = Math.min(380, Math.max(190, value))
    localStorage.setItem('moye.leftWidth', String(Math.round(leftWidth.value)))
  }

  function setRightWidth(value: number): void {
    rightWidth.value = Math.min(420, Math.max(170, value))
    localStorage.setItem('moye.rightWidth', String(Math.round(rightWidth.value)))
  }

  function setLeftTab(tab: 'elements' | 'files'): void {
    leftTab.value = tab
    localStorage.setItem('moye.leftTab', tab)
  }

  function toggleOutline(): void {
    outlineVisible.value = !outlineVisible.value
    localStorage.setItem('moye.outline', outlineVisible.value ? '1' : '0')
  }

  function setOutlineVisible(value: boolean): void {
    outlineVisible.value = value
    localStorage.setItem('moye.outline', value ? '1' : '0')
  }

  function toggleFocus(): void {
    focusMode.value = !focusMode.value
    if (focusMode.value) {
      outlineVisible.value = true
      leftTab.value = 'elements'
      localStorage.setItem('moye.leftTab', 'elements')
    }
  }

  function toggleAi(): void {
    aiCollapsed.value = !aiCollapsed.value
    localStorage.setItem('moye.aiCollapsed', aiCollapsed.value ? '1' : '0')
  }

  function setAiCollapsed(value: boolean): void {
    aiCollapsed.value = value
    localStorage.setItem('moye.aiCollapsed', value ? '1' : '0')
  }

  function setMode(next: EditorMode): void {
    mode.value = next
    localStorage.setItem('moye.mode', next)
  }

  function setContentWidth(next: ContentWidth): void {
    contentWidth.value = next
    localStorage.setItem('moye.contentWidth', next)
  }

  /** 锁定页面：禁止编辑与「点击回源码」；进入阅读态时顺带收起 AI 编辑框，避免误输入 */
  function setLocked(value: boolean): void {
    locked.value = value
    if (value && !aiCollapsed.value) setAiCollapsed(true)
  }

  function toggleLock(): boolean {
    setLocked(!locked.value)
    return locked.value
  }

  function cycleZoom(): void {
    const sequence = [100, 110, 90, 125, 80]
    const index = sequence.indexOf(zoom.value)
    zoom.value = sequence[(index + 1) % sequence.length]
    localStorage.setItem('moye.zoom', String(zoom.value))
  }

  function openImage(src: string, title: string, meta?: string): void {
    imagePreview.value = { src, title, meta }
  }

  function closeImage(): void {
    imagePreview.value = null
  }

  function toast(message: string, tone: ToastItem['tone'] = 'info', duration = 2800): void {
    const id = ++toastSeq
    toasts.value = [...toasts.value, { id, message, tone }]
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id)
    }, duration)
  }

  function askConfirm(options: {
    title: string
    message: string
    confirmText?: string
    danger?: boolean
  }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmState.value = {
        title: options.title,
        message: options.message,
        confirmText: options.confirmText ?? '确定',
        danger: options.danger ?? false,
        resolve
      }
    })
  }

  function resolveConfirm(value: boolean): void {
    confirmState.value?.resolve(value)
    confirmState.value = null
  }

  return {
    leftWidth,
    rightWidth,
    leftTab,
    outlineVisible,
    focusMode,
    aiCollapsed,
    mode,
    contentWidth,
    locked,
    zoom,
    modal,
    toasts,
    confirmState,
    reviewOpen,
    findOpen,
    imagePreview,
    cursorLine,
    outlineJump,
    cursorOffset,
    selectionFrom,
    selectionTo,
    scrollRatio,
    workspaceClass,
    setLeftWidth,
    setRightWidth,
    setLeftTab,
    toggleOutline,
    setOutlineVisible,
    toggleFocus,
    toggleAi,
    setAiCollapsed,
    setMode,
    setContentWidth,
    setLocked,
    toggleLock,
    cycleZoom,
    openImage,
    closeImage,
    toast,
    askConfirm,
    resolveConfirm
  }
})
