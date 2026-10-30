/**
 * 模型接入插件。每个提供方都是一个插件：加载即注册到 `llm` 服务，卸载即撤销。
 *
 * ```ts
 * createLeo({ plugins: [deepseek(), openaiCompatible({ id: 'vllm', baseURL: 'http://gpu:8000/v1' })] })
 * ```
 *
 * 第三方提供方（自研协议、Anthropic 原生协议、网关……）写一个插件调用 `ctx.get('llm').registerProvider()` 即可，
 * 密钥统一通过可选服务 `ctx.maybe('credentials')` 获取。
 */
import { LeoError } from '../errors.js'
import { definePlugin, type PluginDefinition } from '../kernel/plugin.js'
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from '../llm/providers/openai.js'
import type { LlmProvider } from '../llm/types.js'
import { PROVIDER_PRESETS } from './catalog.js'
import { type CredentialService, resolveSecret } from '../config/secrets.js'

declare module '../kernel/types.js' {
  interface Services {
    /** 可选：密钥查找服务（createLeoFromConfig / CLI 会提供） */
    credentials: CredentialService
  }
}

/** 把任意 LlmProvider 实例包装成插件 */
export function providerPlugin(provider: LlmProvider, opts: { default?: boolean } = {}): PluginDefinition {
  return definePlugin({
    name: `leo:provider:${provider.id}`,
    inject: ['llm'],
    apply(ctx) {
      void ctx.effect(() => ctx.get('llm').registerProvider(provider, opts))
    },
  })
}

export interface OpenAICompatiblePluginOptions extends Omit<OpenAICompatibleOptions, 'baseURL' | 'apiKey'> {
  id: string
  /** 密钥：字面值 / `$ENV` / `!command` */
  apiKey?: string
  /** 内置预设 id 可省略 baseURL */
  baseURL?: string
  /** 设为默认 provider（纯模型名走它） */
  default?: boolean
}

/**
 * OpenAI 兼容端点插件。密钥优先级：credentials 服务（含 --api-key / credentials.json / 环境变量）> apiKey > apiKeyEnv。
 * 密钥在每次请求时解析，因此 `leo auth set` 写入后无需重启。
 */
export function openaiCompatible(opts: OpenAICompatiblePluginOptions): PluginDefinition {
  const preset = PROVIDER_PRESETS[opts.id]
  return definePlugin({
    name: `leo:provider:${opts.id}`,
    inject: ['llm'],
    apply(ctx) {
      const baseURL = opts.baseURL ?? preset?.baseURL
      if (!baseURL) throw new LeoError('plugin_config_invalid', `Provider "${opts.id}" needs a baseURL`)
      const envKeys = [...(opts.apiKeyEnv ? [opts.apiKeyEnv] : []), ...(preset?.envKeys ?? [])]
      const lookup = () => {
        const creds = ctx.maybe('credentials')
        const key = creds
          ? creds.get({ id: opts.id, ...(opts.apiKey ? { configured: opts.apiKey } : {}), envKeys })
          : (resolveSecret(opts.apiKey) ?? envKeys.map((k) => process.env[k]).find(Boolean))
        return key ?? (preset?.keyless ? 'local' : undefined)
      }
      const models = opts.models ?? preset?.models
      const maxTokensField = opts.maxTokensField ?? preset?.maxTokensField
      const provider = new OpenAICompatibleProvider({
        ...opts,
        baseURL,
        apiKey: lookup,
        requireApiKey: opts.requireApiKey ?? (preset ? !preset.keyless : false),
        ...(envKeys[0] ? { apiKeyEnv: envKeys[0] } : {}),
        ...(models ? { models } : {}),
        ...(maxTokensField ? { maxTokensField } : {}),
      })
      void ctx.effect(() => ctx.get('llm').registerProvider(provider, opts.default ? { default: true } : {}))
    },
  })
}

type PresetOpts = Omit<OpenAICompatiblePluginOptions, 'id'> & { id?: string }
const preset = (id: string) => (o: PresetOpts = {}) => openaiCompatible({ ...o, id: o.id ?? id })

/** 内置预设插件：`deepseek()`、`openai()`、`qwen()`、`moonshot()`、`zhipu()`、`siliconflow()`、`openrouter()`、`ollama()` */
export const deepseek = preset('deepseek')
export const openai = preset('openai')
export const qwen = preset('qwen')
export const moonshot = preset('moonshot')
export const zhipu = preset('zhipu')
export const siliconflow = preset('siliconflow')
export const openrouter = preset('openrouter')
export const ollama = preset('ollama')
