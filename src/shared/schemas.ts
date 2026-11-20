/**
 * 内部协议的运行时校验（Zod）。
 * 模型输出、IPC 入参与磁盘记录都先经过这里，避免“编译期类型正确、运行时结构错误”。
 */

import { z } from 'zod'

/** 校验表格单元格的文本和识别状态。 */
export const CellSchema = z.object({
  text: z.string().max(1000),
  status: z.enum(['recognized', 'uncertain', 'empty'])
})

/** 校验文稿 ID、基础修订号及预期正文哈希。 */
export const VersionGuardSchema = z.object({
  documentId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  expectedContentHash: z.string().min(8)
})

/** 校验插入内容使用的章节标识及相对位置。 */
export const TargetAnchorSchema = z.object({
  sectionId: z.string().nullable(),
  position: z.enum(['after_heading', 'section_end', 'document_end'])
})

/** 校验结构化表格的列数、行数、表头和数据行字段。 */
export const TablePayloadSchema = z.object({
  columnCount: z.number().int().min(1).max(24),
  totalRows: z.number().int().min(1).max(400),
  header: z.array(CellSchema).max(24),
  rows: z.array(z.array(CellSchema).max(24)).max(400)
})

const operationId = z.string().min(1).max(80).optional()

/** 校验带有目标、版本保护和表格载荷的插入操作。 */
export const InsertTableSchema = z.object({
  kind: z.literal('insert_table'),
  operationId,
  guard: VersionGuardSchema,
  anchor: TargetAnchorSchema,
  table: TablePayloadSchema,
  caption: z.string().max(500).optional()
})

/** 校验按锚点插入 Markdown 的操作输入。 */
export const InsertMarkdownSchema = z.object({
  kind: z.literal('insert_markdown'),
  operationId,
  guard: VersionGuardSchema,
  anchor: TargetAnchorSchema,
  markdown: z.string().min(1).max(200_000)
})

/** 校验带区间和旧文本断言的替换操作输入。 */
export const ReplaceRangeSchema = z.object({
  kind: z.literal('replace_range'),
  operationId,
  guard: VersionGuardSchema,
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  expectedOldText: z.string().max(200_000),
  newText: z.string().max(200_000)
})

/** 校验新建工作区文稿的路径和正文输入。 */
export const CreateDocumentSchema = z.object({
  kind: z.literal('create_document'),
  operationId,
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1).max(500),
  content: z.string().max(500_000),
  ifExists: z.literal('fail')
})

/** 校验删除文稿所需的目标及版本保护。 */
export const DeleteDocumentSchema = z.object({
  kind: z.literal('delete_document'),
  operationId,
  guard: VersionGuardSchema,
  recovery: z.literal('trash_or_recovery')
})

/** 按 kind 区分并校验每类变更操作。 */
export const ChangeOperationSchema = z.discriminatedUnion('kind', [
  InsertTableSchema,
  InsertMarkdownSchema,
  ReplaceRangeSchema,
  CreateDocumentSchema,
  DeleteDocumentSchema
])

/** 校验模型提交的提案外层结构和操作列表；不代替执行前的业务校验。 */
export const ProposalSchema = z.object({
  summary: z.string().min(1).max(400),
  operations: z.array(ChangeOperationSchema).min(1).max(20),
  attachmentIds: z.array(z.string()).max(20).optional(),
  sourceIds: z.array(z.string()).max(20).optional(),
  sourceSetDigest: z.string().optional(),
  styleDigest: z.string().optional()
})

/** 由提案校验 schema 推导出的解析结果类型。 */
export type ParsedProposal = z.infer<typeof ProposalSchema>

/** 校验预测请求的文稿版本、光标位置和参考上下文。 */
export const PredictionRequestSchema = z.object({
  documentId: z.string().min(1),
  providerId: z.string().optional(),
  revision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  selection: z
    .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
    .optional(),
  sourceIds: z.array(z.string()).max(20),
  styleProfileId: z.string().optional(),
  trigger: z.enum(['manual', 'auto'])
})

/** 校验 Agent 任务启动所需的提示、作用域和上下文选择。 */
export const StartTaskSchema = z.object({
  documentId: z.string().nullable(),
  prompt: z.string().min(1).max(20_000),
  scope: z.enum(['selection', 'document', 'workspace']),
  selection: z
    .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
    .optional(),
  providerId: z.string().optional(),
  attachmentIds: z.array(z.string()).max(20),
  sourceIds: z.array(z.string()).max(20),
  mode: z.enum(['edit', 'ask']),
  styleProfileId: z.string().optional()
})

/** 从模型返回中提取 JSON：容忍 ```json 包裹与前后解释文字 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

/** 将 Zod 校验失败转换为可读信息 */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join('.') || '根对象'}: ${issue.message}`)
    .join('；')
}
