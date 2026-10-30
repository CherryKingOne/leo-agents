/**
 * 提供方类型注册表：把 `.leo/config.json` 里 `providers.<id>.type` 映射到具体实现。
 *
 * 内置 `openai-compatible`。第三方插件可以注册新类型（例如 `anthropic`、自研网关协议），
 * 用户只需在配置里写 `"type": "anthropic"` 即可使用：
 *
 * ```ts
 * export default definePlugin({
 *   name: 'leo-provider-anthropic',
 *   inject: ['providerKinds'],
 *   apply(ctx) {
 *     void ctx.effect(() => ctx.get('providerKinds').register('anthropic', ({ id, config, apiKey }) => new AnthropicProvider({ id, ...config, apiKey })))
 *   },
 * })
 * ```
 */
import { LeoError } from '../errors.js'
import { definePlugin } from '../kernel/plugin.js'
import type { Disposer } from '../kernel/types.js'
import { OpenAICompatibleProvider } from '../llm/providers/openai.js'
import type { LlmProvider, ModelInfo } from '../llm/types.js'
import type { ProviderConfig } from '../config/types.js'
import { PROVIDER_PRESETS } from './catalog.js'

export interface ProviderFactoryInput {
  id: string
  /** 已与内置预设合并的配置 */
  config: ProviderConfig
  /** 每次调用时解析的密钥（经 credentials 服务） */
  apiKey: () => string | undefined
}

export type ProviderFactory = (input: ProviderFactoryInput) => LlmProvider

export interface ProviderKindRegistry {
  register(kind: string, factory: ProviderFactory): Disposer
  get(kind: string): ProviderFactory | undefined
  kinds(): string[]
}

declare module '../kernel/types.js' {
  interface Services {
    providerKinds: ProviderKindRegistry
  }
}

export function normalizeModels(models: ProviderConfig['models'], fallbackWindow = 128_000): ModelInfo[] | undefined {
  return models?.map((m) => (typeof m === 'string' ? { id: m, contextWindow: fallbackWindow } : (m as ModelInfo)))
}

export const openaiCompatibleFactory: ProviderFactory = ({ id, config, apiKey }) => {
  const preset = PROVIDER_PRESETS[id]
  const baseURL = config.baseURL ?? preset?.baseURL
  if (!baseURL) throw new LeoError('plugin_config_invalid', `Provider "${id}" needs a baseURL`)
  const models = normalizeModels(config.models) ?? preset?.models
  const maxTokensField = config.maxTokensField ?? preset?.maxTokensField
  const envKey = config.apiKeyEnv ?? preset?.envKeys[0]
  return new OpenAICompatibleProvider({
    id,
    baseURL,
    apiKey: () => apiKey() ?? (preset?.keyless ? 'local' : undefined),
    requireApiKey: preset ? !preset.keyless : false,
    ...(envKey ? { apiKeyEnv: envKey } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    ...(models ? { models } : {}),
    ...(maxTokensField ? { maxTokensField } : {}),
    ...(config.sendReasoning !== undefined ? { sendReasoning: config.sendReasoning } : {}),
    ...(config.connectTimeoutMs ? { connectTimeoutMs: config.connectTimeoutMs } : {}),
    ...(config.idleTimeoutMs ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
  })
}

export const providerKindsPlugin = definePlugin({
  name: 'leo:provider-kinds',
  apply(ctx) {
    const map = new Map<string, ProviderFactory>([['openai-compatible', openaiCompatibleFactory]])
    ctx.provide('providerKinds', {
      register(kind, factory) {
        if (map.has(kind)) throw new LeoError('internal', `Provider kind "${kind}" already registered`)
        map.set(kind, factory)
        return () => void map.delete(kind)
      },
      get: (kind) => map.get(kind),
      kinds: () => [...map.keys()],
    })
  },
})
