import { LeoError } from '../../errors.js'
import type { Usage } from '../../protocol/messages.js'
import type { FinishReason, LlmProvider, LlmRequest, LlmStreamEvent, ModelInfo, StreamOptions } from '../types.js'

/** 脚本化的一次模型响应 */
export interface MockResponse {
  text?: string
  reasoning?: string
  toolCalls?: { id?: string; name: string; arguments: unknown }[]
  usage?: Partial<Usage>
  finishReason?: FinishReason
  /** 抛出该错误（可在输出部分内容后抛出，见 errorAfterText） */
  error?: LeoError
  /** 为 true 时先输出 text 再抛 error，模拟流中断 */
  errorAfterText?: boolean
  /** 每个分片之间的延迟（毫秒），用于测试取消 */
  delayMs?: number
}

export type MockStep = MockResponse | LlmStreamEvent[] | ((req: LlmRequest, callIndex: number) => MockResponse | LlmStreamEvent[])

/**
 * 确定性的 Mock Provider：按脚本依次返回响应，记录每次收到的请求。
 * 用于插件单测、Agent Loop 回归测试、离线开发。
 */
export class MockProvider implements LlmProvider {
  readonly id: string
  readonly requests: LlmRequest[] = []
  private readonly script: MockStep[]
  private readonly models: ModelInfo[]

  constructor(opts: { id?: string; script?: MockStep[]; models?: ModelInfo[] } = {}) {
    this.id = opts.id ?? 'mock'
    this.script = [...(opts.script ?? [])]
    this.models = opts.models ?? []
  }

  /** 追加脚本步骤 */
  push(...steps: MockStep[]) {
    this.script.push(...steps)
  }

  getModelInfo(model: string) {
    return this.models.find((m) => m.id === model)
  }

  async *stream(request: LlmRequest, opts: StreamOptions): AsyncGenerator<LlmStreamEvent> {
    const index = this.requests.length
    this.requests.push(structuredClone(request))
    const step = this.script.shift()
    if (!step) throw new LeoError('invalid_request', `MockProvider script exhausted at call #${index}`)
    const resolved = typeof step === 'function' ? step(request, index) : step
    const delay = !Array.isArray(resolved) ? (resolved.delayMs ?? 0) : 0
    const events = Array.isArray(resolved) ? resolved : toEvents(resolved)
    if (!Array.isArray(resolved) && resolved.error && !resolved.errorAfterText) throw resolved.error
    for (const ev of events) {
      if (opts.signal.aborted) throw new LeoError('cancelled', 'Mock stream cancelled')
      if (delay) await sleep(delay, opts.signal)
      yield ev
    }
    if (!Array.isArray(resolved) && resolved.error && resolved.errorAfterText) throw resolved.error
  }
}

function toEvents(r: MockResponse): LlmStreamEvent[] {
  const out: LlmStreamEvent[] = []
  if (r.reasoning) out.push({ type: 'reasoning_delta', text: r.reasoning })
  if (r.text) {
    // 拆成若干分片，模拟真实流式
    for (const piece of r.text.match(/.{1,8}/gsu) ?? []) out.push({ type: 'text_delta', text: piece })
  }
  if (r.error && r.errorAfterText) return out
  r.toolCalls?.forEach((c, index) => {
    const raw = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments)
    const half = Math.ceil(raw.length / 2)
    out.push({ type: 'tool_call_delta', index, id: c.id ?? `call_${index}`, name: c.name, argumentsDelta: raw.slice(0, half) })
    out.push({ type: 'tool_call_delta', index, argumentsDelta: raw.slice(half) })
  })
  out.push({ type: 'usage', usage: r.usage ?? { inputTokens: 10, outputTokens: 5 } })
  out.push({ type: 'done', finishReason: r.finishReason ?? (r.toolCalls?.length ? 'tool_calls' : 'stop') })
  return out
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new LeoError('cancelled', 'Mock stream cancelled'))
      },
      { once: true },
    )
  })
}
