import type { z } from 'zod'
import type { Context } from '../kernel/context.js'
import type { Logger } from '../kernel/logger.js'
import type { Disposer, TenantContext } from '../kernel/types.js'
import type { ToolSchema } from '../llm/types.js'
import type { ContentBlock, ToolCallBlock } from '../protocol/messages.js'

/** 能力型权限声明，例如 `{ kind: 'fs.write', paths: ['/workspace/**'] }`、`{ kind: 'net.fetch', hosts: [...] }` */
export interface Permission {
  kind: string
  [key: string]: unknown
}

/** 直接用 JSON Schema 描述参数（不做运行时校验，或自行在 execute 中校验） */
export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface ToolExecContext {
  callId: string
  toolName: string
  agentId: string
  sessionId: string
  turnId: string
  tenant?: TenantContext
  /** 必须遵守：取消或超时时 abort */
  signal: AbortSignal
  /** 流式进度（会转发为 AgentEvent `tool_update`） */
  onUpdate(partial: unknown): void
  /** Agent 作用域的 Context，可 `ctx.get(...)` 取服务 */
  ctx: Context<any>
  logger: Logger
}

/**
 * 工具的结构化返回。普通返回值（字符串 / 任意 JSON）会自动转换；
 * 需要设置 isError / terminate 时用 `toolOutput()` 构造。
 */
export interface ToolOutput {
  content: string | ContentBlock[]
  /** 业务失败（模型可见），例如“文件不存在” */
  isError?: boolean
  /** 本批工具都 terminate 时，Agent Loop 不再请求模型、直接结束 turn */
  terminate?: boolean
  /** 不发送给模型的结构化数据（UI、审计） */
  details?: unknown
}

export interface ToolDefinition<A = any, R = any> {
  /** `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`，第三方插件建议加前缀防冲突 */
  name: string
  title?: string
  /** 给模型看的说明：做什么、什么时候用、注意事项 */
  description: string
  /** zod schema（推荐，自动校验 + 生成 JSON Schema）或 JSON Schema 对象 */
  parameters: z.ZodType<A> | JsonSchemaObject
  /** 所需权限，供权限/审批插件在 `tools/pre-execute` 中裁决 */
  permissions?: Permission[]
  /** 'sequential'：只要本批有它，整批串行执行（如会修改同一工作区的工具） */
  executionMode?: 'parallel' | 'sequential'
  /** 超时（毫秒），默认使用注册表配置（120s） */
  timeoutMs?: number
  /** 是否幂等。幂等工具失败时会按 maxRetries 自动重试 */
  idempotent?: boolean
  maxRetries?: number
  /** 标签：用于按场景筛选工具集 */
  tags?: string[]
  execute(args: A, exec: ToolExecContext): R | Promise<R>
  /** 自定义给模型的呈现；不提供时字符串原样、对象 JSON 序列化 */
  render?(value: R, args: A): string | ContentBlock[] | ToolOutput
}

export interface ToolResult {
  callId: string
  name: string
  content: ContentBlock[]
  isError: boolean
  terminate: boolean
  details?: unknown
  /** 基础设施错误码（tool_not_found / tool_invalid_args / tool_denied / tool_timeout / tool_error / cancelled） */
  errorCode?: string
  durationMs: number
}

export type ToolDecision =
  | { action: 'allow'; args?: unknown }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason?: string }

export interface PreExecutePayload {
  call: ToolCallBlock
  tool: ToolDefinition
  args: unknown
  agentId: string
  sessionId: string
  turnId: string
  tenant?: TenantContext
}

export interface ApprovalRequest extends PreExecutePayload {
  reason?: string
}

/**
 * 可选服务 `approval`：人工/自动审批。未提供时，`ask` 决策一律拒绝（fail closed）。
 */
export interface ApprovalService {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }>
}

export interface BatchContext {
  agentId: string
  sessionId: string
  turnId: string
  tenant?: TenantContext
  signal: AbortSignal
  ctx: Context<any>
  /** 强制整批串行 */
  sequential?: boolean
  onUpdate?(callId: string, partial: unknown): void
  /** 某个工具开始执行时回调（预检通过后） */
  onStart?(call: ToolCallBlock): void
}

export interface ToolFilter {
  names?: string[]
  tags?: string[]
}

/** `ctx.get('tools')`：工具注册表 + 受控执行管线 */
export interface ToolRegistry {
  /** 注册工具；建议 `ctx.effect(() => tools.register(def))`，卸载时自动撤销 */
  register(def: ToolDefinition): Disposer
  get(name: string): ToolDefinition | undefined
  list(filter?: ToolFilter): ToolDefinition[]
  /** 生成发送给模型的 JSON Schema 列表 */
  schemas(filter?: ToolFilter): ToolSchema[]
  /** 执行一批工具调用：预检串行、执行并发、结果按原顺序返回。永不抛出，失败转为 isError 结果 */
  executeBatch(calls: ToolCallBlock[], batch: BatchContext): Promise<ToolResult[]>
}
