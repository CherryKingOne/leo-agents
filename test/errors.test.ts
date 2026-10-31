import { describe, expect, it } from 'vitest'
import { createLeo, LEO_ERROR_MARK, LeoError, toLeoError } from '../src/index.js'

/** 插件（不能运行时 import leo-agents）抛的“类 LeoError” */
const pluginError = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { [Symbol.for('leo.error')]: true, code, ...extra })

describe('toLeoError', () => {
  it('keeps code / retryAfterMs / status of marked plugin errors', () => {
    const e = toLeoError(pluginError('rate_limit', 'slow', { retryAfterMs: 5, status: 429 }), 'network')
    expect(e).toBeInstanceOf(LeoError)
    expect([e.code, e.retryAfterMs, e.status, e.retryable, e.message]).toEqual(['rate_limit', 5, 429, true, 'slow'])
    expect(LEO_ERROR_MARK).toBe(Symbol.for('leo.error'))
  })

  it('recognises errors named LeoError from another copy, ignores unknown codes and unmarked errors', () => {
    expect(toLeoError(Object.assign(new Error('x'), { name: 'LeoError', code: 'auth' }), 'network').code).toBe('auth')
    expect(toLeoError(pluginError('nope', 'x'), 'network').code).toBe('network')
    expect(toLeoError(Object.assign(new Error('x'), { code: 'auth' }), 'network').code).toBe('network')
  })

  it('agent loop does not retry a provider plugin auth error', async () => {
    let calls = 0
    const leo = await createLeo({
      logLevel: 'silent',
      providers: [
        {
          id: 'p',
          // eslint-disable-next-line require-yield
          async *stream() {
            calls++
            throw pluginError('auth', 'Invalid API key', { status: 401 })
          },
        },
      ],
    })
    const r = await leo.createAgent({ model: 'm', retry: { baseDelayMs: 1 } }).run('x')
    expect(calls).toBe(1)
    expect(r.error?.code).toBe('auth')
    await leo.dispose()
  })
})
