/**
 * 跨组件复用的文档动作：新建、打开、保存、关闭标签、锁定页面。
 */

import { useDocumentsStore, type TabState } from '../stores/documents'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'
import { editorApi } from './editorApi'

/** 切换页面锁定，并说明锁定后的行为，避免误以为编辑器失灵。 */
export function togglePageLock(): boolean {
  const ui = useUiStore()
  const locked = ui.toggleLock()
  ui.toast(
    locked ? '页面已锁定：只读，点击内容不会再回到源码' : '已解锁，可以继续编辑',
    locked ? 'info' : 'success',
    2200
  )
  return locked
}

/** 新建空白文稿并将返回的快照打开为标签。 */
export async function newDocument(): Promise<void> {
  const documents = useDocumentsStore()
  try {
    await documents.newUntitled()
  } catch (error) {
    useUiStore().toast((error as Error).message || '新建失败', 'error')
  }
}

/** 通过系统选择器打开 Markdown 文稿并更新标签。 */
export async function openDocument(): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  try {
    await documents.openDialog()
  } catch (error) {
    ui.toast((error as Error).message || '打开失败', 'error')
  }
}

/** 调用桌面工作区选择流程并刷新文件侧栏。 */
export async function openWorkspace(): Promise<void> {
  const workspace = useWorkspaceStore()
  const ui = useUiStore()
  try {
    await workspace.openDialog()
  } catch (error) {
    ui.toast((error as Error).message || '打开工作区失败', 'error')
  }
}

/** 保存当前标签的编辑缓冲区，并向用户反馈结果。 */
export async function saveActive(): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  const tab = documents.activeTab
  if (!tab) return
  try {
    await documents.save(tab.snapshot.documentId)
  } catch (error) {
    ui.toast((error as Error).message || '保存失败', 'error')
  }
}

/** 对当前标签发起另存为流程并处理返回状态。 */
export async function saveAsActive(): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  const tab = documents.activeTab
  if (!tab) return
  try {
    await documents.saveAs(tab.snapshot.documentId)
    if (documents.activeTab && documents.activeTab.snapshot.relativePath) {
      await useWorkspaceStore().load()
    }
  } catch (error) {
    ui.toast((error as Error).message || '另存为失败', 'error')
  }
}

/** 元素面板「图片」：选择本地文件，复制到文稿资源目录后插入相对路径 */
export async function insertImageElement(): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  const tab = documents.activeTab
  if (!tab) {
    ui.toast('先打开一个文稿，再插入图片', 'warning')
    return
  }
  if (ui.locked) {
    ui.toast('文稿已锁定，解锁后再插入图片', 'warning')
    return
  }
  try {
    const picked = await window.api.documents.pickImage(tab.snapshot.documentId)
    if (!picked) return
    editorApi.current?.insertText(`\n![${picked.alt}](./${picked.relativePath})\n`)
    await useWorkspaceStore().load()
    ui.toast('图片已复制到资源目录并插入文稿', 'success')
  } catch (error) {
    ui.toast((error as Error).message || '插入图片失败', 'error')
  }
}

/** 按未保存状态先呈现关闭确认，再关闭标签和文稿会话。 */
export async function closeTabWithConfirm(tab: TabState): Promise<void> {
  const documents = useDocumentsStore()
  const ui = useUiStore()
  if (!tab.snapshot.dirty) {
    await documents.close(tab.snapshot.documentId)
    return
  }
  const save = await ui.askConfirm({
    title: '关闭未保存的文稿',
    message: `《${tab.snapshot.title}》有未保存的修改。是否先保存再关闭？`,
    confirmText: '保存并关闭'
  })
  if (save) {
    const ok = await documents.save(tab.snapshot.documentId)
    if (!ok) {
      ui.toast('保存未完成，标签已保留', 'warning')
      return
    }
    await documents.close(tab.snapshot.documentId, true)
    return
  }
  const discard = await ui.askConfirm({
    title: '放弃修改',
    message: '未保存的内容会保留在恢复区，下次启动可恢复。确定关闭？',
    confirmText: '放弃并关闭',
    danger: true
  })
  if (!discard) return
  await documents.close(tab.snapshot.documentId, true)
}
