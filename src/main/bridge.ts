/**
 * 编辑器桥接：主进程需要读取或应用编辑事务时，向渲染进程发起一次受控请求。
 * 超时或窗口不可用时明确失败，绝不在未收到内核确认时报告成功。
 */

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IPC, type EditorEdit, type EditorRequest, type EditorResponse } from '@shared/ipc'
import { AppError } from '@shared/errors'
import { logger } from './utils/logger'

interface PendingRequest {
  resolve: (response: EditorResponse) => void
  timer: NodeJS.Timeout
}

type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never
type EditorRequestInit = WithoutRequestId<EditorRequest>

/** 管理主进程与渲染编辑器之间的请求和响应，用于同步缓冲区及执行带版本保护的编辑。 */
export class EditorBridge {
  private window: BrowserWindow | null = null
  private pending = new Map<string, PendingRequest>()

  /** 绑定接收编辑请求的窗口，并在窗口关闭时结束挂起请求。 */
  attach(window: BrowserWindow): void {
    this.window = window
    window.on('closed', () => {
      if (this.window === window) this.window = null
      this.rejectAll('窗口已关闭')
    })
  }

  /** 清除当前窗口引用，使后续桥接请求不再发往该窗口。 */
  detach(): void {
    this.window = null
  }

  /** 检查当前桥接窗口是否存在且尚未销毁。 */
  isAvailable(): boolean {
    return Boolean(this.window && !this.window.isDestroyed())
  }

  /** 按请求 ID 匹配待处理请求，清除超时计时器并交付响应。 */
  handleResponse(response: EditorResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }

  /** 读取渲染进程最新文本；失败返回 null，由调用方决定降级策略 */
  async sync(documentId: string, timeoutMs = 3000): Promise<EditorResponse | null> {
    if (!this.isAvailable()) return null
    return this.request({ type: 'sync', documentId }, timeoutMs).catch((error) => {
      logger.warn('bridge', '同步编辑器文本失败', {
        message: error instanceof Error ? error.message : String(error)
      })
      return null
    })
  }

  /** 发送带修订约束的编辑事务；无确认或编辑器拒绝时不报告成功。 */
  async apply(
    input: {
      documentId: string
      expectedRevision: number
      undoGroupId: string
      edits: EditorEdit[]
      reveal?: { from: number; to: number }
    },
    timeoutMs = 8000
  ): Promise<EditorResponse> {
    const response = await this.request({ type: 'apply', ...input }, timeoutMs)
    if (!response.ok) {
      throw new AppError('REVISION_CONFLICT', response.error?.message ?? '编辑器拒绝了本次修改。')
    }
    return response
  }

  /** 尽力请求编辑器显示目标源码区间，窗口不可用或定位失败时忽略。 */
  async reveal(documentId: string, from: number, to: number): Promise<void> {
    if (!this.isAvailable()) return
    await this.request({ type: 'reveal', documentId, from, to }, 2000).catch(() => undefined)
  }

  private request(request: EditorRequestInit, timeoutMs: number): Promise<EditorResponse> {
    if (!this.window || this.window.isDestroyed()) {
      return Promise.reject(new AppError('UNKNOWN', '编辑器窗口不可用。'))
    }
    const requestId = randomUUID()
    const payload = { ...request, requestId } as EditorRequest
    return new Promise<EditorResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new AppError('UNKNOWN', '编辑器响应超时。'))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, timer })
      try {
        this.window?.webContents.send(IPC.bridge.request, payload)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new AppError('UNKNOWN', '无法发送编辑器请求。'))
      }
    })
  }

  private rejectAll(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ requestId: '', ok: false, error: { code: 'CANCELLED', message } })
    }
    this.pending.clear()
  }
}
