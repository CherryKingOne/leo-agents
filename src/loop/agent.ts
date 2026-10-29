import { LeoError, toLeoError } from '../errors.js'
import type { Context } from '../kernel/context.js'
import type { EventDef } from '../kernel/types.js'
import type { ModelInfo } from '../llm/types.js'
import {
  type AgentMessage,
  addUsage,
  emptyUsage,
  newId,
  normalizeInput,
  textOf,
  toolCallsOf,
  type Usage,
  type UserInput,
} from '../protocol/messages.js'
import type { ToolResult } from '../tools/types.js'
import { StreamAccumulator } from './accumulator.js'
import { Channel } from './channel.js'
import type {
  Agent,
  AgentEvent,
  AgentLoopService,
  AgentOptions,
  AgentStatus,
  RetryPolicy,
  RunLimits,
  RunOptions,
  StopReason,
  TurnResult,
} from './types.js'

declare module '../kernel/types.js' {
  interface Services {
    agentLoop: AgentLoopService
  }
  interface Events {
    /** 每个 step 开始前：可拒绝（stop）——用于配额检查、限流、人工暂停 */
    'agent/pre-step': EventDef<
      'waterfall',
      { agent: Agent; turnId: string; step: number; usage: Usage },
      { action: 'continue' } | { action: 'stop'; reason?: StopReason }
    >
    /** turn 本应结束时：任一监听器返回 { continue: true } 即继续（可附带一条新的用户消息） */
    'agent/turn-stopping': EventDef<
      'serial',
      { agent: Agent; turnId: string; message: AgentMessage; usage: Usage; steps: number },
      { continue: true; message?: UserInput }
    >
    /** 所有 AgentEvent 的旁路广播（日志、可观测性、实时推送） */
    'agent/event': EventDef<'emit', { agent: Agent; event: AgentEvent }>
    /** 每次模型调用的用量（计费、配额） */
    'usage/recorded': EventDef<
      'emit',
      { agentId: string; sessionId: string; turnId: string; stepId: string; model: string; usage: Usage; tenant?: import('../kernel/types.js').TenantContext }
    >
  }
}

const DEFAULT_LIMITS: RunLimits = { maxSteps: 50 }
const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 30_000 }

/**
 * 默认 Agent 实现：一个可直接用于生产的通用 ReAct 式循环。
 *
 * 一个 turn = 用户输入 → [构建上下文 → 调用模型(流式, 带重试) → 执行工具]* → 结束。
 * 特性：流式事件、并发工具执行、指数退避重试、上下文溢出自动压缩、
 * steer / followUp 队列、取消与超时、步数/token/成本预算、会话锁、
 * 只追加日志（任何一次模型请求都可回放）。
 */
export class DefaultAgent implements Agent {
  readonly id: string
  readonly sessionId: string
  readonly options: Readonly<AgentOptions>
  readonly ctx: Context<any>
  private _status: AgentStatus = 'idle'
  private controller: AbortController | undefined
  private readonly steerQueue: AgentMessage[] = []
  private readonly followUpQueue: AgentMessage[] = []

  constructor(
    loopCtx: Context<any>,
    options: AgentOptions,
    private readonly locks: Set<string>,
    private readonly onDispose: (a: DefaultAgent) => void,
  ) {
    this.id = options.id ?? newId('agent')
    this.sessionId = options.sessionId ?? newId('ses')
    this.options = Object.freeze({ ...options })
    this.ctx = loopCtx.fork({
      agentId: this.id,
      sessionId: this.sessionId,
      ...(options.tenant ? { tenant: options.tenant } : {}),
    })
  }

  get status(): AgentStatus {
    return this._status
  }

  async messages() {
    return this.ctx.get('sessions').messages(this.sessionId)
  }

  steer(input: UserInput) {
    this.steerQueue.push(userMessage(input))
  }

  followUp(input: UserInput) {
    this.followUpQueue.push(userMessage(input))
  }

  abort(reason = 'aborted by caller') {
    this.controller?.abort(new LeoError('cancelled', reason))
  }

  async dispose() {
    this.abort('agent disposed')
    this._status = 'disposed'
    this.onDispose(this)
    await this.ctx.dispose()
  }

  async run(input: UserInput, opts?: RunOptions): Promise<TurnResult> {
    let result: TurnResult | undefined
    for await (const _ of this.stream(input, opts, (r) => (result = r))) {
      // 消费事件直到 turn 结束
    }
    if (!result) throw new LeoError('internal', 'Turn ended without a result')
    return result
  }

  prompt(input: UserInput, opts?: RunOptions): AsyncIterable<AgentEvent> {
    return this.stream(input, opts)
  }

  private stream(input: UserInput, opts: RunOptions = {}, onResult?: (r: TurnResult) => void): AsyncIterable<AgentEvent> {
    if (this._status === 'disposed') throw new LeoError('internal', `Agent ${this.id} is disposed`)
    if (this._status === 'running' || this.locks.has(this.sessionId)) {
      throw new LeoError('session_busy', `Session ${this.sessionId} already has an active turn; use steer() or followUp()`)
    }
    // 同步加锁，保证并发调用 prompt() 时只有一个成功
    this.locks.add(this.sessionId)
    this._status = 'running'
    const controller = new AbortController()
    this.controller = controller
    const channel = new Channel<AgentEvent>(() => controller.abort(new LeoError('cancelled', 'Consumer stopped iterating')))
    const emit = (event: AgentEvent) => {
      channel.push(event)
      this.ctx.emit('agent/event', { agent: this, event })
    }
    void this.runTurn(input, opts, controller, emit)
      .then((r) => onResult?.(r))
      .catch((err) => this.ctx.logger.error({ err }, 'agent turn crashed'))
      .finally(() => {
        this.locks.delete(this.sessionId)
        if (this._status === 'running') this._status = 'idle'
        if (this.controller === controller) this.controller = undefined
        channel.close()
      })
    return channel
  }

  private async runTurn(
    input: UserInput,
    opts: RunOptions,
    controller: AbortController,
    emit: (e: AgentEvent) => void,
  ): Promise<TurnResult> {
    const sessions = this.ctx.get('sessions')
    const limits: RunLimits = { ...DEFAULT_LIMITS, ...stripUndefined(this.options.limits), ...stripUndefined(pickLimits(opts)) }
    const signals = [controller.signal]
    if (opts.signal) signals.push(opts.signal)
    const timeoutSignal = limits.turnTimeoutMs ? AbortSignal.timeout(limits.turnTimeoutMs) : undefined
    if (timeoutSignal) signals.push(timeoutSignal)
    const signal = AbortSignal.any(signals)

    const turnId = newId('turn')
    const added: AgentMessage[] = []
    let usage = emptyUsage()
    let steps = 0
    let reason: StopReason = 'completed'
    let error: LeoError | undefined

    const record = async (m: AgentMessage) => {
      await sessions.append(this.sessionId, 'message', { message: m })
      added.push(m)
    }

    emit({ type: 'turn_start', turnId, sessionId: this.sessionId })
    try {
      await sessions.append(this.sessionId, 'turn/start', { turnId })
      // 空闲时 steer 的消息排在本次输入之前
      for (const m of this.steerQueue.splice(0)) await record(m)
      await record(userMessage(input))

      let forceCompact = false
      while (true) {
        throwIfAborted(signal)
        if (steps >= limits.maxSteps) {
          reason = 'max_steps'
          break
        }
        if (overBudget(usage, limits)) {
          reason = 'budget_exceeded'
          break
        }
        for (const m of this.steerQueue.splice(0)) await record(m)

        const pre = await this.ctx.waterfall('agent/pre-step', { agent: this, turnId, step: steps, usage }, () => ({ action: 'continue' as const }))
        if (pre.action === 'stop') {
          reason = pre.reason ?? 'rejected'
          break
        }

        steps++
        const stepId = newId('step')
        emit({ type: 'step_start', turnId, stepId, step: steps })

        let step: StepOutcome
        try {
          step = await this.step(turnId, stepId, forceCompact, signal, emit)
          forceCompact = false
        } catch (err) {
          const e = toLeoError(err)
          // 上下文溢出：强制压缩后重试本 step 一次
          if (e.code === 'context_overflow' && !forceCompact) {
            forceCompact = true
            steps--
            continue
          }
          throw err
        }

        usage = addUsage(usage, step.usage)
        await record(step.message)
        emit({ type: 'message', message: step.message })
        emit({ type: 'step_end', stepId, finishReason: step.finishReason, usage: step.usage })

        const calls = toolCallsOf(step.message)
        if (calls.length) {
          const results = await this.ctx.get('tools').executeBatch(calls, {
            agentId: this.id,
            sessionId: this.sessionId,
            turnId,
            ...(this.options.tenant ? { tenant: this.options.tenant } : {}),
            signal,
            ctx: this.ctx,
            ...(this.options.sequentialTools ? { sequential: true } : {}),
            onStart: (call) => emit({ type: 'tool_start', call }),
            onUpdate: (callId, partial) => emit({ type: 'tool_update', callId, partial }),
          })
          for (const r of results) {
            const m = toolMessage(r)
            await record(m)
            emit({ type: 'tool_result', result: r, message: m })
          }
          throwIfAborted(signal)
          if (results.every((r) => r.terminate)) {
            reason = 'terminated_by_tool'
            break
          }
          continue
        }

        if (step.finishReason === 'length') {
          reason = 'length'
          break
        }

        // 无工具调用：turn 准备结束，询问监听器与 followUp 队列
        const decisions = await this.ctx.serial('agent/turn-stopping', { agent: this, turnId, message: step.message, usage, steps })
        const cont = decisions.find((d) => d?.continue)
        if (cont) {
          if (cont.message !== undefined) await record(userMessage(cont.message))
          continue
        }
        const next = this.followUpQueue.shift()
        if (next) {
          await record(next)
          continue
        }
        reason = 'completed'
        break
      }
    } catch (err) {
      const e = toLeoError(err)
      if (timeoutSignal?.aborted) {
        reason = 'timeout'
        error = new LeoError('timeout', `Turn exceeded ${limits.turnTimeoutMs}ms`, { cause: err })
      } else if (signal.aborted || e.code === 'cancelled') {
        reason = 'cancelled'
      } else {
        reason = 'error'
        error = e
        this.ctx.logger.error({ err: e, turnId }, 'turn failed')
      }
    }

    const errInfo = error ? { code: error.code, message: error.message } : undefined
    try {
      await sessions.append(this.sessionId, 'turn/end', { turnId, reason, usage, steps, ...(errInfo ? { error: errInfo } : {}) })
    } catch (err) {
      this.ctx.logger.error({ err, turnId }, 'failed to record turn end')
    }
    emit({ type: 'turn_end', turnId, reason, usage, steps, ...(errInfo ? { error: errInfo } : {}) })
    const last = [...added].reverse().find((m) => m.role === 'assistant')
    return { turnId, reason, text: last ? textOf(last.content) : '', usage, steps, messages: added, ...(error ? { error } : {}) }
  }

  /** 一个 step：构建上下文 → 记录请求 → 调用模型（带重试） */
  private async step(
    turnId: string,
    stepId: string,
    forceCompact: boolean,
    signal: AbortSignal,
    emit: (e: AgentEvent) => void,
  ): Promise<StepOutcome> {
    const sessions = this.ctx.get('sessions')
    const o = this.options
    const tools = o.tools === false ? [] : this.ctx.get('tools').schemas(o.tools)
    const built = await this.ctx.get('context').build({
      agentId: this.id,
      sessionId: this.sessionId,
      turnId,
      model: o.model,
      ...(o.tenant ? { tenant: o.tenant } : {}),
      ...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
      state: o.state ?? {},
      messages: await sessions.messages(this.sessionId),
      tools,
      ...(o.maxOutputTokens !== undefined ? { maxOutputTokens: o.maxOutputTokens } : {}),
      forceCompact,
      signal,
    })
    if (built.compaction) {
      await sessions.append(this.sessionId, 'compaction', built.compaction)
      emit({ type: 'compaction', strategy: built.compaction.strategy, replacesUpTo: built.compaction.replacesUpTo })
    }

    const params: Record<string, unknown> = stripUndefined({
      toolChoice: tools.length ? o.toolChoice : undefined,
      maxOutputTokens: o.maxOutputTokens,
      temperature: o.temperature,
      topP: o.topP,
      stop: o.stop,
      providerOptions: o.providerOptions,
    })
    // 模型可见即已记录：先写日志再发请求
    await sessions.append(this.sessionId, 'llm/request', {
      turnId,
      stepId,
      model: o.model,
      system: built.system,
      messageIds: built.messages.map((m) => m.id),
      tools: built.tools.map((t) => t.name),
      params,
      fingerprint: built.fingerprint,
      estimatedTokens: built.estimatedTokens,
    })

    const request = {
      ...(built.system ? { system: built.system } : {}),
      messages: built.messages,
      ...(built.tools.length ? { tools: built.tools } : {}),
      ...(params as object),
    }
    const retry: RetryPolicy = { ...DEFAULT_RETRY, ...stripUndefined(o.retry) }
    const llm = this.ctx.get('llm')

    for (let attempt = 1; ; attempt++) {
      const acc = new StreamAccumulator()
      try {
        for await (const ev of llm.stream(o.model, request, { signal, ...(o.tenant ? { tenant: o.tenant } : {}) })) {
          acc.push(ev)
          if (ev.type === 'text_delta') emit({ type: 'text_delta', stepId, text: ev.text })
          else if (ev.type === 'reasoning_delta') emit({ type: 'reasoning_delta', stepId, text: ev.text })
          else if (ev.type === 'tool_call_delta') {
            const e: AgentEvent = { type: 'tool_call_delta', stepId, index: ev.index }
            if (ev.name) e.name = ev.name
            if (ev.argumentsDelta) e.argumentsDelta = ev.argumentsDelta
            emit(e)
          }
        }
        throwIfAborted(signal)
        const message = acc.toMessage()
        const stepUsage = withCost({ ...emptyUsage(), ...acc.usage }, built.modelInfo)
        const finishReason = acc.finishReason ?? (toolCallsOf(message).length ? 'tool_calls' : 'stop')
        await sessions.append(this.sessionId, 'llm/response', { turnId, stepId, messageId: message.id, finishReason, usage: stepUsage, attempts: attempt })
        this.ctx.emit('usage/recorded', {
          agentId: this.id,
          sessionId: this.sessionId,
          turnId,
          stepId,
          model: o.model,
          usage: stepUsage,
          ...(o.tenant ? { tenant: o.tenant } : {}),
        })
        return { message, usage: stepUsage, finishReason }
      } catch (err) {
        const e = toLeoError(err, 'network')
        if (signal.aborted || e.code === 'cancelled') {
          // 保存已生成的部分文本，保证用户看到的内容在日志里也有
          if (acc.text || acc.reasoning) {
            const partial = acc.toMessage(true)
            await sessions.append(this.sessionId, 'message', { message: partial })
            emit({ type: 'message', message: partial })
          }
          throw new LeoError('cancelled', 'Turn cancelled', { cause: err })
        }
        await sessions.append(this.sessionId, 'llm/attempt-failed', { turnId, stepId, attempt, code: e.code, message: e.message })
        if (e.code === 'context_overflow' || !e.retryable || attempt >= retry.maxAttempts) throw e
        const delayMs = backoff(attempt, retry, e.retryAfterMs)
        this.ctx.logger.warn({ code: e.code, attempt, delayMs }, 'LLM request failed, retrying')
        emit({ type: 'retry', stepId, attempt, delayMs, error: { code: e.code, message: e.message } })
        await sleep(delayMs, signal)
      }
    }
  }
}

interface StepOutcome {
  message: AgentMessage
  usage: Usage
  finishReason: import('../llm/types.js').FinishReason
}

function userMessage(input: UserInput): AgentMessage {
  const { content, meta } = normalizeInput(input)
  const m: AgentMessage = { id: newId('msg'), role: 'user', content, createdAt: Date.now() }
  if (meta) m.meta = meta
  return m
}

function toolMessage(r: ToolResult): AgentMessage {
  const m: AgentMessage = {
    id: newId('msg'),
    role: 'tool',
    toolCallId: r.callId,
    toolName: r.name,
    isError: r.isError,
    content: r.content,
    createdAt: Date.now(),
    meta: { durationMs: r.durationMs, ...(r.errorCode ? { errorCode: r.errorCode } : {}) },
  }
  if (r.details !== undefined) m.meta!.details = r.details
  return m
}

function overBudget(u: Usage, l: RunLimits): boolean {
  if (l.maxTurnTokens !== undefined && u.inputTokens + u.outputTokens >= l.maxTurnTokens) return true
  if (l.maxTurnCostUsd !== undefined && (u.costUsd ?? 0) >= l.maxTurnCostUsd) return true
  return false
}

function withCost(u: Usage, info: ModelInfo | undefined): Usage {
  if (u.costUsd || !info?.pricing) return u
  const p = info.pricing
  const cached = u.cachedInputTokens ?? 0
  const cost =
    ((u.inputTokens - cached) * p.inputPerMTok + cached * (p.cachedInputPerMTok ?? p.inputPerMTok) + u.outputTokens * p.outputPerMTok) / 1_000_000
  return { ...u, costUsd: cost }
}

/** 指数退避 + 抖动；服务端给出 Retry-After 时优先使用（不超过上限的 2 倍） */
export function backoff(attempt: number, p: RetryPolicy, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, p.maxDelayMs * 2)
  const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1))
  return Math.round(exp * (0.5 + Math.random() * 0.5))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new LeoError('cancelled', 'Turn cancelled', { cause: signal.reason })
}

function pickLimits(o: RunOptions): Partial<RunLimits> {
  return { maxSteps: o.maxSteps, maxTurnTokens: o.maxTurnTokens, maxTurnCostUsd: o.maxTurnCostUsd, turnTimeoutMs: o.turnTimeoutMs } as Partial<RunLimits>
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {}
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
