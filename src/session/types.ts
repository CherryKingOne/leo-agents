import type { LeoErrorCode } from '../errors.js'
import type { AgentMessage, Usage } from '../protocol/messages.js'

/**
 * 会话事件：只追加（append-only）。
 * 原则（借鉴 DeepSeek Harness）：**模型可见即已记录**——任何一次模型请求都能从日志重建：
 * `llm/request` 记录了 system 文本、按顺序参与请求的 message id、工具名与参数，
 * message 本体由 `message` 事件保存，压缩摘要由 `compaction` 事件保存。
 * 日志同时是审计、计费、回放与评测的数据源。
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
  }
  'llm/response': { turnId: string; stepId: string; messageId: string; finishReason: string; usage: Usage; attempts: number }
  'llm/attempt-failed': { turnId: string; stepId: string; attempt: number; code: LeoErrorCode; message: string }
  /** 压缩：replacesUpTo（含）之前的消息在投影中被 summary 取代；原始事件保留用于审计 */
  compaction: { summary: AgentMessage; replacesUpTo: string; strategy: string }
  /** 插件自定义持久化数据 */
  custom: { kind: string; data: unknown }
}

export type SessionEventType = keyof SessionEventMap

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
}
