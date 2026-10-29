import { LeoError, isAbortError } from '../../errors.js'
import type { AgentMessage, ContentBlock, Usage } from '../../protocol/messages.js'
import type { FinishReason, LlmProvider, LlmRequest, LlmStreamEvent, ModelInfo, StreamOptions } from '../types.js'
import { parseSSE } from './sse.js'

export interface OpenAICompatibleOptions {
  /** Provider id，用作模型前缀：`deepseek/deepseek-chat` */
  id?: string
  /** 例如 https://api.openai.com/v1、https://api.deepseek.com/v1、vLLM / leo-inference 的 /v1 */
  baseURL: string
  /** API Key。也可以用 apiKeyEnv 从环境变量读取（推荐，避免明文） */
  apiKey?: string
  apiKeyEnv?: string
  /** 额外请求头（如 OpenRouter 的 HTTP-Referer） */
  headers?: Record<string, string>
  /** 模型元信息：上下文窗口与价格，用于预算控制和计费 */
  models?: ModelInfo[]
  /** 首字节（响应头）超时，默认 60s */
  connectTimeoutMs?: number
  /** 两个流分片之间的最大间隔，默认 120s（推理模型思考时间较长） */
  idleTimeoutMs?: number
  /** 输出长度参数名：OpenAI 新模型用 max_completion_tokens，大多数兼容端点用 max_tokens */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** 是否把历史中的 reasoning 以 reasoning_content 回传（部分 DeepSeek 思考+工具模式需要） */
  sendReasoning?: boolean
  /** 自定义 fetch（测试或代理用） */
  fetch?: typeof fetch
}

/**
 * OpenAI Chat Completions 兼容 Provider。
 * 适用于 OpenAI、DeepSeek、通义千问、Kimi、智谱、vLLM、SGLang、leo-inference 等兼容端点。
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly id: string
  private readonly opts: OpenAICompatibleOptions

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id ?? 'openai'
    this.opts = opts
  }

  getModelInfo(model: string): ModelInfo | undefined {
    return this.opts.models?.find((m) => m.id === model)
  }

  async *stream(request: LlmRequest, opts: StreamOptions): AsyncGenerator<LlmStreamEvent> {
    const doFetch = this.opts.fetch ?? fetch
    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal.reason)
    if (opts.signal.aborted) throw new LeoError('cancelled', 'Request cancelled before start')
    opts.signal.addEventListener('abort', onAbort, { once: true })

    let timedOut: 'connect' | 'idle' | undefined
    let timer: NodeJS.Timeout | undefined
    const arm = (kind: 'connect' | 'idle', ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = kind
        controller.abort(new LeoError('timeout', `LLM ${kind} timeout after ${ms}ms`))
      }, ms)
    }

    try {
      arm('connect', this.opts.connectTimeoutMs ?? 60_000)
      let res: Response
      try {
        res = await doFetch(`${this.opts.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(this.buildBody(request)),
          signal: controller.signal,
        })
      } catch (err) {
        throw this.mapThrown(err, timedOut, opts.signal)
      }
      if (!res.ok) throw await this.mapHttpError(res)
      if (!res.body) throw new LeoError('network', 'Empty response body')

      const idleMs = this.opts.idleTimeoutMs ?? 120_000
      arm('idle', idleMs)
      let finish: FinishReason | undefined
      try {
        for await (const data of parseSSE(res.body, controller.signal)) {
          arm('idle', idleMs)
          if (data === '[DONE]') break
          let chunk: ChatChunk
          try {
            chunk = JSON.parse(data) as ChatChunk
          } catch {
            continue
          }
          if (chunk.error) throw mapErrorPayload(chunk.error)
          if (chunk.usage) yield { type: 'usage', usage: mapUsage(chunk.usage) }
          for (const choice of chunk.choices ?? []) {
            const d = choice.delta ?? {}
            const reasoning = d.reasoning_content ?? d.reasoning
            if (reasoning) yield { type: 'reasoning_delta', text: reasoning }
            if (d.content) yield { type: 'text_delta', text: d.content }
            for (const tc of d.tool_calls ?? []) {
              const ev: LlmStreamEvent & { type: 'tool_call_delta' } = { type: 'tool_call_delta', index: tc.index ?? 0 }
              if (tc.id) ev.id = tc.id
              if (tc.function?.name) ev.name = tc.function.name
              if (tc.function?.arguments) ev.argumentsDelta = tc.function.arguments
              yield ev
            }
            if (choice.finish_reason) finish = mapFinish(choice.finish_reason)
          }
        }
      } catch (err) {
        throw this.mapThrown(err, timedOut, opts.signal)
      }
      yield { type: 'done', finishReason: finish ?? 'stop' }
    } finally {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
  }

  private headers(): Record<string, string> {
    const key = this.opts.apiKey ?? (this.opts.apiKeyEnv ? process.env[this.opts.apiKeyEnv] : undefined)
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...this.opts.headers,
    }
  }

  /** 构造请求体（公开以便测试与子类覆盖） */
  buildBody(req: LlmRequest): Record<string, unknown> {
    const messages: unknown[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    for (const m of req.messages) messages.push(...this.convertMessage(m))
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
      if (req.toolChoice) {
        body.tool_choice =
          typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } }
      }
    }
    if (req.maxOutputTokens !== undefined) body[this.opts.maxTokensField ?? 'max_tokens'] = req.maxOutputTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.topP !== undefined) body.top_p = req.topP
    if (req.stop?.length) body.stop = req.stop
    return { ...body, ...req.providerOptions }
  }

  private convertMessage(m: AgentMessage): unknown[] {
    switch (m.role) {
      case 'system':
        return [{ role: 'system', content: textContent(m.content) }]
      case 'user':
        return [{ role: 'user', content: userContent(m.content) }]
      case 'assistant': {
        const calls = m.content.filter((b) => b.type === 'tool_call')
        const out: Record<string, unknown> = { role: 'assistant', content: textContent(m.content) || null }
        if (calls.length) {
          out.tool_calls = calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.rawArguments || '{}' },
          }))
        }
        if (this.opts.sendReasoning) {
          const r = m.content.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
          if (r) out.reasoning_content = r
        }
        return [out]
      }
      case 'tool':
        return [{ role: 'tool', tool_call_id: m.toolCallId, content: textContent(m.content) }]
      default:
        return []
    }
  }

  private async mapHttpError(res: Response): Promise<LeoError> {
    const text = await res.text().catch(() => '')
    let message = text.slice(0, 2000) || res.statusText
    let code: string | undefined
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } }
      if (j.error?.message) message = j.error.message
      code = j.error?.code ?? j.error?.type
    } catch {}
    const status = res.status
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    const base = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), details: { body: text.slice(0, 2000) } }
    if (status === 429) {
      // 余额/配额耗尽不是暂时性错误，不应重试
      if (code === 'insufficient_quota') return new LeoError('auth', message, base)
      return new LeoError('rate_limit', message, base)
    }
    if (status === 401 || status === 403 || status === 402) return new LeoError('auth', message, base)
    if (status === 408) return new LeoError('timeout', message, base)
    if (status >= 500) return new LeoError('overloaded', message, base)
    if (isContextOverflow(message, code)) return new LeoError('context_overflow', message, base)
    return new LeoError('invalid_request', message, base)
  }

  private mapThrown(err: unknown, timedOut: 'connect' | 'idle' | undefined, userSignal: AbortSignal): LeoError {
    if (err instanceof LeoError) return err
    if (userSignal.aborted) return new LeoError('cancelled', 'LLM request cancelled', { cause: err })
    if (timedOut) return new LeoError('timeout', `LLM ${timedOut} timeout`, { cause: err })
    if (isAbortError(err)) return new LeoError('cancelled', 'LLM request aborted', { cause: err })
    return new LeoError('network', err instanceof Error ? err.message : String(err), { cause: err })
  }
}

function textContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function userContent(blocks: ContentBlock[]): unknown {
  if (blocks.every((b) => b.type === 'text')) return textContent(blocks)
  return blocks.flatMap((b): Record<string, unknown>[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }]
    if (b.type === 'image') return [{ type: 'image_url', image_url: { url: b.url } }]
    return []
  })
}

function isContextOverflow(message: string, code?: string): boolean {
  return (
    code === 'context_length_exceeded' ||
    /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|reduce the length/i.test(message)
  )
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now())
}

function mapFinish(r: string): FinishReason {
  if (r === 'stop' || r === 'tool_calls' || r === 'length' || r === 'content_filter') return r
  if (r === 'function_call') return 'tool_calls'
  return 'other'
}

function mapErrorPayload(e: { message?: string; code?: string | number; type?: string }): LeoError {
  const msg = e.message ?? 'Upstream stream error'
  if (isContextOverflow(msg, String(e.code ?? ''))) return new LeoError('context_overflow', msg)
  if (e.code === 429 || e.type === 'rate_limit_error') return new LeoError('rate_limit', msg)
  return new LeoError('overloaded', msg)
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: RawUsage
  error?: { message?: string; code?: string | number; type?: string }
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

function mapUsage(u: RawUsage): Partial<Usage> {
  const out: Partial<Usage> = {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  }
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens
  if (cached !== undefined) out.cachedInputTokens = cached
  if (u.completion_tokens_details?.reasoning_tokens !== undefined) out.reasoningTokens = u.completion_tokens_details.reasoning_tokens
  return out
}
