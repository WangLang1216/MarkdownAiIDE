<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../components/Icon.vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useUpdatesStore } from '../stores/updates'
import { releasePageUrl } from '@shared/update'

const ui = useUiStore()
const settings = useSettingsStore()
const updates = useUpdatesStore()
const release = computed(() => updates.state.release)
const busy = computed(() => ['checking', 'downloading', 'installing'].includes(updates.state.phase))

function openRelease(): void {
  void window.api.app.openExternal(release.value?.url ?? releasePageUrl)
}
</script>

<template>
  <div class="modal-backdrop update-backdrop" @click.self="ui.modal = null">
    <section class="modal update-modal" role="dialog" aria-modal="true" aria-label="软件更新">
      <header class="modal-title">
        <div>
          <h2>{{ release ? '新版本 ' + release.version : '检查新版本' }}</h2>
          <p v-if="settings.appInfo">当前版本 {{ settings.appInfo.version }}</p>
        </div>
        <button type="button" class="iconbtn" aria-label="关闭" @click="ui.modal = null">
          <Icon name="x" :size="15" />
        </button>
      </header>
      <p v-if="busy" role="status">
        {{ updates.state.phase === 'checking' ? '正在检查 GitHub 发行版…'
          : updates.state.phase === 'installing' ? '正在保存已打开的文稿并准备安装…'
          : '正在下载 ' + updates.state.percent + '%' }}
      </p>
      <progress v-if="updates.state.phase === 'downloading'" :value="updates.state.percent" max="100" />
      <p v-if="updates.state.message" role="status">{{ updates.state.message }}</p>
      <template v-if="release">
        <h3>{{ release.title }}</h3>
        <p v-if="release.publishedAt">{{ new Date(release.publishedAt).toLocaleDateString('zh-CN') }}</p>
        <div v-if="release.notes" class="release-notes">{{ release.notes }}</div>
        <p v-if="updates.state.phase === 'ready' && settings.settings.appBehavior.autoUpdate">
          已下载。选择稍后更新时，将在退出应用后安装。
        </p>
        <p v-else-if="!release.canInstall">此发行版可从 GitHub 下载并手动安装。</p>
      </template>
      <footer class="modal-footer">
        <button type="button" class="textbtn" @click="openRelease()">
          {{ release ? '查看发行页' : '打开发行页' }}
        </button>
        <div class="update-actions">
          <button type="button" class="ghostbtn" @click="ui.modal = null">{{ release ? '稍后更新' : '关闭' }}</button>
          <button v-if="release?.canInstall" type="button" class="darkbtn" :disabled="busy" @click="updates.install()">
            立即更新
          </button>
          <button v-else-if="release" type="button" class="darkbtn" @click="openRelease()">前往下载</button>
          <button v-else-if="!busy" type="button" class="darkbtn" @click="updates.check()">检查新版本</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.update-backdrop { -webkit-app-region: no-drag; }
.update-modal .iconbtn { flex: none; }
.update-modal p { color: var(--soft); line-height: 1.65; }
.release-notes {
  max-height: 40vh; overflow: auto; padding: 12px; background: var(--side);
  border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7;
}
.update-actions { display: flex; gap: 8px; }
progress { width: 100%; accent-color: var(--accent); }
</style>
