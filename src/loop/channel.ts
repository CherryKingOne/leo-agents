/** 单生产者 / 单消费者的异步队列，用于把 loop 的事件推给 for-await 消费者 */
export class Channel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false
  private failure: unknown

  constructor(private readonly onReturn?: () => void) {}

  push(value: T) {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value, done: false })
    else this.buffer.push(value)
  }

  close(error?: unknown) {
    if (this.closed) return
    this.closed = true
    this.failure = error
    for (const w of this.waiters) w({ value: undefined as never, done: true })
    this.waiters = []
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.buffer.shift()
        if (v !== undefined) return Promise.resolve({ value: v, done: false })
        if (this.closed) {
          if (this.failure) return Promise.reject(this.failure)
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: () => {
        if (!this.closed) this.onReturn?.()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}
