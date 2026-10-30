/**
 * leo-agents 统一错误类型。
 *
 * 所有内核与核心模块抛出的错误都是 {@link LeoError}，带一个稳定的 `code`，
 * Agent Loop 依据 code 判断是否可重试、是否需要压缩上下文等。
 * 插件也应抛出 LeoError（或让宿主包装），以便上层统一处理和计量。
 */
export type LeoErrorCode =
  // —— LLM 调用 ——
  | 'rate_limit' // 429，可重试（会尊重 retryAfterMs）
  | 'overloaded' // 5xx / 529，可重试
  | 'timeout' // 请求超时，可重试
  | 'network' // 连接失败等网络错误，可重试
  | 'context_overflow' // 上下文超出模型窗口，触发强制压缩后重试一次
  | 'auth' // 401/403，不可重试
  | 'invalid_request' // 400 等，不可重试
  // —— 工具 ——
  | 'tool_not_found'
  | 'tool_invalid_args'
  | 'tool_denied'
  | 'tool_timeout'
  | 'tool_error'
  // —— 内核 / 运行时 ——
  | 'service_missing'
  | 'plugin_unresolved'
  | 'plugin_config_invalid'
  | 'session_busy'
  | 'cancelled'
  | 'budget_exceeded'
  | 'internal'

const RETRYABLE: ReadonlySet<LeoErrorCode> = new Set(['rate_limit', 'overloaded', 'timeout', 'network'])

export interface LeoErrorOptions {
  cause?: unknown
  /** 服务端建议的重试等待时间（毫秒），例如来自 Retry-After 头 */
  retryAfterMs?: number
  /** HTTP 状态码等附加信息 */
  status?: number
  details?: Record<string, unknown>
}

export class LeoError extends Error {
  readonly code: LeoErrorCode
  readonly retryAfterMs?: number
  readonly status?: number
  readonly details?: Record<string, unknown>

  constructor(code: LeoErrorCode, message: string, opts: LeoErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'LeoError'
    this.code = code
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
    if (opts.status !== undefined) this.status = opts.status
    if (opts.details !== undefined) this.details = opts.details
  }

  /** 是否属于可自动重试的错误 */
  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, status: this.status, details: this.details }
  }
}

/** 把任意异常规范化为 LeoError（AbortError → cancelled，其余 → fallback code） */
export function toLeoError(err: unknown, fallback: LeoErrorCode = 'internal'): LeoError {
  if (err instanceof LeoError) return err
  if (isAbortError(err)) return new LeoError('cancelled', 'Operation was cancelled', { cause: err })
  const message = err instanceof Error ? err.message : String(err)
  return new LeoError(fallback, message, { cause: err })
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
  ) || (err instanceof LeoError && err.code === 'cancelled')
}
