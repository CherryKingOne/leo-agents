import type { Disposer, TenantContext } from '../kernel/types.js'
import type { AgentMessage, Usage } from '../protocol/messages.js'

/** 发送给模型的工具描述（JSON Schema） */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

/** 厂商无关的模型请求。Provider 负责转换为具体 API 格式 */
export interface LlmRequest {
  /** 模型 id（已去掉 provider 前缀） */
  model: string
  system?: string
  messages: AgentMessage[]
  tools?: ToolSchema[]
  toolChoice?: ToolChoice
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stop?: string[]
  /** 透传给厂商 API 的额外参数（如 response_format、reasoning_effort） */
  providerOptions?: Record<string, unknown>
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other'

/** 统一的流式事件词汇。所有 Provider 都必须输出这套事件 */
export type LlmStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string; signature?: string }
  /** 工具调用增量：按 index 聚合；id/name 通常只在首个分片出现，argumentsDelta 为 JSON 片段 */
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'done'; finishReason: FinishReason }

export interface ModelPricing {
  /** 每百万输入 token 价格（美元） */
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
}

export interface ModelInfo {
  id: string
  contextWindow: number
  maxOutputTokens?: number
  pricing?: ModelPricing
}

export interface StreamOptions {
  signal: AbortSignal
  tenant?: TenantContext
}

/**
 * 模型提供方接口。实现它并通过 `llm.registerProvider()` 注册，即可接入新厂商、
 * 私有化部署、或者做路由/降级的“元 Provider”。
 *
 * 约定：
 * - `stream` 必须遵守 `signal`，取消时尽快结束；
 * - 失败时抛出 LeoError 并给出正确的 code（rate_limit / overloaded / context_overflow ...），
 *   Agent Loop 依赖它决定重试策略；
 * - 最后必须产出一个 `done` 事件。
 */
export interface LlmProvider {
  readonly id: string
  stream(request: LlmRequest, opts: StreamOptions): AsyncIterable<LlmStreamEvent>
  /** 可选：精确计算 token 数。不提供时上下文构建使用近似估算 */
  countTokens?(request: LlmRequest): number | Promise<number>
  /** 可选：模型元信息（上下文窗口、价格），用于预算与计费 */
  getModelInfo?(model: string): ModelInfo | undefined
  /** 可选：显示名（`leo models` / `leo doctor` 展示），如 “DeepSeek” */
  readonly name?: string
  /** 可选：未指定模型时用的模型 id（不带前缀）。宿主没配置 `model` 时，默认 provider 的这个模型就是默认模型 */
  readonly defaultModel?: string
  /** 可选：已知模型列表（`leo models` 展示） */
  listModels?(): ModelInfo[]
  /**
   * 可选：当前是否可用及原因（例如缺密钥）。不提供视为可用。
   * 不可用的 provider 仍可注册（这样 `leo doctor` 能看到它缺什么），但不会被选作默认模型
   */
  status?(): ProviderStatusInfo
}

/** provider 自己汇报的状态（见 `LlmProvider.status`） */
export interface ProviderStatusInfo {
  ready: boolean
  /** 不可用的原因，如 “no API key” */
  reason?: string
  /** 端点地址，仅展示 */
  baseURL?: string
  /** 密钥情况（脱敏），仅展示 */
  credential?: { configured: boolean; masked: string; source?: string }
  /** 由哪个插件 / 驱动提供，仅展示，如 “provider-deepseek” */
  via?: string
}

export interface ResolvedModel {
  provider: LlmProvider
  /** 去掉前缀后的模型 id */
  model: string
  info?: ModelInfo
}

/** `ctx.get('llm')`：模型提供方注册表 + 统一调用入口 */
export interface LlmService {
  /** 注册 Provider；建议包在 `ctx.effect(() => llm.registerProvider(p))` 里，卸载时自动撤销 */
  registerProvider(provider: LlmProvider, opts?: { default?: boolean }): Disposer
  providers(): LlmProvider[]
  /** 解析 `"providerId/model"` 或纯 `"model"`（使用默认 provider） */
  resolve(model: string): ResolvedModel
  /**
   * 调用模型（流式）。经过 `llm/stream` waterfall，中间件可改写请求、包裹事件流
   * （用于缓存、审计、脱敏、路由等）。
   */
  stream(model: string, request: Omit<LlmRequest, 'model'>, opts: StreamOptions): AsyncIterable<LlmStreamEvent>
  /** 估算 token：优先使用 provider.countTokens，否则按字符近似 */
  countTokens(model: string, request: Omit<LlmRequest, 'model'>): Promise<number>
}
