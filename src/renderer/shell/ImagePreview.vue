<script setup lang="ts">
/**
 * 图片预览弹层：文件树图片与 AI 附件共用，点击遮罩或 Esc 关闭。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'

const ui = useUiStore()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') ui.closeImage()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="ui.imagePreview" class="image-backdrop" @click.self="ui.closeImage()">
    <figure class="image-frame" role="dialog" aria-modal="true" :aria-label="ui.imagePreview.title">
      <header class="image-head">
        <div>
          <b>{{ ui.imagePreview.title }}</b>
          <span v-if="ui.imagePreview.meta">{{ ui.imagePreview.meta }}</span>
        </div>
        <button class="iconbtn" aria-label="关闭预览" @click="ui.closeImage()">
          <Icon name="x" :size="15" />
        </button>
      </header>
      <div class="image-stage">
        <img :src="ui.imagePreview.src" :alt="ui.imagePreview.title" />
      </div>
    </figure>
  </div>
</template>

<style scoped>
.image-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(20, 24, 21, 0.55);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 36px;
}

.image-frame {
  margin: 0;
  width: min(1040px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--page);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}

.image-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--chrome);
}

.image-head b {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-head span {
  font-size: 10px;
  color: var(--muted);
}

.image-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  overflow: auto;
  background: var(--side);
}

.image-stage img {
  max-width: 100%;
  max-height: calc(100vh - 190px);
  object-fit: contain;
  border-radius: 6px;
  background:
    linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%),
    linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    8px 8px;
}
</style>
