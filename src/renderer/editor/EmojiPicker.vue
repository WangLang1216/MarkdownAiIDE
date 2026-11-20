<script setup lang="ts">
/**
 * 表情选择器：插入表情简码后就地弹出，支持按简码搜索并切换。
 * 面板自身阻止 pointerdown 冒泡，避免被宿主的“点击外部关闭”监听误伤。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { EMOJI_CHOICES } from '../lib/emoji'
import Icon from '../components/Icon.vue'

defineProps<{ x: number; y: number }>()
const emit = defineEmits<{ pick: [name: string]; close: [] }>()

const query = ref('')
const search = ref<HTMLInputElement | null>(null)

const filtered = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) return EMOJI_CHOICES
  return EMOJI_CHOICES.filter((choice) => choice.name.includes(value))
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key === 'Enter') {
    const first = filtered.value[0]
    if (!first) return
    event.preventDefault()
    emit('pick', first.name)
  }
}

onMounted(() => {
  void nextTick(() => search.value?.focus())
})
</script>

<template>
  <div
    class="emoji-picker"
    role="dialog"
    aria-label="选择表情"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @pointerdown.stop
    @click.stop
    @keydown="onKeydown"
  >
    <div class="emoji-head">
      <span>选择表情</span>
      <input ref="search" v-model="query" placeholder="搜索简码…" aria-label="搜索表情简码" />
      <button class="emoji-close" type="button" title="关闭" aria-label="关闭" @click="emit('close')">
        <Icon name="x" :size="11" />
      </button>
    </div>
    <div class="emoji-grid">
      <button
        v-for="choice in filtered"
        :key="choice.name"
        type="button"
        :title="`:${choice.name}:`"
        :aria-label="`:${choice.name}:`"
        @click="emit('pick', choice.name)"
      >
        {{ choice.emoji }}
      </button>
    </div>
    <p v-if="!filtered.length" class="emoji-empty">没有匹配的表情，换个简码试试。</p>
  </div>
</template>

<style scoped>
.emoji-picker {
  position: absolute;
  z-index: 80;
  width: 306px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.emoji-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.emoji-head > span {
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--muted);
  white-space: nowrap;
}

.emoji-head input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--page);
  color: var(--text);
  font-size: 11px;
}

.emoji-close {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--muted);
}

.emoji-close:hover {
  background: var(--hover);
  color: var(--text);
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  max-height: 236px;
  overflow-y: auto;
  padding-right: 2px;
}

.emoji-grid button {
  height: 32px;
  border-radius: 6px;
  font-size: 19px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.emoji-grid button:hover {
  background: var(--hover);
}

.emoji-empty {
  margin: 4px 2px 2px;
  font-size: 11px;
  color: var(--muted);
}
</style>
