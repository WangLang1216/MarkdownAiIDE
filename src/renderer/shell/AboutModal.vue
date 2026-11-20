<script setup lang="ts">
/**
 * 关于弹窗：项目信息、作者、日期与仓库地址。
 */
import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'

const settings = useSettingsStore()
const ui = useUiStore()

const version = computed(() => settings.appInfo?.version ?? '1.0.0')
const iconDataUrl = computed(() => settings.appInfo?.iconDataUrl ?? null)
const repository = 'https://github.com/xiaopengyou/markdown-ide'

const facts: Array<{ label: string; value: string }> = [
  { label: '作者', value: '彭友 · Xiaopengyou Studio' },
  { label: '发布日期', value: '2026 年 11 月' },
  { label: '开源许可', value: 'MIT License' },
  { label: '技术栈', value: 'Electron 45 · Vue 3 · TypeScript · CodeMirror 6' }
]

function openRepository(): void {
  void window.api.app.openExternal(repository)
}
</script>

<template>
  <div class="modal-backdrop" @click.self="ui.modal = null">
    <section class="modal about-modal" role="dialog" aria-modal="true" aria-label="关于小彭友">
      <div class="modal-title">
        <div>
          <span class="eyebrow">ABOUT</span>
          <h2>小彭友 · Markdown AI IDE</h2>
          <p>本地优先的写作工具，把想法安静地写成文章。</p>
        </div>
        <button class="iconbtn" aria-label="关闭" @click="ui.modal = null">
          <Icon name="x" :size="15" />
        </button>
      </div>

      <div class="about-hero">
        <img v-if="iconDataUrl" class="about-logo" :src="iconDataUrl" alt="小彭友" />
        <span v-else class="about-mark">m<span>·</span></span>
        <div>
          <b>版本 {{ version }}</b>
          <small>文稿是普通 Markdown 文件，不建立账号，也不强制云同步。</small>
        </div>
      </div>

      <dl class="about-facts">
        <div v-for="item in facts" :key="item.label">
          <dt>{{ item.label }}</dt>
          <dd>{{ item.value }}</dd>
        </div>
      </dl>

      <div class="about-links">
        <button class="ghostbtn" @click="openRepository">
          <Icon name="external-link" :size="13" />GitHub 仓库
        </button>
        <button class="ghostbtn" @click="ui.modal = 'shortcuts'">
          <Icon name="info" :size="13" />快捷键与使用提示
        </button>
      </div>

      <p class="about-note">
        内置 Agent 的所有修改都经过 ChangeSet 校验；模型输出不会直接写入磁盘，保存与恢复由应用落账。
      </p>

      <div class="about-footer">
        <span>© 2026 Xiaopengyou Studio</span>
        <button class="darkbtn" @click="ui.modal = null">知道了</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.about-modal {
  width: min(560px, calc(100vw - 60px));
}

.about-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--side);
}

.about-logo {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 10px;
  object-fit: cover;
  box-shadow: 0 3px 10px rgba(36, 45, 34, 0.14);
}

.about-mark {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: #2d3330;
  color: #fff;
  font:
    bold italic 26px Georgia,
    serif;
}

.about-mark span {
  color: #afc4b6;
}

.about-hero b {
  display: block;
  font-size: 13px;
  color: var(--text);
}

.about-hero small {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}

.about-facts {
  margin: 16px 0 0;
  display: grid;
  gap: 10px;
}

.about-facts div {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 10px;
  align-items: baseline;
  font-size: 11px;
}

.about-facts dt {
  color: var(--muted);
}

.about-facts dd {
  margin: 0;
  color: var(--text);
}

.about-links {
  display: flex;
  gap: 8px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.about-note {
  margin: 16px 0 0;
  font-size: 10px;
  line-height: 1.7;
  color: var(--muted);
}

.about-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  font-size: 10px;
  color: var(--muted);
}
</style>
