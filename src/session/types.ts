import type { LeoErrorCode } from '../errors.js'
import type { ContextBreakdown } from '../context/types.js'
import type { AgentMessage, Usage } from '../protocol/messages.js'

/**
 * 会话事件：只追加（append-only）。
 * 原则（借鉴 DeepSeek Harness）：**模型可见即已记录**——任何一次模型请求都能从日志重建：
 * `llm/request` 记录了 system 文本、按顺序参与请求的 message id、工具名与参数，
 * message 本体由 `message` 事件保存，压缩摘要由 `compaction` 事件保存。
 * 日志同时是审计、计费、回放与评测的数据源。
 *
 * 轨迹观测（0.2.2 起，只新增、全部可选）：
 * - `session/meta`：会话元信息（父会话、来源、名字），新会话第一次 turn 前写入（仅当 `AgentOptions.sessionMeta` 提供时）
 * - `tool/start` / `tool/end`：每次**真正执行**的工具调用的开始与结束（预检被拒、找不到工具等未执行的调用没有这两条，
 *   只有 `isError` 的工具结果消息，`meta.errorCode` 说明原因）
 * - `llm/response.startedAt` / `firstTokenAt`：成功那次尝试的开始时间与首个增量到达时间（TTFT = firstTokenAt - startedAt）。
 *   step 的起点就是 `llm/request` 的 `at`，因此不再单独写 `step/start`
 * 读取方应忽略不认识的事件类型与字段：旧日志（0.2.1 及更早）没有这些数据。
 */
export interface SessionEventMap {
  message: { message: AgentMessage }
  'turn/start': { turnId: string }
  'turn/end': {
    turnId: string
    reason: string
    usage: Usage
    steps: number
    error?: { code: LeoErrorCode; message: string }
  }
  'llm/request': {
    turnId: string
    stepId: string
    model: string
    system: string
    messageIds: string[]
    tools: string[]
    params: Record<string, unknown>
    fingerprint: string
    estimatedTokens: number
    /** 0.2.3：上下文组成（system 片段、工具定义、消息、窗口与预留），旧日志没有 */
    breakdown?: ContextBreakdown
  }
  'llm/response': {
    turnId: string
    stepId: string
    messageId: string
    finishReason: string
    usage: Usage
    attempts: number
    /** 0.2.2：成功那次尝试发出请求的时间（毫秒时间戳）。失败尝试与退避等待在 llm/request.at 与它之间 */
    startedAt?: number
    /** 0.2.2：本次尝试收到第一个增量（文本 / 思考 / 工具调用）的时间；没有增量时缺省。TTFT = firstTokenAt - startedAt */
    firstTokenAt?: number
  }
  'llm/attempt-failed': {
    turnId: string
    stepId: string
    attempt: number
    code: LeoErrorCode
    message: string
    /** 0.2.2：这次失败尝试的开始时间 */
    startedAt?: number
  }
  /**
   * 0.2.2：工具开始执行（预检、审批、守卫都已通过）。参数不重复存储：
   * 它在 `messageId` 指向的 assistant 消息的 tool_call 块里（中间件改写过的参数不在此列）。
   */
  'tool/start': { turnId: string; stepId: string; callId: string; name: string; messageId: string; at: number }
  /** 0.2.2：工具执行结束（含 tools/post-execute 之后），结果本体仍是随后的 `message`（role: 'tool'） */
  'tool/end': {
    turnId: string
    stepId: string
    callId: string
    name: string
    isError: boolean
    errorCode?: string
    terminate?: boolean
    /** 工具自身报告的耗时（ToolResult.durationMs） */
    durationMs: number
    startedAt: number
    endedAt: number
  }
  /** 0.2.2：会话元信息，见 {@link SessionMeta} */
  'session/meta': SessionMeta
  /** 压缩：replacesUpTo（含）之前的消息在投影中被 summary 取代；原始事件保留用于审计 */
  compaction: { summary: AgentMessage; replacesUpTo: string; strategy: string }
  /** 插件自定义持久化数据 */
  custom: { kind: string; data: unknown }
}

export type SessionEventType = keyof SessionEventMap

/**
 * 会话元信息（0.2.2）。全部可选；子 Agent、团队成员等插件经 `AgentOptions.sessionMeta` 传入，
 * 轨迹观测据此把子会话挂到父会话的工具调用下。
 */
export interface SessionMeta {
  /** 'main' | 'sub-agent' | 'team-member' | 插件自定的字符串 */
  origin?: string
  /** 给人看的名字 */
  label?: string
  /** 父会话（发起它的会话） */
  parentSessionId?: string
  parentAgentId?: string
  parentTurnId?: string
  /** 发起它的那次工具调用 */
  parentToolCallId?: string
  /** 写入时由 loop 补上 */
  agentId?: string
  model?: string
  /** 插件自定义的附加信息（需可 JSON 序列化） */
  extra?: Record<string, unknown>
}

/** `SessionStore.list()` 的一项 */
export interface SessionInfo {
  sessionId: string
  /** 第一条事件的时间 */
  createdAt: number
  /** 最后一条事件的时间 */
  updatedAt: number
  /** 事件条数 */
  events: number
  /** 第一条 `session/meta`（若有） */
  meta?: SessionMeta
}

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in T]: {
    id: string
    sessionId: string
    /** 会话内单调递增序号，从 1 开始 */
    seq: number
    type: K
    at: number
    data: SessionEventMap[K]
  }
}[T]

/**
 * `ctx.get('sessions')`：会话存储。默认内存实现；生产环境可替换为
 * 文件（FileSessionStore）、Postgres、S3 等实现，只需满足此接口。
 * 实现必须保证同一 session 内 seq 单调递增、append 原子。
 */
export interface SessionStore {
  append<T extends SessionEventType>(sessionId: string, type: T, data: SessionEventMap[T]): Promise<SessionEvent<T>>
  events(sessionId: string): Promise<SessionEvent[]>
  /** 当前可见消息（已应用压缩） */
  messages(sessionId: string): Promise<AgentMessage[]>
  delete(sessionId: string): Promise<void>
  /**
   * 0.2.2，可选：列出已有会话（按 updatedAt 倒序）。第三方存储可以不实现，调用方需判断
   * `typeof store.list === 'function'`
   */
  list?(): Promise<SessionInfo[]>
}
