import { contextPlugin } from './context/builder.js'
import type { TokenBudgetOptions } from './context/types.js'
import { type Context, Kernel, type PluginRuntime } from './kernel/context.js'
import { createConsoleLogger, type Logger, type LogLevel } from './kernel/logger.js'
import { definePlugin, type PluginLike } from './kernel/plugin.js'
import type { Scope } from './kernel/types.js'
import { llmPlugin } from './llm/service.js'
import type { LlmProvider } from './llm/types.js'
import { agentLoopPlugin } from './loop/service.js'
import type { Agent, AgentOptions } from './loop/types.js'
import { sessionPlugin } from './session/store.js'
import { toolsPlugin, type ToolRegistryOptions } from './tools/registry.js'

/** 把一个 LlmProvider 包装成插件（便于在插件包中分发 provider） */
export function providerPlugin(provider: LlmProvider, opts: { default?: boolean } = {}) {
  return definePlugin({
    name: `leo:provider:${provider.id}`,
    inject: ['llm'],
    apply(ctx) {
      void ctx.effect(() => ctx.get('llm').registerProvider(provider, opts))
    },
  })
}

export interface CreateLeoOptions {
  logger?: Logger
  /** 未传 logger 时默认 console JSON 日志的级别，默认 'warn' */
  logLevel?: LogLevel
  /** 根作用域，例如单租户部署的默认 tenant */
  scope?: Scope
  /** 会话存储：传 dir 使用 JSONL 文件存储，否则内存 */
  sessions?: { dir?: string }
  tools?: ToolRegistryOptions
  context?: TokenBudgetOptions
  /** 要注册的模型提供方，第一个为默认 */
  providers?: LlmProvider[]
  /** 额外插件，按顺序加载；可以用 [plugin, config] 传配置 */
  plugins?: (PluginLike | [PluginLike, unknown])[]
  /** 设为 false 不加载任何核心插件（完全自定义组合） */
  core?: boolean
}

export interface Leo {
  readonly kernel: Kernel
  /** 根 Context：可直接 provide / on / get */
  readonly ctx: Context
  /** 创建 Agent（使用当前的 agentLoop 服务） */
  createAgent(opts: AgentOptions): Agent
  /** 运行时加载插件 */
  plugin<T>(p: PluginLike<T>, config?: T): Promise<PluginRuntime>
  /** 诊断信息：插件树与服务表 */
  describe(): ReturnType<Kernel['describe']>
  dispose(): Promise<void>
}

/**
 * 创建一个 leo 实例：内核 + 核心插件（sessions / llm / tools / context / agentLoop）+ 你的插件。
 *
 * ```ts
 * const leo = await createLeo({
 *   providers: [new OpenAICompatibleProvider({ id: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' })],
 *   plugins: [weatherPlugin],
 * })
 * const agent = leo.createAgent({ model: 'deepseek/deepseek-chat', systemPrompt: '你是一个助手' })
 * for await (const ev of agent.prompt('北京天气如何？')) { ... }
 * ```
 */
export async function createLeo(opts: CreateLeoOptions = {}): Promise<Leo> {
  const kernel = new Kernel({
    logger: opts.logger ?? createConsoleLogger(opts.logLevel ?? 'warn'),
    ...(opts.scope ? { scope: opts.scope } : {}),
  })
  const root = kernel.root
  if (opts.core !== false) {
    await root.plugin(sessionPlugin, opts.sessions)
    await root.plugin(llmPlugin)
    await root.plugin(toolsPlugin, opts.tools)
    await root.plugin(contextPlugin, opts.context)
    await root.plugin(agentLoopPlugin)
  }
  for (const [i, p] of (opts.providers ?? []).entries()) await root.plugin(providerPlugin(p, { default: i === 0 }))
  for (const entry of opts.plugins ?? []) {
    if (Array.isArray(entry)) await root.plugin(entry[0], entry[1])
    else await root.plugin(entry)
  }
  await kernel.ready()

  return {
    kernel,
    ctx: root,
    createAgent: (o) => root.get('agentLoop').create(o),
    plugin: async (p, config) => {
      const rt = await root.plugin(p, config)
      await kernel.ready()
      return rt
    },
    describe: () => kernel.describe(),
    dispose: () => kernel.dispose(),
  }
}
