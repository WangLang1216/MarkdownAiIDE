/**
 * 首次启动的示例工作区。只在用户没有最近工作区时创建，不覆盖已有文件。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../utils/logger'

const SAMPLE = `# 让想法，自然成文

一个安静的空间，装下你所有的灵感。

## 从一段文字开始

好的工具应该隐于幕后，让你专注于内容本身。
在小彭友，Markdown 的简洁与所见即所得的直觉相遇，
写下的每个字，都以它应有的样子呈现。

> 少一点打扰，多一点心流。让写作回归写作。

## 为你的写作，留一点空间

- 自然书写：输入 Markdown，即刻看到排版结果
- 灵活组织：拖入元素，让复杂内容变得有条理
- AI 相伴：需要时展开，不需要时安静收起

### 熟悉的语法，更轻松的表达

| 你想做的事 | 轻松实现 |
| --- | --- |
| 组织内容 | 标题、列表与任务清单 |
| 表达逻辑 | 代码、公式与流程图 |
| 分享成果 | PDF、HTML 与更多格式 |

## 让 AI 成为你的写作搭档

选择你信任的模型，从本地到云端。润色一段文字，
梳理一页想法，下一句的灵感也许就在这里。

## 保持简单，保持专注

所有文稿都保存在本地。每个想法，都属于你。
`

const REQUIREMENTS = `# 桌面编辑器需求

以内容为中心，以自然交互降低学习成本。

## 产品定位

免费开源、本地优先的桌面 Markdown 编辑器。

## 核心体验

- 单界面即时渲染
- 左侧元素与文件切换
- 右侧目录定位
- 可收起的 AI 写作助手

## 多模式写作

源码与预览并排，始终保持清晰。
`

const NOTES = `# 交互设计笔记

设计不是添加更多，而是让每一步自然发生。

## 渐进显露

让工具在需要时出现。

## 直接操作

- 元素可以拖入正文
- 目录可以拖动调宽
- AI 建议由用户确认后应用

## 清晰反馈

用轻量反馈回应每一次操作。
`

/** 准备并返回首启演示工作区，不覆盖已有示例文件。 */
export async function ensureDemoWorkspace(root: string): Promise<string> {
  await mkdir(join(root, '产品设计'), { recursive: true })
  const files: Array<[string, string]> = [
    [join(root, '产品设计', '让想法，自然成文.md'), SAMPLE],
    [join(root, '产品设计', '桌面编辑器需求.md'), REQUIREMENTS],
    [join(root, '产品设计', '交互设计笔记.md'), NOTES],
    [join(root, 'README.md'), '# 欢迎使用小彭友\n\n打开一个文稿，让想法自然成文。\n']
  ]
  for (const [path, content] of files) {
    const exists = await stat(path)
      .then(() => true)
      .catch(() => false)
    if (!exists) await writeFile(path, content, 'utf8')
  }
  logger.info('demo', '示例工作区就绪', { root })
  return root
}

/** 计算演示工作区默认打开的文稿路径。 */
export function demoDefaultDocument(root: string): string {
  return join(root, '产品设计', '让想法，自然成文.md')
}
