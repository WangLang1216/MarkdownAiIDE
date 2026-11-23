<script setup lang="ts">
/**
 * 外观与设置：应用主题、文稿主题（含 Typora 导入）、排版、编辑、预测与导出。
 */
import { computed, ref } from 'vue'
import type { ThemeCompatibilityReport, ThemeMode } from '@shared/types'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'
import SettingSelect from '../components/SettingSelect.vue'

const settings = useSettingsStore()
const ui = useUiStore()
const importReport = ref<ThemeCompatibilityReport | null>(null)
const importedThemeId = ref<string | null>(null)
const importing = ref(false)

const fontOptions = [
  { value: 'sans', label: '默认无衬线' }, { value: 'serif', label: '默认衬线' },
  { value: 'mono', label: '等宽' }, { value: 'yahei', label: '微软雅黑' },
  { value: 'simsun', label: '宋体' }, { value: 'kaiti', label: '楷体' },
  { value: 'simhei', label: '黑体' }, { value: 'fangsong', label: '仿宋' }
] satisfies Array<{ value: typeof typography.value.fontFamily; label: string }>

const closeOptions = [
  { value: 'ask', label: '每次询问' }, { value: 'tray', label: '最小化到托盘' }, { value: 'quit', label: '退出程序' }
] satisfies Array<{ value: typeof behaviorSettings.value.closeAction; label: string }>

const pageSizeOptions = [
  { value: 'A4', label: 'A4' },
  { value: 'Letter', label: 'Letter' }
] satisfies Array<{ value: typeof exportSettings.value.pageSize; label: string }>

const themeModes: Array<{ value: ThemeMode; label: string; className: string }> = [
  { value: 'light', label: '浅色', className: 'light-mini' },
  { value: 'dark', label: '深色', className: 'dark-mini' },
  { value: 'system', label: '跟随系统', className: 'system-mini' }
]

const typography = computed(() => settings.settings.typography)
const editorSettings = computed(() => settings.settings.editor)
const prediction = computed(() => settings.settings.prediction)
const exportSettings = computed(() => settings.settings.export)
const storageSettings = computed(() => settings.settings.storage)
const behaviorSettings = computed(() => settings.settings.appBehavior)

async function setThemeMode(mode: ThemeMode): Promise<void> {
  await settings.update({ appearance: { themeMode: mode } })
}

async function chooseTheme(themeId: string): Promise<void> {
  await settings.activateTheme(themeId)
}

async function importTheme(): Promise<void> {
  importing.value = true
  try {
    const result = await settings.importTheme()
    if (!result) return
    importReport.value = result.report as ThemeCompatibilityReport
    importedThemeId.value = result.theme.themeId
    ui.toast(`已导入主题《${result.theme.name}》，可先预览再启用`, 'success', 3600)
  } catch (error) {
    ui.toast((error as Error).message || '导入主题失败', 'error')
  } finally {
    importing.value = false
  }
}

async function removeTheme(themeId: string): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: '移除主题',
    message: '将删除该主题及其导入的资源副本，不影响你的原始 CSS 文件。',
    confirmText: '移除',
    danger: true
  })
  if (!confirmed) return
  await settings.removeTheme(themeId)
  importReport.value = null
}

async function patchTypography(patch: Partial<typeof typography.value>): Promise<void> {
  await settings.update({ typography: patch })
}

async function patchEditor(patch: Partial<typeof editorSettings.value>): Promise<void> {
  await settings.update({ editor: patch })
}

async function patchPrediction(patch: Partial<typeof prediction.value>): Promise<void> {
  await settings.update({ prediction: patch })
}

async function patchExport(patch: Partial<typeof exportSettings.value>): Promise<void> {
  await settings.update({ export: patch })
}

async function patchStorage(patch: Partial<typeof storageSettings.value>): Promise<void> {
  await settings.update({ storage: patch })
}

async function patchBehavior(patch: Partial<typeof behaviorSettings.value>): Promise<void> {
  await settings.update({ appBehavior: patch })
}

async function chooseCacheDir(): Promise<void> {
  const selected = await window.api.app.chooseDirectory('选择缓存目录')
  if (!selected) return
  await patchStorage({ cacheDir: selected })
  ui.toast('缓存目录已更新，新导出的临时文件会写入该目录', 'success', 3600)
}
</script>

<template>
  <div class="modal-backdrop appearance-backdrop" @click.self="ui.modal = null">
    <section class="modal" role="dialog" aria-modal="true" aria-label="外观与设置">
      <div class="modal-title">
        <div>
          <span class="eyebrow">MAKE IT YOURS</span>
          <h2>你的写作，你的风格</h2>
          <p>舒适的界面，配上你熟悉的文稿样式。</p>
        </div>
        <button type="button" class="iconbtn modal-close" aria-label="关闭" @click.stop="ui.modal = null">
          <Icon name="x" :size="15" />
        </button>
      </div>

      <div class="settings-label">应用外观<span>控制工具栏、侧栏与 AI 面板</span></div>
      <div class="appearance-options">
        <button
          v-for="mode in themeModes"
          :key="mode.value"
          class="appearance"
          :class="{ active: settings.settings.appearance.themeMode === mode.value }"
          @click="setThemeMode(mode.value)"
        >
          <span class="mini-app" :class="mode.className"><i /><b /><em /></span>
          <span>{{ mode.label }} <Icon name="check-circle" :size="13" /></span>
        </button>
      </div>

      <div class="settings-label">文稿样式<span>仅影响编辑正文、预览与导出</span></div>
      <div class="doc-themes">
        <button
          v-for="theme in settings.themes"
          :key="theme.themeId"
          class="doc-theme"
          :class="{ active: typography.docThemeId === theme.themeId }"
          @click="chooseTheme(theme.themeId)"
          @contextmenu.prevent="theme.kind === 'imported' ? removeTheme(theme.themeId) : undefined"
        >
          <span class="theme-sample" :class="theme.builtinFont ?? 'imported'"> Aa<span>自然成文</span> </span>
          <span>
            {{ theme.name }}
            <span class="tag">{{ theme.kind === 'builtin' ? '内置' : '导入' }}</span>
          </span>
          <span
            v-if="theme.kind === 'imported'"
            class="theme-remove"
            role="button"
            tabindex="0"
            title="移除主题"
            @click.stop="removeTheme(theme.themeId)"
            @keydown.enter.stop="removeTheme(theme.themeId)"
          >
            ×
          </span>
        </button>
      </div>

      <button class="import-theme" :disabled="importing" @click="importTheme">
        <Icon name="download" :size="16" />
        <span>
          <b>{{ importing ? '正在解析主题…' : '导入 Typora 主题' }}</b>
          <small>选择 .css 文件，自动复制本地资源并生成兼容报告</small>
        </span>
        <Icon name="right" :size="13" />
      </button>

      <div v-if="importReport" class="theme-report">
        <div class="report-head">
          <b>兼容报告</b>
          <span>{{ importReport.ruleCount }} 条规则 · 资源 {{ importReport.importedAssets }} 个</span>
        </div>
        <p>
          A 级已覆盖：{{ importReport.aLevelCovered.join('、') || '无' }}
          <template v-if="importReport.missingALevel.length"
            >；缺少：{{ importReport.missingALevel.join('、') }}</template
          >
        </p>
        <p v-if="importReport.bLevelCovered.length">
          B 级已覆盖：{{ importReport.bLevelCovered.join('、') }}
        </p>
        <p v-if="importReport.remoteAssetsBlocked">
          已阻止 {{ importReport.remoteAssetsBlocked }} 个远程资源。
        </p>
        <p v-for="warning in importReport.warnings.slice(0, 4)" :key="warning" class="warn">{{ warning }}</p>
        <button v-if="importedThemeId" class="ghostbtn preview-theme" @click="chooseTheme(importedThemeId!)">
          预览此主题
        </button>
      </div>

      <div class="settings-label">排版<span>实时渲染与预览同步生效</span></div>
      <div class="setting-grid">
        <div class="field">
          <label for="body-font">正文字体</label>
          <SettingSelect id="body-font" :model-value="typography.fontFamily" :options="fontOptions"
            @update:model-value="patchTypography({ fontFamily: $event })" />
        </div>
        <div class="field">
          <label>字号 {{ typography.fontSize }}px</label>
          <input
            type="range"
            min="12"
            max="20"
            step="1"
            :value="typography.fontSize"
            @input="patchTypography({ fontSize: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>
        <div class="field">
          <label>行距 {{ typography.lineHeight.toFixed(2) }}</label>
          <div class="segmented">
            <button v-for="preset in [{ label: '紧凑', value: 1.7 }, { label: '默认', value: 2.05 }, { label: '宽松', value: 2.35 }]"
              :key="preset.value" :class="{ active: typography.lineHeight === preset.value }"
              :aria-pressed="typography.lineHeight === preset.value"
              @click="patchTypography({ lineHeight: preset.value })">{{ preset.label }}</button>
          </div>
          <input
            type="range"
            min="1.4"
            max="2.4"
            step="0.05"
            :value="typography.lineHeight"
            @input="patchTypography({ lineHeight: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>
        <div class="field">
          <label>正文宽度 {{ typography.maxWidth }}px</label>
          <input
            type="range"
            min="560"
            max="1040"
            step="10"
            :value="typography.maxWidth"
            @input="patchTypography({ maxWidth: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>
      </div>

      <div class="settings-label">编辑与保存<span>本地优先，不强制登录</span></div>
      <div class="toggles">
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="editorSettings.autosave"
            @change="patchEditor({ autosave: ($event.target as HTMLInputElement).checked })"
          />
          自动保存（{{ editorSettings.autosaveDelayMs }}ms 停顿后）
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="editorSettings.showLineNumbers"
            @change="patchEditor({ showLineNumbers: ($event.target as HTMLInputElement).checked })"
          />
          源码模式显示行号
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="editorSettings.typewriter"
            @change="patchEditor({ typewriter: ($event.target as HTMLInputElement).checked })"
          />
          打字机模式（光标垂直居中）
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="editorSettings.loadRemoteImages"
            @change="patchEditor({ loadRemoteImages: ($event.target as HTMLInputElement).checked })"
          />
          加载文稿中的远程图片（默认关闭，保护隐私）
        </label>
      </div>

      <div class="settings-label">AI 与预测<span>预测不写入文档，接受后才成为一次编辑</span></div>
      <div class="toggles">
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="prediction.enabled"
            @change="patchPrediction({ enabled: ($event.target as HTMLInputElement).checked })"
          />
          启用行内续写预测
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="prediction.auto"
            @change="patchPrediction({ auto: ($event.target as HTMLInputElement).checked })"
          />
          自动预测（默认开启，停顿 {{ prediction.debounceMs }}ms，每分钟最多 {{ prediction.maxPerMinute }} 次）
        </label>
      </div>

      <div class="settings-label">启动与关闭<span>托盘、退出与上次文稿恢复</span></div>
      <div class="setting-grid">
        <div class="field">
          <label for="close-action">关闭窗口时</label>
          <SettingSelect id="close-action" :model-value="behaviorSettings.closeAction" :options="closeOptions"
            @update:model-value="patchBehavior({ closeAction: $event })" />
          <small class="field-hint">选择“每次询问”时，可在弹窗里勾选不再提示</small>
        </div>
        <div class="field">
          <label>启动时</label>
          <label class="checkbox">
            <input
              type="checkbox"
              :checked="behaviorSettings.restoreSession"
              @change="patchBehavior({ restoreSession: ($event.target as HTMLInputElement).checked })"
            />
            恢复上次打开的文稿
          </label>
          <small class="field-hint">文件已不存在时打开示例文稿</small>
        </div>
      </div>

      <div class="settings-label">软件更新</div>
      <label class="checkbox">
        <input type="checkbox" :checked="behaviorSettings.autoUpdate"
          @change="patchBehavior({ autoUpdate: ($event.target as HTMLInputElement).checked })" />
        自动下载更新，并在退出应用后安装
      </label>

      <div class="settings-label">资源与缓存<span>图片默认跟随文稿保存，换电脑也能打开</span></div>
      <div class="setting-grid">
        <div class="field">
          <label>文稿资源目录</label>
          <input
            :value="storageSettings.assetsFolder"
            placeholder="assets"
            spellcheck="false"
            @change="patchStorage({ assetsFolder: ($event.target as HTMLInputElement).value })"
          />
          <small class="field-hint">相对文稿所在目录，默认为 assets</small>
        </div>
        <div class="field">
          <label>缓存目录</label>
          <div class="field-inline">
            <input
              :value="storageSettings.cacheDir"
              placeholder="默认：应用数据目录/cache"
              spellcheck="false"
              readonly
            />
            <button class="ghostbtn" @click="chooseCacheDir">选择…</button>
            <button v-if="storageSettings.cacheDir" class="textbtn" @click="patchStorage({ cacheDir: '' })">
              恢复默认
            </button>
          </div>
          <small class="field-hint">导出临时文件与 PDF 打印缓存</small>
        </div>
      </div>

      <div class="settings-label">导出<span>PDF 使用 Chromium 打印，其他格式需要 Pandoc</span></div>
      <div class="setting-grid">
        <div class="field">
          <label for="pdf-page-size">PDF 纸张</label>
          <SettingSelect
            id="pdf-page-size"
            :model-value="exportSettings.pageSize"
            :options="pageSizeOptions"
            @update:model-value="patchExport({ pageSize: $event })"
          />
        </div>
        <div class="field">
          <label>页边距 {{ exportSettings.marginMm }}mm</label>
          <input
            type="range"
            min="8"
            max="32"
            step="1"
            :value="exportSettings.marginMm"
            @input="patchExport({ marginMm: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="exportSettings.includeTheme"
            @change="patchExport({ includeTheme: ($event.target as HTMLInputElement).checked })"
          />
          导出时包含文稿主题样式
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="exportSettings.includeSources"
            @change="patchExport({ includeSources: ($event.target as HTMLInputElement).checked })"
          />
          保留 AI 生成的来源脚注
        </label>
      </div>

      <div class="modal-footer">
        <span class="note">
          Pandoc：{{
            settings.appInfo?.pandoc.available
              ? settings.appInfo?.pandoc.version
              : '未安装（DOCX/EPUB/LaTeX 转换需要）'
          }}
        </span>
        <div class="footer-actions">
          <button class="ghostbtn" @click="ui.modal = 'providers'">
            <Icon name="sparkles" :size="13" />模型服务
          </button>
          <button class="darkbtn" @click="ui.modal = null">完成</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.appearance-backdrop, .modal-close { -webkit-app-region: no-drag; }
.modal-close { flex: 0 0 28px; position: relative; z-index: 3; }

.field-inline {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-inline input {
  flex: 1;
  min-width: 0;
}

.field-hint {
  display: block;
  margin-top: 5px;
  font-size: 10px;
  color: var(--muted);
}

.appearance-options,
.doc-themes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.appearance {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 7px;
  text-align: left;
}

.appearance.active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--line));
}

.appearance > span:last-child {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  padding: 10px 5px 3px;
}

.appearance > span:last-child svg {
  visibility: hidden;
  color: var(--accent);
}

.appearance.active > span:last-child svg {
  visibility: visible;
}

.mini-app {
  display: block;
  background: #f7f8f5;
  height: 76px;
  border: 1px solid #e7e9e3;
  border-radius: 5px;
  position: relative;
  overflow: hidden;
}

.mini-app::before {
  content: '';
  position: absolute;
  top: 12px;
  left: 0;
  right: 0;
  border-top: 1px solid #e3e6df;
}

.mini-app i {
  position: absolute;
  left: 0;
  top: 13px;
  bottom: 0;
  background: #e9ede7;
  width: 27px;
}

.mini-app b {
  position: absolute;
  left: 40px;
  top: 29px;
  height: 4px;
  width: 56px;
  background: #c1cbbf;
  box-shadow:
    0 11px 0 #e0e5db,
    0 22px 0 #e0e5db;
}

.mini-app em {
  position: absolute;
  left: 40px;
  bottom: 6px;
  height: 13px;
  width: 90px;
  border: 1px solid #dfe4da;
  border-radius: 4px;
  background: white;
}

.dark-mini {
  background: #242725;
  border-color: #3d423c;
}

.dark-mini::before {
  border-color: #41483e;
}

.dark-mini i {
  background: #30352f;
}

.dark-mini b {
  background: #7d8b78;
  box-shadow:
    0 11px 0 #454f40,
    0 22px 0 #454f40;
}

.dark-mini em {
  background: #333c30;
  border-color: #505b4b;
}

.system-mini {
  background: linear-gradient(90deg, #f7f8f5 50%, #242725 50%);
}

.theme-sample {
  display: flex;
  flex-direction: column;
  justify-content: center;
  text-align: center;
  height: 78px;
  font:
    26px Georgia,
    serif;
  background: #f7f8f5;
  color: #5b6a5e;
  border-radius: 6px;
}

.theme-sample span {
  font:
    9px 'Microsoft YaHei',
    sans-serif;
  margin-top: 6px;
  letter-spacing: 1px;
  color: #9aa696;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 0 4px;
}

.theme-sample.serif {
  background: #f9f3e9;
  font-family: Georgia, 'SimSun', serif;
  color: #846e4d;
}

.theme-sample.minimal {
  background: #f1f3f4;
  color: #6d7785;
}

.theme-sample.imported {
  background: var(--side);
  color: var(--text);
  font-family: var(--article-font);
}

.doc-theme {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px;
  text-align: left;
}

.doc-theme.active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--line));
}

.theme-remove {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted);
  background: color-mix(in srgb, var(--card) 80%, transparent);
  opacity: 0;
}

.doc-theme:hover .theme-remove {
  opacity: 1;
}

.doc-theme .theme-remove:hover {
  color: #9a4a38;
  background: var(--hover);
}

.doc-theme > span:nth-child(2) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  padding: 9px 4px 3px;
}

.import-theme {
  display: flex;
  width: 100%;
  border: 1px dashed color-mix(in srgb, var(--accent) 30%, var(--line));
  border-radius: 9px;
  padding: 14px 16px;
  margin-top: 16px;
  gap: 12px;
  align-items: center;
  text-align: left;
  color: var(--soft);
}

.import-theme > span:nth-child(2) {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
}

.import-theme b {
  font-size: 11px;
  font-weight: 500;
}

.import-theme small {
  font-size: 10px;
  color: var(--muted);
}

.theme-report {
  margin-top: 14px;
  border: 1px solid var(--line);
  background: var(--side);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 10px;
  color: var(--soft);
  line-height: 1.8;
}

.report-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}

.report-head b {
  font-size: 11px;
  font-weight: 500;
}

.theme-report p {
  margin: 2px 0;
}

.theme-report .warn {
  color: #9a6a3f;
}

.theme-report .preview-theme {
  margin-top: 8px;
  font-size: 10px;
  padding: 5px 10px;
}

.setting-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 18px;
}

.segmented {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
}

.segmented button {
  flex: 1;
  font-size: 10px;
  padding: 5px 0;
  border-radius: 4px;
  color: var(--muted);
}

.segmented button.active {
  background: var(--selection);
  color: color-mix(in srgb, var(--accent) 75%, var(--text));
}

.field input[type='range'] {
  accent-color: var(--accent);
  width: 100%;
}

.toggles {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 18px;
}

.footer-actions {
  display: flex;
  gap: 10px;
}

.footer-actions .ghostbtn {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
