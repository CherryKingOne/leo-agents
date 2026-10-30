import { z } from 'zod'
import { LeoError, toLeoError } from '../errors.js'
import type { Context } from '../kernel/context.js'
import { definePlugin } from '../kernel/plugin.js'
import type { Disposer, EventDef } from '../kernel/types.js'
import type { ToolSchema } from '../llm/types.js'
import type { ContentBlock, ToolCallBlock } from '../protocol/messages.js'
import type {
  ApprovalService,
  BatchContext,
  JsonSchemaObject,
  PreExecutePayload,
  ToolDecision,
  ToolDefinition,
  ToolExecContext,
  ToolFilter,
  ToolOutput,
  ToolRegistry,
  ToolResult,
} from './types.js'

declare module '../kernel/types.js' {
  interface Services {
    tools: ToolRegistry
    /** 可选：审批服务 */
    approval: ApprovalService
  }
  interface Events {
    /** 预检策略：返回 allow（可改写 args）/ deny / ask。权限、沙箱策略、hook 挂在这里 */
    'tools/pre-execute': EventDef<'waterfall', PreExecutePayload, ToolDecision>
    /** 单调守卫：任一监听器返回 { deny } 即拒绝，后续无法撤销（用于不可绕过的安全底线） */
    'tools/guard': EventDef<'bail', PreExecutePayload & { args: unknown }, { deny: string }>
    /** 包裹实际执行：超时、重试、限流、指标、沙箱代理等 */
    'tools/execute': EventDef<'waterfall', { tool: ToolDefinition; args: unknown; exec: ToolExecContext }, unknown>
    /** 结果后处理：脱敏、截断、替换、追加上下文 */
    'tools/post-execute': EventDef<'waterfall', { tool: ToolDefinition; args: unknown; call: ToolCallBlock; result: ToolResult }, ToolResult>
  }
}

/** 工具是否落在筛选范围内（names 与 tags 同时给出时需同时满足） */
export function matchesFilter(tool: ToolDefinition, filter: ToolFilter | false): boolean {
  if (filter === false) return false
  if (filter.names && !filter.names.includes(tool.name)) return false
  if (filter.tags?.length && !tool.tags?.some((tag) => filter.tags!.includes(tag))) return false
  return true
}

const OUTPUT_BRAND = Symbol.for('leo.toolOutput')

/** 构造结构化工具返回（可设置 isError / terminate / details） */
export function toolOutput(out: ToolOutput): ToolOutput {
  return Object.assign(out, { [OUTPUT_BRAND]: true })
}

function isToolOutput(v: unknown): v is ToolOutput {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[OUTPUT_BRAND] === true
}

/** 类型辅助：定义工具，参数类型从 zod schema 推导 */
export function defineTool<S extends z.ZodType, R = unknown>(
  def: Omit<ToolDefinition<z.infer<S>, R>, 'parameters'> & { parameters: S },
): ToolDefinition<z.infer<S>, R>
export function defineTool<A = any, R = unknown>(def: ToolDefinition<A, R>): ToolDefinition<A, R>
export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}

function isZod(p: unknown): p is z.ZodType {
  return typeof p === 'object' && p !== null && typeof (p as z.ZodType).safeParse === 'function'
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

export interface ToolRegistryOptions {
  /** 默认超时，120s */
  defaultTimeoutMs?: number
  /** 并发上限，默认 8 */
  concurrency?: number
  /** 单个工具结果的最大字符数，超出截断，默认 50k */
  maxOutputChars?: number
}

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly schemaCache = new WeakMap<ToolDefinition, ToolSchema>()
  private readonly opts: Required<ToolRegistryOptions>

  constructor(
    private readonly ctx: Context<any>,
    opts: ToolRegistryOptions = {},
  ) {
    this.opts = {
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 120_000,
      concurrency: opts.concurrency ?? 8,
      maxOutputChars: opts.maxOutputChars ?? 50_000,
    }
  }

  register(def: ToolDefinition): Disposer {
    if (!NAME_RE.test(def.name)) throw new LeoError('internal', `Invalid tool name "${def.name}"`)
    if (this.tools.has(def.name)) throw new LeoError('internal', `Tool "${def.name}" is already registered`)
    this.tools.set(def.name, def)
    return () => {
      if (this.tools.get(def.name) === def) this.tools.delete(def.name)
    }
  }

  get(name: string) {
    return this.tools.get(name)
  }

  list(filter?: ToolFilter): ToolDefinition[] {
    const list = [...this.tools.values()]
    return filter ? list.filter((t) => matchesFilter(t, filter)) : list
  }

  schemas(filter?: ToolFilter): ToolSchema[] {
    return this.list(filter).map((t) => {
      let s = this.schemaCache.get(t)
      if (!s) {
        s = { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) }
        this.schemaCache.set(t, s)
      }
      return s
    })
  }

  async executeBatch(calls: ToolCallBlock[], batch: BatchContext): Promise<ToolResult[]> {
    // —— 阶段一：串行预检（解析、校验、策略、审批、守卫），保证审批顺序可预测 ——
    const prepared: (Prepared | ToolResult)[] = []
    for (const call of calls) {
      if (batch.signal.aborted) {
        prepared.push(errorResult(call, 'cancelled', 'Cancelled before execution', 0))
        continue
      }
      prepared.push(await this.prepare(call, batch))
    }

    // —— 阶段二：执行（默认并发，有 sequential 工具则整批串行） ——
    const runnable = prepared.filter((p): p is Prepared => 'tool' in p)
    const sequential = batch.sequential || runnable.some((p) => p.tool.executionMode === 'sequential')
    const limit = sequential ? 1 : this.opts.concurrency
    const results = new Map<Prepared, ToolResult>()
    let cursor = 0
    const worker = async () => {
      while (cursor < runnable.length) {
        const p = runnable[cursor++]!
        results.set(p, await this.run(p, batch))
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, runnable.length) }, worker))

    // —— 按 assistant 原始顺序返回 ——
    return prepared.map((p) => ('tool' in p ? results.get(p)! : p))
  }

  private async prepare(call: ToolCallBlock, batch: BatchContext): Promise<Prepared | ToolResult> {
    const tool = this.tools.get(call.name)
    if (tool && batch.filter !== undefined && !matchesFilter(tool, batch.filter)) {
      return errorResult(call, 'tool_not_found', `Tool "${call.name}" is not available to this agent`, 0)
    }
    if (!tool) {
      const available = [...this.tools.keys()].join(', ')
      return errorResult(call, 'tool_not_found', `Unknown tool "${call.name}". Available tools: ${available || '(none)'}`, 0)
    }
    // 参数解析与校验：失败时把结构化错误回给模型，让它自我修正
    let args: unknown = call.arguments
    if (args === undefined) {
      if (call.rawArguments.trim() === '') args = {}
      else return errorResult(call, 'tool_invalid_args', `Arguments are not valid JSON: ${call.rawArguments.slice(0, 500)}`, 0)
    }
    if (isZod(tool.parameters)) {
      const r = tool.parameters.safeParse(args)
      if (!r.success) {
        return errorResult(call, 'tool_invalid_args', `Invalid arguments for "${tool.name}":\n${z.prettifyError(r.error)}`, 0)
      }
      args = r.data
    }

    const payload: PreExecutePayload = {
      call,
      tool,
      args,
      agentId: batch.agentId,
      sessionId: batch.sessionId,
      turnId: batch.turnId,
      ...(batch.tenant ? { tenant: batch.tenant } : {}),
    }
    let decision: ToolDecision
    try {
      decision = await this.ctx.waterfall('tools/pre-execute', payload, () => ({ action: 'allow' }) as ToolDecision)
    } catch (err) {
      // 策略插件异常：失败即关闭
      return errorResult(call, 'tool_denied', `Policy check failed: ${toLeoError(err).message}`, 0)
    }
    if (decision.action === 'allow' && decision.args !== undefined) args = decision.args
    if (decision.action === 'deny') return errorResult(call, 'tool_denied', `Tool call denied: ${decision.reason}`, 0)
    if (decision.action === 'ask') {
      const approval = this.ctx.maybe('approval')
      if (!approval) return errorResult(call, 'tool_denied', 'Tool call requires approval but no approval service is configured', 0)
      try {
        const r = await approval.request({ ...payload, args, ...(decision.reason ? { reason: decision.reason } : {}) }, batch.signal)
        if (!r.approved) return errorResult(call, 'tool_denied', `Tool call rejected${r.reason ? `: ${r.reason}` : ''}`, 0)
      } catch (err) {
        const e = toLeoError(err)
        return errorResult(call, e.code === 'cancelled' ? 'cancelled' : 'tool_denied', `Approval failed: ${e.message}`, 0)
      }
    }
    try {
      const guard = await this.ctx.bail('tools/guard', { ...payload, args })
      if (guard) return errorResult(call, 'tool_denied', `Tool call blocked: ${guard.deny}`, 0)
    } catch (err) {
      return errorResult(call, 'tool_denied', `Guard failed: ${toLeoError(err).message}`, 0)
    }
    return { call, tool, args }
  }

  private async run(p: Prepared, batch: BatchContext): Promise<ToolResult> {
    const { call, tool, args } = p
    const started = Date.now()
    if (batch.signal.aborted) return errorResult(call, 'cancelled', 'Cancelled before execution', 0)
    batch.onStart?.(call)
    const attempts = 1 + (tool.idempotent ? (tool.maxRetries ?? 0) : 0)
    let result: ToolResult | undefined
    for (let attempt = 1; attempt <= attempts; attempt++) {
      result = await this.runOnce(p, batch, started)
      if (!result.errorCode || result.errorCode !== 'tool_error' || batch.signal.aborted) break
      if (attempt < attempts) this.ctx.logger.warn({ tool: tool.name, attempt }, 'tool failed, retrying')
    }
    let final = result!
    try {
      final = await this.ctx.waterfall('tools/post-execute', { tool, args, call, result: final }, (x) => x.result)
    } catch (err) {
      final = errorResult(call, 'tool_error', `Post-processing failed: ${toLeoError(err).message}`, Date.now() - started)
    }
    return final
  }

  private async runOnce({ call, tool, args }: Prepared, batch: BatchContext, started: number): Promise<ToolResult> {
    const timeoutMs = tool.timeoutMs ?? this.opts.defaultTimeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([batch.signal, timeout])
    const exec: ToolExecContext = {
      callId: call.id,
      toolName: tool.name,
      agentId: batch.agentId,
      sessionId: batch.sessionId,
      turnId: batch.turnId,
      ...(batch.tenant ? { tenant: batch.tenant } : {}),
      signal,
      onUpdate: (partial) => batch.onUpdate?.(call.id, partial),
      ctx: batch.ctx,
      logger: batch.ctx.logger.child({ tool: tool.name, callId: call.id }),
    }
    try {
      const value = await raceAbort(
        this.ctx.waterfall('tools/execute', { tool, args, exec }, (x) => x.tool.execute(x.args, x.exec)),
        signal,
      )
      return this.normalize(call, tool, args, value, Date.now() - started)
    } catch (err) {
      const ms = Date.now() - started
      if (batch.signal.aborted) return errorResult(call, 'cancelled', 'Tool execution cancelled', ms)
      if (timeout.aborted) return errorResult(call, 'tool_timeout', `Tool "${tool.name}" timed out after ${timeoutMs}ms`, ms)
      const e = toLeoError(err, 'tool_error')
      const code = e.code === 'tool_denied' || e.code === 'tool_invalid_args' ? e.code : 'tool_error'
      return errorResult(call, code, e.message, ms)
    }
  }

  private normalize(call: ToolCallBlock, tool: ToolDefinition, args: unknown, value: unknown, ms: number): ToolResult {
    let out: ToolOutput
    if (tool.render) {
      const r = tool.render(value, args)
      out = typeof r === 'string' || Array.isArray(r) ? { content: r } : r
    } else if (isToolOutput(value)) out = value
    else if (typeof value === 'string') out = { content: value }
    else if (value === undefined || value === null) out = { content: '(no output)' }
    else out = { content: safeJson(value) }
    const content = typeof out.content === 'string' ? [{ type: 'text' as const, text: out.content }] : out.content
    const res: ToolResult = {
      callId: call.id,
      name: call.name,
      content: truncate(content, this.opts.maxOutputChars),
      isError: out.isError ?? false,
      terminate: out.terminate ?? false,
      durationMs: ms,
    }
    if (out.details !== undefined) res.details = out.details
    return res
  }
}

interface Prepared {
  call: ToolCallBlock
  tool: ToolDefinition
  args: unknown
}

function errorResult(call: ToolCallBlock, code: string, message: string, ms: number): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    terminate: false,
    errorCode: code,
    durationMs: ms,
  }
}

/** 即使工具忽略 signal，也保证超时/取消能及时返回 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function truncate(blocks: ContentBlock[], max: number): ContentBlock[] {
  let budget = max
  return blocks.map((b) => {
    if (b.type !== 'text') return b
    if (b.text.length <= budget) {
      budget -= b.text.length
      return b
    }
    const kept = b.text.slice(0, Math.max(0, budget))
    const dropped = b.text.length - kept.length
    budget = 0
    return { type: 'text', text: `${kept}\n…[truncated ${dropped} characters]` }
  })
}

/** zod / JSON Schema → 发给模型的 JSON Schema */
export function toJsonSchema(p: ToolDefinition['parameters']): Record<string, unknown> {
  if (!isZod(p)) return p as JsonSchemaObject
  const s = z.toJSONSchema(p, { unrepresentable: 'any' }) as Record<string, unknown>
  delete s.$schema
  if (s.type !== 'object') return { type: 'object', properties: {}, ...s }
  return s
}

/** 核心插件：提供 `tools` 服务 */
export const toolsPlugin = definePlugin<ToolRegistryOptions | undefined>({
  name: 'leo:tools',
  apply(ctx, config) {
    ctx.provide('tools', new DefaultToolRegistry(ctx, config ?? {}))
  },
})
