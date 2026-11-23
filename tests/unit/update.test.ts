import { describe, expect, it } from 'vitest'
import { newerVersion } from '@shared/update'

describe('稳定版更新', () => {
  it('按数字比较 GitHub 版本号，不安装当前或更低版本', () => {
    expect(newerVersion('v1.10.0', '1.9.1')).toBe(true)
    expect(newerVersion('v1.0.1', '1.0.1')).toBe(false)
    expect(newerVersion('v1.0.9', '1.2.0')).toBe(false)
    expect(newerVersion('v2.0.0', '1.99.9')).toBe(true)
  })

  it('忽略预发布和错误的发布标签', () => {
    expect(newerVersion('v2.0.0-rc.1', '1.0.0')).toBe(false)
    expect(newerVersion('latest', '1.0.0')).toBe(false)
  })
})
