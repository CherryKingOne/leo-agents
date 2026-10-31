import { createHash } from 'node:crypto'
import { LeoError } from '../errors.js'
import type { Context } from '../kernel/context.js'
import { definePlugin } from '../kernel/plugin.js'
import type { Disposer, EventDef } from '../kernel/types.js'
import { type AgentMessage, newId, textOf, toolCallsOf } from '../protocol/messages.js'
import {
  type AssembleInput,
  type BuildInput,
  type BuiltContext,
  type CompactionStrategy,
  type ContextService,
  LAYER_ORDER,
  type PromptSection,
  type TokenBudgetOptions,
} from './types.js'

declare module '../kernel/types.js' {
  interface Services {
    context: ContextService
  }
  interface Events {
    /** 发送前改写消息：裁剪、注入记忆召回、RAG 结果等 */
    'context/transform': EventDef<'waterfall', { messages: AgentMessage[]; input: AssembleInput }, AgentMessage[]>
    /** 把自定义角色转换为模型可见消息；默认丢弃非标准角色与 meta.hidden 消息 */
    'context/convert': EventDef<'waterfall', { messages: AgentMessage[]; input: AssembleInput }, AgentMessage[]>
  }
}

const STANDARD_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

/** 默认压缩策略：丢弃较早消息，用一条说明性消息占位（零额外成本） */
export const truncateStrategy: CompactionStrategy = {
  name: 'truncate',
  async compact({ messages }) {
    return {
      id: newId('msg'),
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Context note: ${messages.length} earlier messages were omitted to fit the context window. Ask the user if you need details from earlier in the conversation.]`,
        },
      ],
      createdAt: Date.now(),
      meta: { compaction: true },
    }
  },
}

/**
 * 摘要式压缩策略：调用模型把较早的对话总结成一条消息。
 * 用法：`ctx.get('context').setCompactionStrategy(createSummarizingStrategy(ctx, { model: 'deepseek/deepseek-flash' }))`
 */
export function createSummarizingStrategy(
  ctx: Context<any>,
  opts: { model: string; maxOutputTokens?: number; instructions?: string },
): CompactionStrategy {
  return {
    name: 'summarize',
    async compact({ messages, signal }) {
      const transcript = messages
        .map((m) => {
          const calls = toolCallsOf(m).map((c) => `[tool_call ${c.name} ${c.rawArguments}]`)
          return `${m.role.toUpperCase()}: ${[textOf(m.content), ...calls].filter(Boolean).join('\n')}`
        })
        .join('\n\n')
      let text = ''
      for await (const ev of ctx.get('llm').stream(
        opts.model,
        {
          system:
            opts.instructions ??
            'Summarize the conversation so far for an AI agent that will continue it. Keep: user goals, decisions, facts, file paths, IDs, open tasks, and tool results that still matter. Be concise and factual.',
          messages: [{ id: newId('msg'), role: 'user', content: [{ type: 'text', text: transcript }], createdAt: Date.now() }],
          maxOutputTokens: opts.maxOutputTokens ?? 2048,
        },
        { signal },
      )) {
        if (ev.type === 'text_delta') text += ev.text
      }
      return {
        id: newId('msg'),
        role: 'user',
        content: [{ type: 'text', text: `[Summary of earlier conversation]\n${text.trim()}` }],
        createdAt: Date.now(),
        meta: { compaction: true },
      }
    },
  }
}

/**
 * 修复消息序列，保证可以被任何厂商接受：
 * - 每个 assistant tool_call 后都必须有对应的 tool 结果（进程崩溃等导致缺失时补一个错误结果）；
 * - 丢弃找不到对应 tool_call 的孤立 tool 消息。
 */
export function sanitizeMessages(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'tool') continue // 由前面的 assistant 统一收集
    out.push(m)
    if (m.role !== 'assistant') continue
    const calls = toolCallsOf(m)
    if (!calls.length) continue
    const results = new Map<string, AgentMessage>()
    let j = i + 1
    while (j < messages.length && messages[j]!.role === 'tool') {
      const t = messages[j]!
      if (t.toolCallId) results.set(t.toolCallId, t)
      j++
    }
    for (const c of calls) {
      out.push(
        results.get(c.id) ?? {
          id: newId('msg'),
          role: 'tool',
          toolCallId: c.id,
          toolName: c.name,
          isError: true,
          content: [{ type: 'text', text: 'Error: tool execution was interrupted and produced no result.' }],
          createdAt: m.createdAt,
        },
      )
    }
    i = j - 1
  }
  return out
}

class DefaultContextService implements ContextService {
  private readonly sections: PromptSection[] = []
  private readonly strategies: CompactionStrategy[] = []
  private readonly budget: Required<Omit<TokenBudgetOptions, 'reserveOutputTokens'>> & { reserveOutputTokens?: number }

  constructor(
    private readonly ctx: Context<any>,
    opts: TokenBudgetOptions = {},
  ) {
    this.budget = {
      defaultContextWindow: opts.defaultContextWindow ?? 128_000,
      softLimitRatio: opts.softLimitRatio ?? 0.85,
      keepRecentTurns: opts.keepRecentTurns ?? 2,
      ...(opts.reserveOutputTokens !== undefined ? { reserveOutputTokens: opts.reserveOutputTokens } : {}),
    }
  }

  registerSection(section: PromptSection): Disposer {
    if (this.sections.some((s) => s.id === section.id)) throw new LeoError('internal', `Prompt section "${section.id}" already registered`)
    this.sections.push(section)
    return () => {
      const i = this.sections.indexOf(section)
      if (i >= 0) this.sections.splice(i, 1)
    }
  }

  setCompactionStrategy(strategy: CompactionStrategy): Disposer {
    this.strategies.push(strategy)
    return () => {
      const i = this.strategies.indexOf(strategy)
      if (i >= 0) this.strategies.splice(i, 1)
    }
  }

  private get strategy(): CompactionStrategy {
    return this.strategies[this.strategies.length - 1] ?? truncateStrategy
  }

  private async renderSystem(input: AssembleInput): Promise<string> {
    const all: PromptSection[] = [...this.sections]
    if (input.systemPrompt) all.push({ id: 'agent.system', layer: 'agent', priority: 0, render: () => input.systemPrompt })
    all.sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || (a.priority ?? 100) - (b.priority ?? 100))
    const parts: string[] = []
    for (const s of all) {
      const text = await s.render(input)
      if (text?.trim()) parts.push(text.trim())
    }
    return parts.join('\n\n')
  }

  async build(input: BuildInput): Promise<BuiltContext> {
    const llm = this.ctx.get('llm')
    const resolved = llm.resolve(input.model)
    const system = await this.renderSystem(input)

    let messages = await this.ctx.waterfall('context/transform', { messages: input.messages, input }, (p) => p.messages)
    messages = await this.ctx.waterfall('context/convert', { messages, input }, (p) =>
      p.messages.filter((m) => STANDARD_ROLES.has(m.role) && m.meta?.hidden !== true),
    )
    messages = sanitizeMessages(messages)

    const window = resolved.info?.contextWindow ?? this.budget.defaultContextWindow
    const reserve = input.maxOutputTokens ?? this.budget.reserveOutputTokens ?? resolved.info?.maxOutputTokens ?? 8192
    const limit = Math.max(1024, window - reserve)
    const count = (msgs: AgentMessage[]) => llm.countTokens(input.model, { system, messages: msgs, tools: input.tools })

    let estimated = await count(messages)
    let compaction: BuiltContext['compaction']
    const threshold = input.forceCompact ? Math.floor(limit * 0.5) : Math.floor(limit * this.budget.softLimitRatio)
    if (estimated > threshold || input.forceCompact) {
      const cut = this.findCut(messages)
      if (cut > 0) {
        const older = messages.slice(0, cut)
        const summary = await this.strategy.compact({ messages: older, sessionId: input.sessionId, model: input.model, signal: input.signal })
        // 记录到日志的切分点必须是日志里真实存在的消息（排除 sanitize/transform 注入的消息）
        const logged = new Set(input.messages.map((m) => m.id))
        const anchor = [...older].reverse().find((m) => logged.has(m.id))
        if (anchor) compaction = { summary, replacesUpTo: anchor.id, strategy: this.strategy.name }
        messages = [summary, ...messages.slice(cut)]
        estimated = await count(messages)
      }
    }
    // 仍超硬上限：从最旧的轮次开始丢弃（只在用户消息边界切分），至少保留最后一轮
    while (estimated > limit) {
      const starts = userTurnStarts(messages)
      const next = starts[0] !== undefined && starts[0] > 0 ? starts[0] : starts[1]
      if (next === undefined) break
      messages = messages.slice(next)
      estimated = await count(messages)
    }
    if (estimated > limit) {
      throw new LeoError('context_overflow', `Context (${estimated} tokens) exceeds model limit (${limit}) even after compaction`)
    }

    const fingerprint = createHash('sha256')
      .update(system)
      .update(JSON.stringify(input.tools))
      .update(messages.map((m) => m.id).join(','))
      .digest('hex')
      .slice(0, 32)

    const built: BuiltContext = { system, messages, tools: input.tools, estimatedTokens: estimated, limitTokens: limit, fingerprint }
    if (resolved.info) built.modelInfo = resolved.info
    if (compaction) built.compaction = compaction
    return built
  }

  /** 找到压缩切分点：保留最近 keepRecentTurns 个“用户轮”，返回切分下标（0 表示无可压缩内容） */
  private findCut(messages: AgentMessage[]): number {
    const starts = userTurnStarts(messages)
    const keep = this.budget.keepRecentTurns
    if (starts.length <= keep) return 0
    return starts[starts.length - keep]!
  }
}

/** 真实用户输入（非工具结果、非压缩摘要）开始的位置 */
function userTurnStarts(messages: AgentMessage[]): number[] {
  const out: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.meta?.compaction !== true) out.push(i)
  })
  return out
}

/** 核心插件：提供 `context` 服务（依赖 llm 做 token 估算与模型信息） */
export const contextPlugin = definePlugin<TokenBudgetOptions | undefined>({
  name: 'leo:context',
  inject: ['llm'],
  apply(ctx, config) {
    ctx.provide('context', new DefaultContextService(ctx, config ?? {}))
  },
})
