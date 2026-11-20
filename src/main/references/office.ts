import { inflateRawSync } from 'node:zlib'

const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024

function xmlFiles(bytes: Buffer, matches: (name: string) => boolean): Map<string, string> {
  const files = new Map<string, string>()
  const first = Math.max(0, bytes.length - 65_557)
  let end = bytes.length - 22
  while (
    end >= first &&
    (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
  )
    end--
  if (end < first || bytes.readUInt32LE(end + 4) !== 0) return files

  let offset = bytes.readUInt32LE(end + 16)
  const entries = bytes.readUInt16LE(end + 10)
  let total = 0
  for (let index = 0; index < entries && offset + 46 <= end; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) return files
    const nameLength = bytes.readUInt16LE(offset + 28)
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength)
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    const local = bytes.readUInt32LE(offset + 42)
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
    if (!matches(name) || (flags & 1) !== 0 || size > MAX_ENTRY_BYTES || total + size > MAX_TOTAL_BYTES)
      continue
    if (local + 30 > end || bytes.readUInt32LE(local) !== 0x04034b50) continue
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (start + compressedSize > end) continue
    const data = bytes.subarray(start, start + compressedSize)
    try {
      const raw =
        method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }) : null
      if (!raw || raw.length !== size) continue
      files.set(name, raw.toString('utf8'))
      total += size
    } catch {
      // A damaged part should not hide text from other sheets or slides.
    }
  }
  return files
}

function decodeXml(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi, (entity: string, name: string) => {
    if (!name.startsWith('#')) return entities[name] ?? entity
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

function textRuns(fragment: string): string {
  return [...fragment.matchAll(/<(?:a:)?t(?:\s[^>]*)?>([^<]*)<\/(?:a:)?t>/g)]
    .map((match) => decodeXml(match[1]))
    .join('')
}

export function extractOfficeText(ext: string, bytes: Buffer): string | null {
  if (ext === '.pptx') {
    const slides = xmlFiles(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    return [...slides.keys()]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => {
        const paragraphs = [...slides.get(name)!.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)]
        const text = paragraphs.map((item) => textRuns(item[1])).filter(Boolean)
        return text.length ? ['幻灯片 ' + name.match(/(\d+)\.xml$/)![1], ...text].join('\n') : ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  if (ext === '.xlsx') {
    const files = xmlFiles(bytes, (name) => /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/.test(name))
    const strings = [
      ...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)
    ].map((match) => textRuns(match[1]))
    files.delete('xl/sharedStrings.xml')
    return [...files.keys()]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => {
        const rows = [...files.get(name)!.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)]
        const text = rows
          .map((row) =>
            [...row[1].matchAll(/<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g)]
              .map((cell) => {
                const value = cell[2].match(/<v>([^<]*)<\/v>/)?.[1]
                const address = cell[1].match(/\br="([A-Z]+\d+)"/)?.[1]
                const content = /\bt="s"/.test(cell[1])
                  ? value === undefined
                    ? ''
                    : (strings[Number(value)] ?? '')
                  : value === undefined
                    ? textRuns(cell[2])
                    : decodeXml(value)
                return address ? address + '=' + content : content
              })
              .join('\t')
          )
          .filter(Boolean)
        return text.length ? ['工作表 ' + name.match(/(\d+)\.xml$/)![1], ...text].join('\n') : ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  if (ext === '.odt' || ext === '.ods' || ext === '.odp') {
    const xml = xmlFiles(bytes, (name) => name === 'content.xml').get('content.xml') ?? ''
    return [...xml.matchAll(/<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\1>/g)]
      .map((match) => decodeXml(match[2].replace(/<[^>]+>/g, '')))
      .filter(Boolean)
      .join('\n\n')
  }
  return null
}
