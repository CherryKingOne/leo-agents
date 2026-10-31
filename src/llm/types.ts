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
  /**
   * 思考模式与推理强度。各厂商插件把它翻译成自己的参数（如 DeepSeek 的 `thinking` / `reasoning_effort`）；
   * 不写由模型 / 厂商决定。不支持思考的模型忽略它
   */
  reasoning?: ReasoningOptions
  /** 透传给厂商 API 的额外参数（如 response_format） */
  providerOptions?: Record<string, unknown>
}

/**
 * 推理强度。通用档位：`none` 关闭思考；`minimal` / `low` / `medium` / `high` / `xhigh` / `max` 逐级增强。
 * 每个模型实际支持哪些档位见 `ModelInfo.reasoning.efforts`，厂商插件负责把不支持的档位映射到最接近的一档
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 思考模式开关与推理强度（`LlmRequest.reasoning`、Agent / 配置的 `reasoning`） */
export interface ReasoningOptions {
  /** 是否开启思考模式；不写由模型决定（多数思考模型默认开启） */
  enabled?: boolean
  /** 推理强度；`none` 等同 `enabled: false` */
  effort?: ReasoningEffort
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
  /** 发给厂商 API 的真实模型 id，如 `deepseek-flash` */
  id: string
  /** 展示名，如 “DeepSeek-V4.1-Flash” */
  name?: string
  contextWindow: number
  maxOutputTokens?: number
  pricing?: ModelPricing
  /** 接受的输入类型，如 `['text', 'image']` */
  inputModalities?: string[]
  /** 可生成的输出类型，如 `['text']` */
  outputModalities?: string[]
  /** 思考能力；不写表示未知 */
  reasoning?: ModelReasoningInfo
  /** 拥有该模型的组织（厂商 /models 的 owned_by） */
  ownedBy?: string
  /** 别名：仍可使用但不单独展示的旧名字（如已下线、被自动改写的模型名） */
  alias?: boolean
  /** 元信息来源：`remote` 从厂商接口实时获取，`builtin` 插件内置 */
  source?: 'remote' | 'builtin'
}

/** 模型的思考能力（`ModelInfo.reasoning`） */
export interface ModelReasoningInfo {
  /** 是否支持思考模式 */
  supported: boolean
  /** 能否关闭思考 */
  canDisable?: boolean
  /** 不指定时是否开启思考 */
  defaultEnabled?: boolean
  /** 开启思考时可用的推理强度档位，按建议的展示顺序（不含 `none`） */
  efforts?: ReasoningEffort[]
  /** 开启思考且未指定强度时的默认档位 */
  defaultEffort?: ReasoningEffort
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
  /** 可选：已知模型列表（`leo models` 展示）。实现了 refreshModels 时应返回最近一次获取到的结果 */
  listModels?(): ModelInfo[]
  /**
   * 可选：向厂商接口实时获取模型列表与详情（如 `GET /models`），并更新 listModels / getModelInfo 的结果。
   * 获取失败时抛错，调用方会退回 listModels
   */
  refreshModels?(opts?: { signal?: AbortSignal }): Promise<ModelInfo[]>
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
  /**
   * 所有 provider 的模型（不含别名）。`refresh: true` 时先调用各 provider 的 refreshModels 实时获取，
   * 失败的 provider 退回 listModels 并在 `error` 里给出原因
   */
  models(opts?: { refresh?: boolean; signal?: AbortSignal; provider?: string }): Promise<ProviderModels[]>
}

/** `llm.models()` 的一项：一个 provider 及其模型 */
export interface ProviderModels {
  provider: LlmProvider
  models: ModelInfo[]
  /** 实时获取失败的原因（此时 models 为内置列表） */
  error?: string
}
