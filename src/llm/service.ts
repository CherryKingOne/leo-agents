import { LeoError } from '../errors.js'
import type { Context } from '../kernel/context.js'
import { definePlugin, type PluginDefinition } from '../kernel/plugin.js'
import type { Disposer, EventDef } from '../kernel/types.js'
import type { LlmProvider, LlmRequest, LlmService, LlmStreamEvent, ModelInfo, ProviderModels, ResolvedModel, StreamOptions } from './types.js'

declare module '../kernel/types.js' {
  interface Services {
    llm: LlmService
  }
  interface Events {
    /** 每次模型调用都会经过的中间件；可改写 request，或包裹/替换返回的事件流 */
    'llm/stream': EventDef<
      'waterfall',
      { provider: LlmProvider; request: LlmRequest; opts: StreamOptions },
      AsyncIterable<LlmStreamEvent>
    >
  }
}

/** 近似 token 估算：按 UTF-8 字节数 / 3.5，偏保守（中英文混合时略高估） */
export function approximateTokens(request: Omit<LlmRequest, 'model'>): number {
  const text = JSON.stringify({ s: request.system, m: request.messages, t: request.tools })
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.5)
}

class DefaultLlmService implements LlmService {
  private readonly list: LlmProvider[] = []
  private defaultId: string | undefined

  constructor(private readonly ctx: Context) {}

  registerProvider(provider: LlmProvider, opts: { default?: boolean } = {}): Disposer {
    if (this.list.some((p) => p.id === provider.id)) {
      throw new LeoError('internal', `LLM provider "${provider.id}" is already registered`)
    }
    this.list.push(provider)
    if (opts.default || !this.defaultId) this.defaultId = provider.id
    return () => {
      const i = this.list.indexOf(provider)
      if (i >= 0) this.list.splice(i, 1)
      if (this.defaultId === provider.id) this.defaultId = this.list[0]?.id
    }
  }

  providers() {
    return [...this.list]
  }

  resolve(model: string): ResolvedModel {
    const slash = model.indexOf('/')
    if (slash > 0) {
      const provider = this.list.find((p) => p.id === model.slice(0, slash))
      if (provider) {
        const id = model.slice(slash + 1)
        return withInfo(provider, id)
      }
    }
    const provider = this.list.find((p) => p.id === this.defaultId)
    if (!provider) throw new LeoError('service_missing', `No LLM provider can serve model "${model}"`)
    return withInfo(provider, model)
  }

  stream(model: string, request: Omit<LlmRequest, 'model'>, opts: StreamOptions): AsyncIterable<LlmStreamEvent> {
    const { provider, model: id } = this.resolve(model)
    const ctx = this.ctx
    return {
      async *[Symbol.asyncIterator]() {
        const stream = await ctx.waterfall('llm/stream', { provider, request: { ...request, model: id }, opts }, (p) =>
          p.provider.stream(p.request, p.opts),
        )
        yield* stream
      },
    }
  }

  async countTokens(model: string, request: Omit<LlmRequest, 'model'>): Promise<number> {
    const { provider, model: id } = this.resolve(model)
    if (provider.countTokens) return provider.countTokens({ ...request, model: id })
    return approximateTokens(request)
  }

  async models(opts: { refresh?: boolean; signal?: AbortSignal; provider?: string } = {}): Promise<ProviderModels[]> {
    const list = opts.provider ? this.list.filter((p) => p.id === opts.provider) : [...this.list]
    if (opts.provider && !list.length) throw new LeoError('invalid_request', `Unknown LLM provider "${opts.provider}"`)
    return Promise.all(
      list.map(async (provider): Promise<ProviderModels> => {
        let error: string | undefined
        let models: ModelInfo[] | undefined
        if (opts.refresh && provider.refreshModels) {
          try {
            models = await provider.refreshModels(opts.signal ? { signal: opts.signal } : {})
          } catch (err) {
            error = (err as Error).message
          }
        }
        if (!models) {
          try {
            models = provider.listModels?.() ?? []
          } catch (err) {
            error ??= (err as Error).message
            models = []
          }
        }
        const visible = models.filter((m) => !m.alias)
        return error ? { provider, models: visible, error } : { provider, models: visible }
      }),
    )
  }
}

function withInfo(provider: LlmProvider, model: string): ResolvedModel {
  const info = provider.getModelInfo?.(model)
  return info ? { provider, model, info } : { provider, model }
}

/** 核心插件：提供 `llm` 服务 */
export const llmPlugin = definePlugin({
  name: 'leo:llm',
  apply(ctx) {
    ctx.provide('llm', new DefaultLlmService(ctx))
  },
})

/**
 * 把一个 LlmProvider 实例包装成插件：加载即注册到 `llm` 服务，卸载即撤销。
 * 具体厂商（DeepSeek、OpenAI 兼容端点……）不在底座里，由模型供应商插件（leo-plugin 的 provider / provider-*）提供；
 * 代码里自己实现了 LlmProvider 时用它挂上去：`createLeo({ plugins: [providerPlugin(myProvider, { default: true })] })`
 */
export function providerPlugin(provider: LlmProvider, opts: { default?: boolean } = {}): PluginDefinition {
  return definePlugin({
    name: `leo:provider:${provider.id}`,
    inject: ['llm'],
    apply(ctx) {
      void ctx.effect(() => ctx.get('llm').registerProvider(provider, opts))
    },
  })
}
