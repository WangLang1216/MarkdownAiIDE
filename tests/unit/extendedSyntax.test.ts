import { describe, expect, it } from 'vitest'
import {
  definitionPrefixLength,
  findHeadingId,
  isTocLine,
  parseHeadingLine,
  slugifyHeading
} from '@shared/markdown/extended'

describe('扩展语法文本助手', () => {
  it('解析自定义标题 ID，并去掉标记与 ID', () => {
    expect(parseHeadingLine('## 标题锚点 {#anchor-demo}')).toEqual({ text: '标题锚点', id: 'anchor-demo' })
    expect(parseHeadingLine('### 普通标题')).toEqual({ text: '普通标题', id: null })
    expect(parseHeadingLine('# 带空格 {#id-1}   ')).toEqual({ text: '带空格', id: 'id-1' })
  })

  it('定位标题 ID 在整行中的起点', () => {
    const found = findHeadingId('## 小节 {#section-id}')
    expect(found?.id).toBe('section-id')
    expect('## 小节 {#section-id}'.slice(0, found?.index)).toBe('## 小节')
    expect(findHeadingId('## 没有 ID')).toBeNull()
  })

  it('由标题文字生成锚点，重复标题交由调用方去重', () => {
    expect(slugifyHeading('高亮 与 上下标')).toBe('高亮-与-上下标')
    expect(slugifyHeading('Hello, World!')).toBe('hello-world')
    expect(slugifyHeading('  ')).toBe('section')
  })

  it('识别目录标记行', () => {
    expect(isTocLine('[TOC]')).toBe(true)
    expect(isTocLine('  [toc]  ')).toBe(true)
    expect(isTocLine('目录')).toBe(false)
  })

  it('识别定义列表定义行，并要求冒号后有内容', () => {
    expect(definitionPrefixLength(': 定义内容')).toBe(2)
    expect(definitionPrefixLength('   : 缩进定义')).toBe(5)
    expect(definitionPrefixLength(': ')).toBe(0)
    expect(definitionPrefixLength('：全角冒号不算')).toBe(0)
  })
})
