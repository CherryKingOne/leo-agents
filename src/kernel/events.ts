import type { Logger } from './logger.js'
import type { Disposer, EventName, Handler, PayloadOf, ResultOf } from './types.js'

interface Entry {
  fn: (...args: any[]) => any
  owner: string
}

/**
 * 事件总线：所有插件共享同一个总线，监听器按注册顺序执行（`prepend` 可插到最前）。
 * 监听器的注册由 Context 记入插件的副作用栈，插件卸载时自动移除。
 */
export class EventBus {
  private readonly handlers = new Map<string, Entry[]>()

  constructor(private readonly logger: Logger) {}

  on<E extends EventName>(event: E, fn: Handler<E>, owner: string, prepend = false): Disposer {
    const list = this.handlers.get(event) ?? []
    const entry: Entry = { fn: fn as Entry['fn'], owner }
    if (prepend) list.unshift(entry)
    else list.push(entry)
    this.handlers.set(event, list)
    return () => {
      const cur = this.handlers.get(event)
      if (!cur) return
      const i = cur.indexOf(entry)
      if (i >= 0) cur.splice(i, 1)
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0
  }

  private snapshot(event: string): Entry[] {
    return [...(this.handlers.get(event) ?? [])]
  }

  /** 通知：不等待、不抛出。异常记录日志，绝不影响发布方。 */
  emit<E extends EventName>(event: E, payload: PayloadOf<E>): void {
    for (const h of this.snapshot(event)) {
      try {
        const r = h.fn(payload)
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          ;(r as Promise<unknown>).catch((err) => this.logger.error({ err, event, plugin: h.owner }, 'event listener failed'))
        }
      } catch (err) {
        this.logger.error({ err, event, plugin: h.owner }, 'event listener failed')
      }
    }
  }

  /** 并发执行并等待全部完成；任一失败则抛出第一个错误 */
  async parallel<E extends EventName>(event: E, payload: PayloadOf<E>): Promise<void> {
    const results = await Promise.allSettled(this.snapshot(event).map(async (h) => h.fn(payload)))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  /** 串行执行，收集所有非 undefined 的返回值 */
  async serial<E extends EventName>(event: E, payload: PayloadOf<E>): Promise<ResultOf<E>[]> {
    const out: ResultOf<E>[] = []
    for (const h of this.snapshot(event)) {
      const r = await h.fn(payload)
      if (r !== undefined) out.push(r)
    }
    return out
  }

  /** 闸门：返回第一个非 undefined 的结果；都没有则返回 undefined */
  async bail<E extends EventName>(event: E, payload: PayloadOf<E>): Promise<ResultOf<E> | undefined> {
    for (const h of this.snapshot(event)) {
      const r = await h.fn(payload)
      if (r !== undefined) return r
    }
    return undefined
  }

  /**
   * 洋葱中间件。`final` 是发布方提供的默认实现（最内层）。
   * 每个监听器拿到 `(payload, next)`：调用 `next(p?)` 进入下一层，不调用则短路并直接返回。
   */
  async waterfall<E extends EventName>(
    event: E,
    payload: PayloadOf<E>,
    final: (payload: PayloadOf<E>) => ResultOf<E> | Promise<ResultOf<E>>,
  ): Promise<ResultOf<E>> {
    const chain = this.snapshot(event)
    const run = async (i: number, p: PayloadOf<E>): Promise<ResultOf<E>> => {
      const h = chain[i]
      if (!h) return final(p)
      let called = false
      return h.fn(p, (next?: PayloadOf<E>) => {
        if (called) throw new Error(`next() called multiple times in "${event}" listener of plugin "${h.owner}"`)
        called = true
        return run(i + 1, next === undefined ? p : next)
      })
    }
    return run(0, payload)
  }
}
