/**
 * 工作区 Store：文件树、展开状态、检索与文件操作。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FileNode, WorkspaceInfo, WorkspaceSearchHit, WorkspaceTree } from '@shared/types'
import { buildRecentItems, type RecentItem } from '@shared/recent'
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
const FILE_SCOPE_KEY = 'moye.fileScope'

/** 文件侧栏的两种视图：按最近编辑排列，或浏览完整目录树。 */
export type FileScope = 'recent' | 'tree'

/** 维护当前工作区和文件树、目录展开状态及搜索结果。 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const info = ref<WorkspaceInfo | null>(null)
  const tree = ref<WorkspaceTree | null>(null)
  const expanded = ref<Set<string>>(new Set(readExpanded()))
  const filter = ref('')
  const fileScope = ref<FileScope>(readFileScope())
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

  /** 「最近」列表：工作区文稿按最近编辑排序，并合入关闭后未保存的草稿 */
  const recentItems = computed<RecentItem[]>(() => {
    const documents = useDocumentsStore()
    const editedAtByPath = new Map<string, number>()
    for (const tab of documents.tabs) {
      const path = tab.snapshot.relativePath
      if (!path || !tab.lastEditedAt) continue
      editedAtByPath.set(path, Math.max(editedAtByPath.get(path) ?? 0, tab.lastEditedAt))
    }
    return buildRecentItems({
      files: markdownFiles.value,
      drafts: documents.recoveries,
      editedAtByPath,
      now: Date.now()
    })
  })

  /** 切换文件侧栏视图并记住选择。 */
  function setFileScope(scope: FileScope): void {
    if (fileScope.value === scope) return
    fileScope.value = scope
    try {
      window.localStorage.setItem(FILE_SCOPE_KEY, scope)
    } catch {
      // 隐私模式或磁盘配额受限时忽略，仅本次会话生效
    }
  }

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

  /** 拖入目标目录：移动完成后刷新文件树，并同步已打开文稿的相对路径 */
  async function move(relativePath: string, targetDir: string): Promise<void> {
    const result = await window.api.workspace.move(relativePath, targetDir)
    const nextPath = result.relativePath ?? relativePath
    await load()
    if (nextPath === relativePath) return
    const documents = useDocumentsStore()
    for (const tab of documents.tabs) {
      const current = tab.snapshot.relativePath
      if (!current) continue
      if (current !== relativePath && !current.startsWith(`${relativePath}/`)) continue
      documents.updateTabMeta(tab.snapshot.documentId, {
        relativePath: `${nextPath}${current.slice(relativePath.length)}`
      })
    }
    expandTo(nextPath)
    useUiStore().toast(`已移动到 ${targetDir || '根目录'}`, 'success')
  }

  async function reveal(relativePath: string): Promise<void> {
    await window.api.workspace.reveal(relativePath)
  }

  /** 用系统文件管理器打开目录；空串表示工作区根目录 */
  async function openFolder(relativePath: string): Promise<void> {
    await window.api.workspace.openFolder(relativePath)
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
    fileScope,
    searchQuery,
    searchResults,
    loading,
    error,
    visibleRows,
    markdownFiles,
    recentItems,
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
    move,
    remove,
    reveal,
    openFolder,
    search,
    clearSearch,
    setFileScope
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

/** 读取上次停留的文件视图；默认回到完整目录树。 */
function readFileScope(): FileScope {
  try {
    return localStorage.getItem(FILE_SCOPE_KEY) === 'recent' ? 'recent' : 'tree'
  } catch {
    return 'tree'
  }
}

function persistExpanded(value: Set<string>): void {
  localStorage.setItem('moye.expanded', JSON.stringify([...value]))
}
