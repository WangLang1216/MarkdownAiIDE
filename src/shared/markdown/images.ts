/**
 * Markdown 图片引用处理：识别本地图片、收集去重、导出时重写链接。
 * 纯函数，便于单元测试；不依赖 Electron 或文件系统。
 */

/** ![alt](src "title")，只捕获 src 部分 */
export const IMAGE_REF = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g

/** 内联图片的 data URL；空白符允许出现在 base64 中。 */
const DATA_IMAGE_REF = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i

/** 按首次出现顺序收集 Markdown 中不同的内联图片 data URL。 */
export function collectDataImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  for (const match of markdown.matchAll(IMAGE_REF)) {
    const src = match[2]
    if (DATA_IMAGE_REF.test(src)) refs.add(src)
  }
  return [...refs]
}

/** 远程地址、data URL、自定义协议与纯锚点不参与打包 */
export function isLocalImageRef(src: string): boolean {
  const value = src.trim().replace(/^<|>$/g, '')
  if (!value) return false
  if (/^(?:https?:|data:|mdres:|mdtheme:|#)/i.test(value)) return false
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('file:')) return false
  return true
}

/** 按首次出现顺序收集 Markdown 中不同的本地图片引用。 */
export function collectImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  for (const match of markdown.matchAll(IMAGE_REF)) {
    const src = match[2]
    if (isLocalImageRef(src)) refs.add(src)
  }
  return [...refs]
}

/** 按映射重写图片地址；未命中的引用保持原样 */
export function rewriteImageRefs(markdown: string, mapping: Map<string, string>): string {
  if (!mapping.size) return markdown
  return markdown.replace(IMAGE_REF, (whole, open: string, src: string, close: string) => {
    const next = mapping.get(src)
    return next ? `${open}${next}${close}` : whole
  })
}

/**
 * 压缩包内路径必须是安全的相对路径；越界引用（../、绝对路径）退回到资源目录下的文件名。
 */
export function toSafeZipPath(src: string, fallbackName: string, assetsFolder: string): string {
  let value = src.replace(/^\.\//, '')
  try {
    value = decodeURIComponent(value)
  } catch {
    // 保留原值
  }
  const segments = value.split('/')
  if (
    !value ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    segments.some((segment) => segment === '..' || segment === '.')
  ) {
    return `${assetsFolder || 'assets'}/${fallbackName}`
  }
  return value.replace(/\\/g, '/')
}
