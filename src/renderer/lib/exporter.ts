/**
 * 导出编排：从当前编辑器快照生成 HTML/PDF，或通过 Pandoc 转换其他格式。
 */

import type { ExportPdfInput } from '@shared/types'
import { useDocumentsStore } from '../stores/documents'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { buildExportHtml } from './exportHtml'

function baseName(title: string): string {
  return title.replace(/\.(md|markdown|mdx|txt)$/i, '')
}

/** 同步活动文稿后发起原始 Markdown 文件导出。 */
export async function exportMarkdown(): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  const tab = documents.activeTab
  if (!tab) return
  await documents.flush(tab.snapshot.documentId)
  const result = await window.api.exports.saveMarkdown(
    tab.snapshot.text,
    `${baseName(tab.snapshot.title)}.md`
  )
  if (result.ok) ui.toast(result.message, 'success')
  else if (result.path === null && result.message) ui.toast(result.message, 'info')
}

/** 导出 .zip：Markdown + 同级资源目录，换电脑可直接展示图片 */
export async function exportMarkdownBundle(): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  const tab = documents.activeTab
  if (!tab) return
  if (!tab.snapshot.relativePath) {
    ui.toast('请先保存文稿，再导出压缩包', 'warning')
    return
  }
  await documents.flush(tab.snapshot.documentId)
  const result = await window.api.exports.saveMarkdownBundle(
    tab.snapshot.documentId,
    tab.snapshot.text,
    `${baseName(tab.snapshot.title)}.md`
  )
  if (result.ok) ui.toast(result.message, 'success', 4200)
  else if (result.message) ui.toast(result.message, 'info')
}

/** 导出单文件 Markdown：本地图片内联为 Base64 */
export async function exportMarkdownInline(): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  const tab = documents.activeTab
  if (!tab) return
  await documents.flush(tab.snapshot.documentId)
  try {
    const result = await window.api.exports.saveMarkdownInline(
      tab.snapshot.documentId,
      tab.snapshot.text,
      `${baseName(tab.snapshot.title)}.md`
    )
    if (result.ok) ui.toast(result.message, 'success', 4200)
    else if (result.message) ui.toast(result.message, 'info')
  } catch (error) {
    ui.toast((error as Error).message || '导出失败', 'error')
  }
}

async function currentHtml(
  styled: boolean
): Promise<{ html: string; name: string; documentId: string } | null> {
  const documents = useDocumentsStore()
  const settings = useSettingsStore()
  const tab = documents.activeTab
  if (!tab) return null
  await documents.flush(tab.snapshot.documentId)
  const theme = settings.activeTheme
  const html = await buildExportHtml({
    title: baseName(tab.snapshot.title),
    markdown: tab.snapshot.text,
    documentId: tab.snapshot.documentId,
    loadRemoteImages: settings.settings.editor.loadRemoteImages,
    includeTheme: settings.settings.export.includeTheme,
    themeCss: settings.themeCss,
    themeScope: theme.kind === 'imported' ? theme.cssScopeId : null,
    dark: false,
    styled,
    inlineImages: (urls) => window.api.documents.inlineImages(tab.snapshot.documentId, urls)
  })
  return { html, name: baseName(tab.snapshot.title), documentId: tab.snapshot.documentId }
}

/** 渲染活动文稿并发起带样式或简洁 HTML 导出。 */
export async function exportHtml(styled = true): Promise<void> {
  const ui = useUiStore()
  const built = await currentHtml(styled)
  if (!built) return
  const result = await window.api.exports.saveHtml(built.html, `${built.name}.html`)
  if (result.ok) ui.toast(result.message, 'success')
  else if (result.message) ui.toast(result.message, 'info')
}

/** 构建打印所需的文稿 HTML 并调用主进程导出 PDF。 */
export async function exportPdf(): Promise<void> {
  const ui = useUiStore()
  const settings = useSettingsStore()
  const built = await currentHtml(true)
  if (!built) return
  const input: ExportPdfInput = {
    html: built.html,
    suggestedName: `${built.name}.pdf`,
    pageSize: settings.settings.export.pageSize,
    marginMm: settings.settings.export.marginMm
  }
  const result = await window.api.exports.savePdf(input)
  if (result.ok) ui.toast(result.message, 'success')
  else if (result.message) ui.toast(result.message, 'info')
}

/** 将活动文稿交给 Pandoc 转换为指定格式。 */
export async function exportWithPandoc(format: 'docx' | 'odt' | 'epub' | 'latex' | 'html'): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  const tab = documents.activeTab
  if (!tab) return
  await documents.flush(tab.snapshot.documentId)
  try {
    const status = await window.api.exports.pandocStatus()
    if (!status.available) {
      ui.toast(status.message, 'warning', 5200)
      return
    }
    const result = await window.api.exports.pandocConvert({
      direction: 'export',
      format: format === 'html' ? 'html' : format,
      markdown: tab.snapshot.text,
      suggestedName: `${baseName(tab.snapshot.title)}.${format === 'latex' ? 'tex' : format}`
    })
    if (result.ok) ui.toast(result.message, 'success')
    else if (result.message) ui.toast(result.message, 'info')
    if (result.warnings.length) ui.toast(`转换提示：${result.warnings[0]}`, 'warning', 5200)
  } catch (error) {
    ui.toast((error as Error).message || '转换失败', 'error')
  }
}

/** 选择并转换其他格式文件，将返回的 Markdown 打开为新文稿。 */
export async function importWithPandoc(): Promise<void> {
  const documents = useDocumentsStore()
  const workspace = await window.api.workspace.current()
  const ui = useUiStore()
  try {
    const status = await window.api.exports.pandocStatus()
    if (!status.available) {
      ui.toast(status.message, 'warning', 5200)
      return
    }
    const result = await window.api.exports.pandocConvert({ direction: 'import', format: 'docx' })
    if (!result.ok) {
      if (result.message && result.message !== '已取消导入。') ui.toast(result.message, 'info')
      return
    }
    ui.toast(result.message, 'success', 4200)
    if (result.outputPath) {
      await documents.openPath(result.outputPath)
      if (workspace) await useWorkspaceRefresh()
    }
    if (result.warnings.length) ui.toast(`转换提示：${result.warnings[0]}`, 'warning', 5200)
  } catch (error) {
    ui.toast((error as Error).message || '导入失败', 'error')
  }
}

async function useWorkspaceRefresh(): Promise<void> {
  const { useWorkspaceStore } = await import('../stores/workspace')
  await useWorkspaceStore().load()
}
