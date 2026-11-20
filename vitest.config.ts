import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** 配置基于 Node 的单元测试环境以及与应用一致的路径别名。 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default'
  }
})
