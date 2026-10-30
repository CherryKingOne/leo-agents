import type { LeoError, LeoErrorCode } from '../errors.js'
import type { Context } from '../kernel/context.js'
import type { TenantContext } from '../kernel/types.js'
import type { FinishReason, ToolChoice } from '../llm/types.js'
import type { AgentMessage, ToolCallBlock, Usage, UserInput } from '../protocol/messages.js'
import type { ToolFilter, ToolResult } from '../tools/types.js'

export interface RunLimits {
  /** 单个 turn 内最多模型请求次数，默认 50 */
  maxSteps: number
  /** 单个 turn 的 token 预算（输入+输出），超出后在下一 step 前停止 */
  maxTurnTokens?: number
  /** 单个 turn 的成本预算（美元），需要模型配置价格或 provider 返回成本 */
  maxTurnCostUsd?: number
  /** 单个 turn 的总超时（毫秒） */
  turnTimeoutMs?: number
}

export interface RetryPolicy {
  /** 每次模型请求的最大尝试次数（含首次），默认 4 */
  maxAttempts: number
  /** 指数退避基数，默认 1000ms */
  baseDelayMs: number
  /** 单次退避上限，默认 30000ms */
  maxDelayMs: number
}

export interface AgentOptions {
  /** 不传则自动生成 */
  id?: string
  /** 会话 id；传入已有 id 即可续聊（历史从会话存储读取） */
  sessionId?: string
  /** `"providerId/model"` 或纯模型名（走默认 provider） */
  model: string
  systemPrompt?: string
  /** 暴露给模型的工具：默认全部；传 filter 选择子集；false 表示不使用工具 */
  tools?: ToolFilter | false
  toolChoice?: ToolChoice
  /** 强制工具串行执行 */
  sequentialTools?: boolean
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stop?: string[]
  providerOptions?: Record<string, unknown>
  tenant?: TenantContext
  /** 任意 agent 状态，供 prompt 片段、插件使用 */
  state?: Record<string, unknown>
  /** 给人看的名字（如子 Agent 的 "sub-agent:explorer"），界面在审批、进度中用它区分来源 */
  label?: string
  limits?: Partial<RunLimits>
  retry?: Partial<RetryPolicy>
}

export interface RunOptions extends Partial<RunLimits> {
  signal?: AbortSignal
}

export type StopReason =
  | 'completed' // 模型给出最终回复
  | 'max_steps'
  | 'budget_exceeded'
  | 'terminated_by_tool' // 本批工具全部 terminate
  | 'length' // 模型因输出长度上限截断，且没有工具调用
  | 'rejected' // 被 agent/pre-step 拒绝
  | 'cancelled'
  | 'timeout'
  | 'error'

/** Agent 对外的流式事件（可直接序列化为 SSE / JSON-RPC 通知） */
export type AgentEvent =
  | { type: 'turn_start'; turnId: string; sessionId: string }
  | { type: 'step_start'; turnId: string; stepId: string; step: number }
  | { type: 'text_delta'; stepId: string; text: string }
  | { type: 'reasoning_delta'; stepId: string; text: string }
  | { type: 'tool_call_delta'; stepId: string; index: number; name?: string; argumentsDelta?: string }
  /** 模型请求失败、即将重试：UI 应丢弃本 step 已显示的增量 */
  | { type: 'retry'; stepId: string; attempt: number; delayMs: number; error: { code: LeoErrorCode; message: string } }
  | { type: 'compaction'; strategy: string; replacesUpTo: string }
  /** 本 step 完整的 assistant 消息（已写入会话） */
  | { type: 'message'; message: AgentMessage }
  | { type: 'tool_start'; call: ToolCallBlock }
  | { type: 'tool_update'; callId: string; partial: unknown }
  | { type: 'tool_result'; result: ToolResult; message: AgentMessage }
  | { type: 'step_end'; stepId: string; finishReason: FinishReason; usage: Usage }
  | { type: 'turn_end'; turnId: string; reason: StopReason; usage: Usage; steps: number; error?: { code: LeoErrorCode; message: string } }

export interface TurnResult {
  turnId: string
  reason: StopReason
  /** 最后一条 assistant 消息的文本 */
  text: string
  usage: Usage
  steps: number
  /** 本 turn 新增的消息（用户、assistant、工具结果） */
  messages: AgentMessage[]
  error?: LeoError
}

export type AgentStatus = 'idle' | 'running' | 'disposed'

export interface Agent {
  readonly id: string
  readonly sessionId: string
  readonly options: Readonly<AgentOptions>
  readonly status: AgentStatus
  /** Agent 作用域 Context（tenant/agentId/sessionId 已注入） */
  readonly ctx: Context<any>
  /** 运行一个 turn，返回事件流。中途 break 迭代会取消本 turn */
  prompt(input: UserInput, opts?: RunOptions): AsyncIterable<AgentEvent>
  /** 运行一个 turn 并等待结束（非流式便捷方法） */
  run(input: UserInput, opts?: RunOptions): Promise<TurnResult>
  /** 运行中插话：在下一个 step 前作为用户消息注入；空闲时在下个 turn 开始时注入 */
  steer(input: UserInput): void
  /** 追加任务：当前 turn 本应结束时，作为新的用户消息继续执行 */
  followUp(input: UserInput): void
  /** 取消当前 turn（未完成的工具调用会补记 cancelled 结果，保证日志可回放） */
  abort(reason?: string): void
  /** 当前可见消息（已应用压缩） */
  messages(): Promise<AgentMessage[]>
  dispose(): Promise<void>
}

/** `ctx.get('agentLoop')`：可整体替换的 loop 驱动 */
export interface AgentLoopService {
  create(opts: AgentOptions): Agent
  get(id: string): Agent | undefined
  list(): Agent[]
}
