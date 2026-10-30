/**
 * 与模型厂商无关的消息协议。Agent Loop、会话日志、上下文构建都使用这套类型，
 * 由 LLM Provider 负责与具体厂商格式互转。
 */

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  /** data URL 或 http(s) URL */
  url: string
  mimeType?: string
}

/** 模型的推理/思考内容（DeepSeek reasoning_content、Anthropic thinking 等） */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  /** 部分厂商需要回传的签名 */
  signature?: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  /** 已解析的参数；解析失败时为 undefined，原文保存在 rawArguments */
  arguments: unknown
  rawArguments: string
}

export type ContentBlock = TextBlock | ImageBlock | ReasoningBlock | ToolCallBlock

/**
 * 消息角色。可通过 `(string & {})` 扩展自定义角色（如 'ui/notice'），
 * 自定义角色默认不会发送给模型，需要在 `context/convert` 事件中自行转换。
 */
export type Role = 'system' | 'user' | 'assistant' | 'tool' | (string & {})

export interface AgentMessage {
  id: string
  role: Role
  content: ContentBlock[]
  /** role === 'tool' 时：对应的 tool call id */
  toolCallId?: string
  /** role === 'tool' 时：工具名 */
  toolName?: string
  /** role === 'tool' 时：是否为错误结果 */
  isError?: boolean
  createdAt: number
  /** 任意元数据。`meta.hidden === true` 的消息不会发送给模型 */
  meta?: Record<string, unknown>
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** 命中 prompt cache 的输入 token */
  cachedInputTokens?: number
  reasoningTokens?: number
  /** Provider 能给出价格时填写（美元） */
  costUsd?: number
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0 })

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  if (!b) return a
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}

/** 用户输入：字符串或内容块 */
export type UserInput = string | ContentBlock[] | { content: string | ContentBlock[]; meta?: Record<string, unknown> }

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export function toolCallsOf(msg: AgentMessage): ToolCallBlock[] {
  return msg.content.filter((b): b is ToolCallBlock => b.type === 'tool_call')
}

let counter = 0
/** 生成有序且全局唯一的 id（时间戳 + 计数 + 随机） */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeInput(input: UserInput): { content: ContentBlock[]; meta?: Record<string, unknown> } {
  if (typeof input === 'string') return { content: [{ type: 'text', text: input }] }
  if (Array.isArray(input)) return { content: input }
  const content = typeof input.content === 'string' ? [{ type: 'text' as const, text: input.content }] : input.content
  return input.meta ? { content, meta: input.meta } : { content }
}
