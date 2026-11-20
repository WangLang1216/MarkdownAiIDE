/**
 * 网页参考抓取：只读 HTTP(S) 公网地址，拒绝本机/内网/云元数据目标，限制重定向与体积。
 * 不携带浏览器 Cookie 或站点登录凭据，不执行页面脚本。
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch as pinnedFetch } from 'undici'
import { AppError } from '@shared/errors'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 4
const TIMEOUT_MS = 12_000

/** 保存网页正文提取结果及取回时的内容类型和最终地址。 */
export interface FetchedPage {
  /** 完成跳转后实际读取的网页 URL。 */
  finalUrl: string
  /** 供标签、列表或审阅界面显示的标题。 */
  title: string
  /** 当前记录承载的文本内容。 */
  text: string
  /** 记录网页材料被读取的时间。 */
  fetchedAt: string
  /** 读取结果的内容类型。 */
  contentType: string
}

/** 判断地址是否属于必须拒绝的网段 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::1' || normalized === '::') return true
    if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd'))
      return true
    if (normalized.startsWith('::ffff:')) return isBlockedAddress(normalized.slice(7))
    return false
  }
  return true
}

async function assertPublicHost(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('SOURCE_UNREADABLE', '只支持 http/https 链接。')
  }
  if (url.username || url.password) {
    throw new AppError('SOURCE_UNREADABLE', '链接中不能包含账号密码。')
  }
  const host = url.hostname
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new AppError('SOURCE_UNREADABLE', '不允许访问本机地址。')
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [])
  if (!addresses.length) throw new AppError('SOURCE_UNREADABLE', '域名无法解析。')
  for (const item of addresses) {
    if (isBlockedAddress(item.address)) {
      throw new AppError('SOURCE_UNREADABLE', '该链接指向本机或内网地址，已被拒绝。')
    }
  }
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    middot: '·',
    copy: '©',
    reg: '®'
  }
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
}

/** 轻量正文提取：去掉脚本、导航与页脚，优先 article/main，失败时退回全文 */
export function extractHtml(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const stripTags = (value: string): string =>
    decodeEntities(value.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
  const title = stripTags(titleMatch?.[1] ?? h1Match?.[1] ?? '') || '网页参考'

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|button|canvas|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')

  const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned)?.[1]
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned)?.[1]
  let body = article ?? main ?? /<body[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)?.[1] ?? cleaned

  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

/**
 * 使用连接层 DNS 校验，防止“先解析公网、连接时再解析到内网”的 DNS rebinding。
 * 校验失败直接拒绝连接，而不是只检查一次域名。
 */
function createPinnedDispatcher(): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        void lookup(hostname, { all: true })
          .then((addresses) => {
            const safe = addresses.filter((item) => !isBlockedAddress(item.address))
            if (!safe.length) {
              callback(new Error('目标地址位于本机或内网，已拒绝'), '', 4)
              return
            }
            // undici 默认请求 all=true，需要返回地址数组
            if ((options as { all?: boolean } | undefined)?.all) {
              callback(null, safe)
              return
            }
            const first = safe[0]
            callback(null, first.address, first.family === 6 ? 6 : 4)
          })
          .catch((error: Error) => callback(error, '', 4))
      }
    }
  })
}

/** 按网页抓取策略取回页面，并返回可供材料索引的正文及元数据。 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  let current = rawUrl.trim()
  if (!/^https?:\/\//i.test(current)) {
    throw new AppError('SOURCE_UNREADABLE', '链接需要以 http:// 或 https:// 开头。')
  }

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const url = new URL(current)
    await assertPublicHost(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const dispatcher = createPinnedDispatcher()
    try {
      const response = await pinnedFetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
        headers: {
          'user-agent': 'MoYe-MarkdownIDE/1.0 (+local reference reader)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9'
        }
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new AppError('SOURCE_UNREADABLE', '重定向缺少目标地址。')
        current = new URL(location, url).toString()
        continue
      }
      if (!response.ok) {
        throw new AppError('SOURCE_UNREADABLE', `网页返回 ${response.status}，可能需要登录或已失效。`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
        throw new AppError('SOURCE_UNREADABLE', `不支持的内容类型：${contentType || '未知'}。`)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new AppError('SOURCE_UNREADABLE', '网页没有返回内容。')
      const decoder = new TextDecoder('utf-8')
      let received = 0
      let html = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new AppError('SOURCE_UNREADABLE', '网页内容超过 2MB 限制。')
        }
        html += decoder.decode(value, { stream: true })
      }
      const extracted = extractHtml(html)
      if (extracted.text.length < 80) {
        throw new AppError('SOURCE_UNREADABLE', '未能从页面提取正文（可能需要登录或为动态渲染页面）。')
      }
      return {
        finalUrl: url.toString(),
        title: extracted.title,
        text: extracted.text,
        fetchedAt: new Date().toISOString(),
        contentType
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new AppError('SOURCE_UNREADABLE', '读取网页超时。')
      }
      throw new AppError('SOURCE_UNREADABLE', '读取网页失败，请检查网络或更换链接。', {
        details: error instanceof Error ? error.message : String(error)
      })
    } finally {
      clearTimeout(timer)
      await dispatcher.close().catch(() => undefined)
    }
  }
  throw new AppError('SOURCE_UNREADABLE', '重定向次数过多，已停止。')
}
