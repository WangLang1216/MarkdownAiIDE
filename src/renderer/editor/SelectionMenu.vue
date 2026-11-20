<script setup lang="ts">
/**
 * 编辑区右键菜单：选中文字后设置行内样式，也提供剪切/复制/粘贴。
 * 页面锁定时只保留复制与全选，读写分离。
 */
import { computed } from 'vue'

type MenuAction =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link'
  | 'clear'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'

interface MenuItem {
  id: MenuAction | 'sep'
  label?: string
  shortcut?: string
  needSelection?: boolean
}

const props = defineProps<{ x: number; y: number; hasSelection: boolean; locked?: boolean }>()
defineEmits<{ action: [id: MenuAction]; close: [] }>()

const groups: MenuItem[][] = [
  [
    { id: 'bold', label: '加粗', shortcut: 'Ctrl B', needSelection: true },
    { id: 'italic', label: '斜体', shortcut: 'Ctrl I', needSelection: true },
    { id: 'underline', label: '下划线', shortcut: 'Ctrl U', needSelection: true },
    { id: 'strike', label: '删除线', needSelection: true },
    { id: 'code', label: '行内代码', needSelection: true }
  ],
  [
    { id: 'link', label: '插入链接', needSelection: true },
    { id: 'clear', label: '清除格式', needSelection: true }
  ],
  [
    { id: 'cut', label: '剪切', shortcut: 'Ctrl X', needSelection: true },
    { id: 'copy', label: '复制', shortcut: 'Ctrl C', needSelection: true },
    { id: 'paste', label: '粘贴' },
    { id: 'selectAll', label: '全选', shortcut: 'Ctrl A' }
  ]
]

const visibleGroups = computed(() =>
  groups
    .map((group) =>
      props.locked ? group.filter((item) => item.id === 'copy' || item.id === 'selectAll') : group
    )
    .filter((group) => group.length > 0)
)

function disabled(item: MenuItem): boolean {
  return Boolean(item.needSelection) && !props.hasSelection
}
</script>

<template>
  <div
    class="selection-menu"
    role="menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @pointerdown.stop
    @mousedown.prevent
    @click.stop
    @contextmenu.prevent
  >
    <template v-for="(group, index) in visibleGroups" :key="index">
      <span v-if="index > 0" class="menu-sep" />
      <button
        v-for="item in group"
        :key="item.id"
        role="menuitem"
        :disabled="disabled(item)"
        @click="$emit('action', item.id as MenuAction)"
      >
        <span>{{ item.label }}</span>
        <small v-if="item.shortcut">{{ item.shortcut }}</small>
      </button>
    </template>
    <span v-if="locked" class="locked-hint">页面已锁定，解锁后可编辑</span>
  </div>
</template>

<style scoped>
.selection-menu {
  position: absolute;
  z-index: 70;
  min-width: 186px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
}

.selection-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 6px 9px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text);
  text-align: left;
  background: transparent;
}

.selection-menu button:hover:not(:disabled) {
  background: var(--hover);
}

.selection-menu button:disabled {
  color: var(--muted);
  opacity: 0.5;
  cursor: default;
}

.selection-menu small {
  font-size: 9px;
  color: var(--muted);
}

.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.locked-hint {
  margin: 4px 6px 2px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
  font-size: 9px;
  color: var(--muted);
}
</style>
