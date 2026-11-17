import type { Disposer, TenantContext } from '../kernel/types.js'
import type { ModelInfo, ToolSchema } from '../llm/types.js'
import type { AgentMessage } from '../protocol/messages.js'

/** 提示词分层：稳定的放前面（利于 prompt cache），易变的放后面 */
export type PromptLayer = 'platform' | 'tenant' | 'agent' | 'task' | 'runtime'
export const LAYER_ORDER: readonly PromptLayer[] = ['platform', 'tenant', 'agent', 'task', 'runtime']

export interface AssembleInput {
  agentId: string
  sessionId: string
  turnId: string
  model: string
  tenant?: TenantContext
  /** Agent 自带的 system prompt（作为 agent 层片段） */
  systemPrompt?: string
  /** Agent 级别的任意状态，供片段渲染使用 */
  state: Record<string, unknown>
}

/** system prompt 片段。插件通过 `ctx.get('context').registerSection()` 注入 */
export interface PromptSection {
  id: string
  layer: PromptLayer
  /**
   * 0.2.3：提供该片段的插件名，只用于上下文组成统计（写入 `llm/request.breakdown`）。
   * 不填时按 id 的第一段推断（`skills.catalog` → `skills`，`mcp/instructions` → `mcp`）
   */
  owner?: string
  /** 同层内升序，默认 100 */
  priority?: number
  /** 返回 undefined / 空串表示本次不注入 */
  render(input: AssembleInput): string | undefined | Promise<string | undefined>
}

export interface TokenBudgetOptions {
  /** 模型窗口未知时的默认值，默认 128k */
  defaultContextWindow?: number
  /** 为输出预留的 token，默认取请求的 maxOutputTokens，否则 8192 */
  reserveOutputTokens?: number
  /** 超过 (窗口 - 输出预留) × softLimitRatio 即尝试压缩，默认 0.85 */
  softLimitRatio?: number
  /** 压缩时保留最近的完整轮数，默认 2 */
  keepRecentTurns?: number
}

export interface CompactionInput {
  /** 可被压缩的较早消息（已在用户消息边界切分，不会拆开工具调用对） */
  messages: AgentMessage[]
  sessionId: string
  model: string
  signal: AbortSignal
}

/** 压缩策略：把较早的消息变成一条摘要消息 */
export interface CompactionStrategy {
  name: string
  compact(input: CompactionInput): Promise<AgentMessage>
}

export interface BuildInput extends AssembleInput {
  /** 会话当前可见消息（已应用历史压缩） */
  messages: AgentMessage[]
  tools: ToolSchema[]
  maxOutputTokens?: number
  /** 强制压缩（模型返回 context_overflow 时） */
  forceCompact?: boolean
  signal: AbortSignal
}

/** 0.2.3：一次请求的上下文组成（全部为本地近似 token，与 `estimatedTokens` 同一口径的字节估算） */
export interface ContextBreakdown {
  /** 估算方式：目前固定为 `approx`（UTF-8 字节 / 3.5） */
  tokenizer: 'approx'
  /** system prompt 的各个片段，按拼接顺序；只列本次实际注入的（render 返回非空） */
  sections: { id: string; layer: PromptLayer; owner: string; tokens: number }[]
  /** 每个工具定义（name + description + 参数 schema）的 token */
  tools: Record<string, number>
  /** 发给模型的消息（压缩、裁剪之后）的 token 合计 */
  messages: number
  /** 模型窗口（未知时为默认值）、为输出预留的 token、硬上限（窗口 - 预留） */
  contextWindow: number
  reserveOutputTokens: number
  limitTokens: number
  /** 自动压缩的软阈值（limit × softLimitRatio） */
  softLimitTokens: number
}

export interface BuiltContext {
  system: string
  messages: AgentMessage[]
  tools: ToolSchema[]
  estimatedTokens: number
  limitTokens: number
  modelInfo?: ModelInfo
  /** 稳定前缀 + 消息 id 的哈希，用于回放校验与缓存诊断 */
  fingerprint: string
  /** 0.2.3：上下文组成，调用方写入 `llm/request.breakdown` */
  breakdown?: ContextBreakdown
  /** 本次构建发生了压缩：调用方应把它写入会话日志 */
  compaction?: { summary: AgentMessage; replacesUpTo: string; strategy: string }
}

/** `ctx.get('context')`：上下文构建器 */
export interface ContextService {
  registerSection(section: PromptSection): Disposer
  /** 替换压缩策略（默认 truncate） */
  setCompactionStrategy(strategy: CompactionStrategy): Disposer
  build(input: BuildInput): Promise<BuiltContext>
}
