/**
 * 工作区 Store：文件树、展开状态、检索与文件操作。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FileNode, WorkspaceInfo, WorkspaceSearchHit, WorkspaceTree } from '@shared/types'
import { useUiStore } from './ui'
import { useDocumentsStore } from './documents'

/** 表示展开工作区目录后供文件侧栏逐行渲染的带层级节点。 */
export interface FlatNode {
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string
  /** 用于分派该记录的类别标记。 */
  kind: 'file' | 'directory'
  /** 文件的扩展名；目录可不提供。 */
  ext?: string
  /** 关联内容占用的大小，单位为字节。 */
  size?: number
  /** 节点在目录树展开后使用的缩进层级。 */
  depth: number
}

const TEXT_EXT = new Set(['md', 'markdown', 'mdx', 'txt'])

/** 维护当前工作区和文件树、目录展开状态及搜索结果。 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const info = ref<WorkspaceInfo | null>(null)
  const tree = ref<WorkspaceTree | null>(null)
  const expanded = ref<Set<string>>(new Set(readExpanded()))
  const filter = ref('')
  const searchQuery = ref('')
  const searchResults = ref<WorkspaceSearchHit[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const rootNodes = computed<FileNode[]>(() => tree.value?.root.children ?? [])

  const activeRelativePath = computed(() => {
    const documents = useDocumentsStore()
    return documents.activeTab?.snapshot.relativePath ?? null
  })

  /** 侧栏展示：目录按展开状态展开，文件按关键词过滤 */
  const visibleRows = computed<FlatNode[]>(() => {
    const keyword = filter.value.trim().toLowerCase()
    const rows: FlatNode[] = []
    const walk = (nodes: FileNode[], depth: number): void => {
      for (const node of nodes) {
        const matches =
          !keyword ||
          node.name.toLowerCase().includes(keyword) ||
          node.relativePath.toLowerCase().includes(keyword)
        if (node.kind === 'directory') {
          if (!keyword) rows.push({ ...node, depth })
          const shouldExpand = expanded.value.has(node.relativePath) || Boolean(keyword)
          if (shouldExpand && node.children?.length) walk(node.children, keyword ? depth : depth + 1)
          continue
        }
        if (!matches) continue
        rows.push({
          name: node.name,
          relativePath: node.relativePath,
          kind: 'file',
          ext: node.ext,
          size: node.size,
          depth
        })
      }
    }
    walk(rootNodes.value, 0)
    return rows
  })

  const markdownFiles = computed(() => {
    const files: FileNode[] = []
    const walk = (nodes: FileNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'directory') walk(node.children ?? [])
        else if (TEXT_EXT.has(node.ext ?? '')) files.push(node)
      }
    }
    walk(rootNodes.value)
    return files
  })

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await window.api.workspace.tree()
      if (!result) {
        info.value = null
        tree.value = null
        return
      }
      info.value = result.workspace
      tree.value = result.tree
      const active = activeRelativePath.value
      if (active) expandTo(active)
      if (expanded.value.size === 0) {
        for (const node of result.tree.root.children ?? []) {
          if (node.kind === 'directory') expanded.value.add(node.relativePath)
        }
      }
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function openDialog(): Promise<void> {
    const next = await window.api.workspace.openDialog()
    if (!next) return
    info.value = next
    expanded.value = new Set()
    await load()
    useUiStore().setLeftTab('files')
  }

  async function openRecent(path: string): Promise<void> {
    const next = await window.api.workspace.openPath(path)
    if (!next) return
    info.value = next
    expanded.value = new Set()
    await load()
    useUiStore().setLeftTab('files')
  }

  function toggle(relativePath: string): void {
    const next = new Set(expanded.value)
    if (next.has(relativePath)) next.delete(relativePath)
    else next.add(relativePath)
    expanded.value = next
    persistExpanded(next)
  }

  function expandTo(relativePath: string): void {
    const parts = relativePath.split('/')
    parts.pop()
    const next = new Set(expanded.value)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      next.add(current)
    }
    expanded.value = next
    persistExpanded(next)
  }

  function dirname(relativePath: string): string {
    const index = relativePath.lastIndexOf('/')
    return index === -1 ? '' : relativePath.slice(0, index)
  }

  function joinPath(parent: string, name: string): string {
    return parent ? `${parent}/${name}` : name
  }

  async function openFile(relativePath: string): Promise<void> {
    const documents = useDocumentsStore()
    await documents.openPath(relativePath)
    expandTo(relativePath)
  }

  async function createFile(parent: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    const relativePath = joinPath(
      parent,
      trimmed.endsWith('.md') || trimmed.endsWith('.txt') ? trimmed : `${trimmed}.md`
    )
    const result = await window.api.workspace.createFile({
      relativePath,
      content: `# ${trimmed.replace(/\.(md|txt)$/, '')}\n\n`,
      open: true
    })
    await load()
    if (result.document) {
      useDocumentsStore().applySnapshot(result.document, 'reload')
    }
    expandTo(relativePath)
    useUiStore().toast(`已创建 ${relativePath}`, 'success')
  }

  async function createFolder(parent: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    const relativePath = joinPath(parent, trimmed)
    await window.api.workspace.createFolder(relativePath)
    expanded.value.add(relativePath)
    await load()
    useUiStore().toast(`已创建目录 ${relativePath}`, 'success')
  }

  async function rename(relativePath: string, nextName: string): Promise<void> {
    const trimmed = nextName.trim()
    if (!trimmed) return
    const target = joinPath(dirname(relativePath), trimmed)
    if (target === relativePath) return
    const result = await window.api.workspace.rename(relativePath, target)
    await load()
    const documents = useDocumentsStore()
    const tab = documents.tabs.find((item) => item.snapshot.relativePath === relativePath)
    if (tab)
      documents.updateTabMeta(tab.snapshot.documentId, {
        relativePath: result.relativePath ?? target,
        title: trimmed
      })
    useUiStore().toast('已重命名', 'success')
  }

  async function remove(relativePath: string): Promise<void> {
    await window.api.workspace.remove(relativePath)
    await load()
    useUiStore().toast('已移入回收站或应用恢复区', 'success')
  }

  async function reveal(relativePath: string): Promise<void> {
    await window.api.workspace.reveal(relativePath)
  }

  async function search(query: string): Promise<void> {
    searchQuery.value = query
    if (!query.trim()) {
      searchResults.value = []
      return
    }
    searchResults.value = await window.api.workspace.search(query, 40)
  }

  function clearSearch(): void {
    searchQuery.value = ''
    searchResults.value = []
  }

  return {
    info,
    tree,
    rootNodes,
    expanded,
    filter,
    searchQuery,
    searchResults,
    loading,
    error,
    visibleRows,
    markdownFiles,
    activeRelativePath,
    load,
    openDialog,
    openRecent,
    toggle,
    expandTo,
    dirname,
    joinPath,
    openFile,
    createFile,
    createFolder,
    rename,
    remove,
    reveal,
    search,
    clearSearch
  }
})

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem('moye.expanded')
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function persistExpanded(value: Set<string>): void {
  localStorage.setItem('moye.expanded', JSON.stringify([...value]))
}
