<script setup lang="ts" generic="T extends string">
import { computed, nextTick, ref } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{ id: string; modelValue: T; options: Array<{ value: T; label: string }> }>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const label = computed(() => props.options.find((option) => option.value === props.modelValue)?.label)

async function toggle(): Promise<void> {
  open.value = !open.value
  if (!open.value) return
  await nextTick()
  menu.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
}

function close(): void {
  open.value = false
  trigger.value?.focus()
}

function choose(value: T): void {
  emit('update:modelValue', value)
  close()
}

function focusOut(event: FocusEvent): void {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) open.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (!open.value) return
  if (event.key === 'Escape') {
    event.stopPropagation()
    event.preventDefault()
    close()
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const items = Array.from(menu.value?.querySelectorAll('button') ?? [])
  const focused = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (focused + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  event.preventDefault()
  items[next]?.focus()
}
</script>

<template>
  <div class="setting-select" @focusout="focusOut" @keydown="onKeydown">
    <button
      :id="id"
      ref="trigger"
      type="button"
      class="setting-trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? id + '-menu' : undefined"
      @click="toggle()"
      @keydown.down="!open && ($event.preventDefault(), toggle())"
    >
      {{ label }} <Icon name="chevron-down" :size="12" />
    </button>
    <div v-if="open" :id="id + '-menu'" ref="menu" role="menu" class="setting-options">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="menuitemradio"
        tabindex="-1"
        :aria-checked="option.value === modelValue"
        @click="choose(option.value)"
      >
        <span>{{ option.label }}</span>
        <Icon v-if="option.value === modelValue" name="check" :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.setting-select {
  position: relative;
}
.setting-trigger,
.setting-options button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  text-align: left;
  font-size: 12px;
}
.setting-trigger {
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--side);
  padding: 7px 9px;
}
.setting-options {
  position: absolute;
  z-index: 2;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  padding: 4px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 9px;
  box-shadow: var(--shadow-strong);
}
.setting-options button {
  padding: 5px 7px;
  border-radius: 5px;
}
.setting-options button[aria-checked='true'] {
  background: var(--selection);
}
.setting-options button:hover,
.setting-options button:focus-visible {
  background: var(--hover);
}
</style>
