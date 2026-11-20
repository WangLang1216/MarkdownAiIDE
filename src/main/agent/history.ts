import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'
import type { TaskSnapshot } from '@shared/types'
import { atomicWriteFile } from '../utils/fs'
import { appPaths } from '../utils/paths'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const entryName = /^\d{13}-task_[a-f0-9]{16}\.json\.gz$/

export class AgentHistory {
  private pending = Promise.resolve()

  private directory(key: string): string {
    return join(appPaths().userData, 'agent-history', key)
  }

  private async files(key: string): Promise<string[]> {
    try {
      return (await readdir(this.directory(key)))
        .filter((name) => entryName.test(name))
        .sort()
        .reverse()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }

  save(key: string, snapshot: TaskSnapshot): Promise<void> {
    return this.enqueue(async () => {
      const { createdAt, taskId } = snapshot.task
      const archive = await compress(JSON.stringify(snapshot))
      await atomicWriteFile(join(this.directory(key), createdAt + '-' + taskId + '.json.gz'), archive)
    })
  }

  move(from: string, to: string): Promise<void> {
    return this.enqueue(async () => {
      const files = await this.files(from)
      if (!files.length) return
      await mkdir(this.directory(to), { recursive: true })
      for (const name of files) {
        await rename(join(this.directory(from), name), join(this.directory(to), name))
      }
    })
  }

  async list(key: string, before: number, limit: number): Promise<TaskSnapshot[]> {
    await this.pending
    const files = (await this.files(key)).slice(before, before + limit)
    const records = await Promise.all(
      files.map(async (name) => {
        try {
          return JSON.parse(
            (await decompress(await readFile(join(this.directory(key), name)))).toString('utf8')
          ) as TaskSnapshot
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      })
    )
    return records.filter((record) => record !== null)
  }

  update(key: string, taskId: string, update: (snapshot: TaskSnapshot) => void): Promise<void> {
    return this.enqueue(async () => {
      const name = (await this.files(key)).find((file) => file.slice(14, -8) === taskId)
      if (!name) return
      const path = join(this.directory(key), name)
      const snapshot = JSON.parse((await decompress(await readFile(path))).toString('utf8')) as TaskSnapshot
      update(snapshot)
      await atomicWriteFile(path, await compress(JSON.stringify(snapshot)))
    })
  }

  remove(key: string, ids: string[] | null): Promise<void> {
    return this.enqueue(async () => {
      const selected = ids && new Set(ids)
      for (const name of await this.files(key)) {
        if (!selected || selected.has(name.slice(14, -8))) await unlink(join(this.directory(key), name))
      }
    })
  }
}
