/**
 * 凭据服务：优先使用操作系统安全存储加密保存；不可用时只保留在本次会话内存中，
 * 并明确标记，绝不静默降级为明文落盘。
 */

import { readFile } from 'node:fs/promises'
import { safeStorage } from 'electron'
import { appPaths } from '../utils/paths'
import { atomicWriteFile } from '../utils/fs'
import { logger } from '../utils/logger'

interface SecretFile {
  version: number
  entries: Record<string, string>
}

/** 通过系统加密保存 Provider 密钥；加密不可用时避免明文持久化。 */
export class SecretService {
  private entries = new Map<string, string>()
  private sessionOnly = new Map<string, string>()
  private loaded = false

  /** 检查当前运行环境是否具备可接受的系统加密后端。 */
  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** 平台后端描述，仅用于设置页说明，不作为安全承诺 */
  backend(): string {
    if (!this.isEncryptionAvailable()) return '本次会话'
    if (process.platform === 'win32') return 'Windows DPAPI'
    if (process.platform === 'darwin') return 'macOS Keychain'
    return 'libsecret / 系统密钥环'
  }

  /** 读取并解密本地密钥记录。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.isEncryptionAvailable()) return
    try {
      const raw = await readFile(appPaths().secretsFile, 'utf8')
      const parsed = JSON.parse(raw) as SecretFile
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        try {
          this.entries.set(key, safeStorage.decryptString(Buffer.from(value, 'base64')))
        } catch {
          logger.warn('secrets', '单条凭据解密失败，已忽略', { key })
        }
      }
    } catch {
      // 首次运行没有文件，属于正常情况
    }
  }

  /** 按内部引用读取可用密钥，仅供主进程使用。 */
  get(ref: string): string | null {
    return this.sessionOnly.get(ref) ?? this.entries.get(ref) ?? null
  }

  /** 检查指定内部引用是否有密钥。 */
  has(ref: string): boolean {
    return this.sessionOnly.has(ref) || this.entries.has(ref)
  }

  /** 设置密钥，并在可用的系统加密后端下持久化。 */
  async set(ref: string, value: string): Promise<void> {
    if (!value) {
      await this.delete(ref)
      return
    }
    if (!this.isEncryptionAvailable()) {
      this.sessionOnly.set(ref, value)
      return
    }
    this.entries.set(ref, value)
    await this.persist()
  }

  /** 移除指定密钥并更新已存记录。 */
  async delete(ref: string): Promise<void> {
    this.sessionOnly.delete(ref)
    if (this.entries.delete(ref)) await this.persist()
  }

  private async persist(): Promise<void> {
    const payload: SecretFile = { version: 1, entries: {} }
    for (const [key, value] of this.entries) {
      payload.entries[key] = safeStorage.encryptString(value).toString('base64')
    }
    await atomicWriteFile(appPaths().secretsFile, JSON.stringify(payload, null, 2))
  }
}
