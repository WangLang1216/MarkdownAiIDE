/**
 * 图片类型识别：以真实文件头为准，扩展名只用于生成文件名。
 */

const SIGNATURES: Array<{ magic: string; mime: string; ext: string }> = [
  { magic: '89504e47', mime: 'image/png', ext: 'png' },
  { magic: 'ffd8ff', mime: 'image/jpeg', ext: 'jpg' },
  { magic: '47494638', mime: 'image/gif', ext: 'gif' },
  { magic: '52494646', mime: 'image/webp', ext: 'webp' }
]

/** 表示从文件签名识别出的 MIME 类型及建议扩展名。 */
export interface ImageInfo {
  /** 由文件签名推断的 MIME 类型。 */
  mime: string
  /** 保存识别出的图片格式时适用的扩展名。 */
  extension: string
}

/** 根据内容签名识别支持的图片，而不是信任扩展名。 */
export function sniffImage(buffer: Buffer): ImageInfo | null {
  const hex = buffer.subarray(0, 12).toString('hex')
  for (const item of SIGNATURES) {
    if (hex.startsWith(item.magic)) {
      if (item.mime === 'image/webp' && buffer.subarray(8, 12).toString('ascii') !== 'WEBP') continue
      return { mime: item.mime, extension: item.ext }
    }
  }
  return null
}

/** 清理用户提供的图片名，供保存资源时构造文件名。 */
export function sanitizeImageName(name: string): string {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'image'
}
