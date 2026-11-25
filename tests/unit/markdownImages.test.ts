/**
 * Markdown 导出图片处理：本地引用识别、去重与安全的包内路径。
 */

import { describe, expect, it } from 'vitest'
import {
  collectDataImageRefs,
  collectImageRefs,
  isLocalImageRef,
  rewriteImageRefs,
  toSafeZipPath
} from '../../src/shared/markdown/images'

describe('collectImageRefs', () => {
  it('keeps local relative images once and ignores remote/data/absolute', () => {
    const markdown = [
      '![一](./assets/a.png)',
      '![二](assets/a.png "标题")',
      '![远程](https://example.com/b.png)',
      '![内联](data:image/png;base64,AAAA)',
      '![绝对](C:/pictures/c.png)',
      '![协议](mdres://doc/assets/d.png)'
    ].join('\n')
    expect(collectImageRefs(markdown)).toEqual(['./assets/a.png', 'assets/a.png'])
  })

  it('recognises local references only', () => {
    expect(isLocalImageRef('./assets/a.png')).toBe(true)
    expect(isLocalImageRef('../shared/b.png')).toBe(true)
    expect(isLocalImageRef('https://example.com/a.png')).toBe(false)
    expect(isLocalImageRef('file:///tmp/a.png')).toBe(false)
    expect(isLocalImageRef('#anchor')).toBe(false)
    expect(isLocalImageRef('')).toBe(false)
  })
})

describe('collectDataImageRefs', () => {
  it('collects inline images once and ignores local or remote refs', () => {
    const markdown = [
      '![一](data:image/png;base64,AAAA)',
      '![二](data:image/png;base64,AAAA)',
      '![三](data:image/jpeg;base64,BBBB "标题")',
      '![四](./assets/a.png)',
      '![五](https://example.com/b.png)'
    ].join('\n')
    expect(collectDataImageRefs(markdown)).toEqual([
      'data:image/png;base64,AAAA',
      'data:image/jpeg;base64,BBBB'
    ])
  })

  it('rewrites data URLs back to relative paths when saving', () => {
    const markdown = '![一](data:image/png;base64,AAAA) 与 ![二](data:image/jpeg;base64,BBBB)'
    expect(rewriteImageRefs(markdown, new Map([
      ['data:image/png;base64,AAAA', './assets/a1.png'],
      ['data:image/jpeg;base64,BBBB', './assets/b2.jpg']
    ]))).toBe('![一](./assets/a1.png) 与 ![二](./assets/b2.jpg)')
  })
})

describe('rewriteImageRefs', () => {
  it('rewrites only mapped sources and preserves title syntax', () => {
    const markdown = '![A](../shared/a.png "说明") 与 ![B](./assets/b.png)'
    const output = rewriteImageRefs(
      markdown,
      new Map([['../shared/a.png', 'assets/a.png']])
    )
    expect(output).toBe('![A](assets/a.png "说明") 与 ![B](./assets/b.png)')
  })

  it('returns the original markdown when nothing is mapped', () => {
    const markdown = '![A](./assets/a.png)'
    expect(rewriteImageRefs(markdown, new Map())).toBe(markdown)
  })
})

describe('toSafeZipPath', () => {
  it('normalises relative paths for the archive', () => {
    expect(toSafeZipPath('./assets/a.png', 'a.png', 'assets')).toBe('assets/a.png')
    expect(toSafeZipPath('assets/%E7%A4%BA%E6%84%8F.png', 'x.png', 'assets')).toBe('assets/示意.png')
  })

  it('falls back to the asset folder for escaping paths', () => {
    expect(toSafeZipPath('../shared/a.png', 'a.png', 'assets')).toBe('assets/a.png')
    expect(toSafeZipPath('C:/pictures/a.png', 'a.png', 'media')).toBe('media/a.png')
    expect(toSafeZipPath('/root/a.png', 'a.png', 'media')).toBe('media/a.png')
  })
})
