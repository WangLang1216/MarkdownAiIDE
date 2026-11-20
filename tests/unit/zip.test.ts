/**
 * ZIP 写入器测试：验证本地文件头、中央目录与 CRC32，确保导出的压缩包可被系统解压。
 */

import { crc32 as nodeCrc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createZip } from '../../src/main/utils/zip'

interface ParsedEntry {
  name: string
  data: string
  crc: number
}

function parseZip(buffer: Buffer): ParsedEntry[] {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThanOrEqual(0)
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const entries: ParsedEntry[] = []
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50)
    const crc = buffer.readUInt32LE(offset + 16)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localOffset = buffer.readUInt32LE(offset + 42)
    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50)
    const dataStart =
      localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    entries.push({ name, data: buffer.subarray(dataStart, dataStart + size).toString('utf8'), crc })
    offset += 46 + nameLength
  }
  return entries
}

describe('createZip', () => {
  it('packs Markdown and assets with correct paths and checksums', () => {
    const markdown = '# 标题\n\n![示意图](./assets/demo.png)\n'
    const zip = createZip([
      { name: '文章.md', data: Buffer.from(markdown, 'utf8') },
      { name: 'assets/demo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
    ])

    const entries = parseZip(zip)
    expect(entries.map((entry) => entry.name)).toEqual(['文章.md', 'assets/demo.png'])
    expect(entries[0].data).toBe(markdown)
    expect(entries[0].crc).toBe(nodeCrc32(Buffer.from(markdown, 'utf8')))
    expect(entries[1].crc).toBe(nodeCrc32(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
  })

  it('produces a valid empty archive', () => {
    const zip = createZip([])
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(end).toBe(0)
    expect(zip.readUInt16LE(end + 8)).toBe(0)
    expect(zip.readUInt16LE(end + 10)).toBe(0)
  })
})
