/** 发行页地址：检查失败时供用户手动下载 */
export const releasePageUrl = 'https://github.com/WangLang1216/MarkdownAiIDE/releases'

export type UpdatePhase =
  'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'

export interface UpdateRelease {
  version: string
  title: string
  notes: string
  publishedAt: string
  url: string
  canInstall: boolean
}

export interface UpdateState {
  phase: UpdatePhase
  release: UpdateRelease | null
  percent: number
  message: string
}

export const initialUpdateState: UpdateState = {
  phase: 'idle', release: null, percent: 0, message: ''
}

export function stableVersion(tag: string): string | null {
  return /^(?:v)?(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null
}

export function newerVersion(release: string, installed: string): boolean {
  const current = stableVersion(installed.split('-')[0])
  const offered = stableVersion(release)
  if (!current || !offered) return false
  const parts = current.split('.').map(Number)
  return offered.split('.').map(Number).some((part, index, values) =>
    values.slice(0, index).every((value, prefix) => value === parts[prefix]) && part > parts[index]
  )
}
