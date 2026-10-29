import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { definePlugin } from '../kernel/plugin.js'
import type { EventDef } from '../kernel/types.js'
import { type AgentMessage, newId } from '../protocol/messages.js'
import type { SessionEvent, SessionEventMap, SessionEventType, SessionStore } from './types.js'

declare module '../kernel/types.js' {
  interface Services {
    sessions: SessionStore
  }
  interface Events {
    /** 每条会话事件写入后通知（审计、实时推送、计量） */
    'session/appended': EventDef<'emit', SessionEvent>
  }
}

/** 从事件日志投影出当前可见的消息列表（应用压缩） */
export function deriveMessages(events: readonly SessionEvent[]): AgentMessage[] {
  let out: AgentMessage[] = []
  for (const e of events) {
    if (e.type === 'message') out.push(e.data.message)
    else if (e.type === 'compaction') {
      const idx = out.findIndex((m) => m.id === e.data.replacesUpTo)
      out = [e.data.summary, ...(idx >= 0 ? out.slice(idx + 1) : out)]
    }
  }
  return out
}

/** 内存会话存储：开发与测试使用，进程重启后丢失 */
export class InMemorySessionStore implements SessionStore {
  private readonly data = new Map<string, SessionEvent[]>()

  constructor(private readonly onAppend?: (e: SessionEvent) => void) {}

  async append<T extends SessionEventType>(sessionId: string, type: T, data: SessionEventMap[T]): Promise<SessionEvent<T>> {
    const list = this.data.get(sessionId) ?? []
    const event = { id: newId('evt'), sessionId, seq: list.length + 1, type, at: Date.now(), data } as SessionEvent<T>
    list.push(event as SessionEvent)
    this.data.set(sessionId, list)
    this.onAppend?.(event as SessionEvent)
    return event
  }

  async events(sessionId: string) {
    return [...(this.data.get(sessionId) ?? [])]
  }

  async messages(sessionId: string) {
    return deriveMessages(this.data.get(sessionId) ?? [])
  }

  async delete(sessionId: string) {
    this.data.delete(sessionId)
  }
}

/**
 * JSONL 文件会话存储：每个会话一个 `<dir>/<sessionId>.jsonl`，追加写入。
 * 适合单机部署 / CLI；多实例部署请实现数据库版本。
 */
export class FileSessionStore implements SessionStore {
  private readonly seq = new Map<string, number>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly dir: string,
    private readonly onAppend?: (e: SessionEvent) => void,
  ) {}

  private file(sessionId: string) {
    if (!/^[\w.-]{1,128}$/.test(sessionId)) throw new Error(`Invalid session id for file store: ${sessionId}`)
    return join(this.dir, `${sessionId}.jsonl`)
  }

  async append<T extends SessionEventType>(sessionId: string, type: T, data: SessionEventMap[T]): Promise<SessionEvent<T>> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve()
    const task = prev.then(async () => {
      if (!this.seq.has(sessionId)) this.seq.set(sessionId, (await this.events(sessionId)).length)
      const seq = (this.seq.get(sessionId) ?? 0) + 1
      const event = { id: newId('evt'), sessionId, seq, type, at: Date.now(), data } as SessionEvent<T>
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.file(sessionId), `${JSON.stringify(event)}\n`, 'utf8')
      this.seq.set(sessionId, seq)
      this.onAppend?.(event as SessionEvent)
      return event
    })
    this.locks.set(sessionId, task.catch(() => {}))
    return task
  }

  async events(sessionId: string): Promise<SessionEvent[]> {
    let text: string
    try {
      text = await readFile(this.file(sessionId), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionEvent)
  }

  async messages(sessionId: string) {
    return deriveMessages(await this.events(sessionId))
  }

  async delete(sessionId: string) {
    await rm(this.file(sessionId), { force: true })
    this.seq.delete(sessionId)
  }
}

/**
 * 核心插件：提供 `sessions` 服务（默认内存实现）。
 * 换存储：加载一个 `ctx.provide('sessions', new MyStore())` 的插件即可覆盖。
 */
export const sessionPlugin = definePlugin<{ dir?: string } | undefined>({
  name: 'leo:sessions',
  apply(ctx, config) {
    const notify = (e: SessionEvent) => ctx.emit('session/appended', e)
    ctx.provide('sessions', config?.dir ? new FileSessionStore(config.dir, notify) : new InMemorySessionStore(notify))
  },
})
