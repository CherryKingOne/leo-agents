import { describe, expect, it } from 'vitest'
import { createConsoleLogger, definePlugin, type EventDef, Kernel, LeoError, z } from '../src/index.js'

declare module '../src/kernel/types.js' {
  interface Services {
    'test.greeter': { greet(name: string): string }
  }
  interface Events {
    'test/wf': EventDef<'waterfall', { n: number }, number>
    'test/bail': EventDef<'bail', number, string>
    'test/serial': EventDef<'serial', number, number>
  }
}

const quiet = () => new Kernel({ logger: createConsoleLogger('silent') })

describe('kernel', () => {
  it('waits for injected services and applies once ready', async () => {
    const k = quiet()
    const log: string[] = []
    await k.root.plugin(
      definePlugin({
        name: 'consumer',
        inject: ['test.greeter'],
        apply(ctx) {
          log.push(ctx.get('test.greeter').greet('leo'))
        },
      }),
    )
    expect(log).toEqual([])
    await k.root.plugin(definePlugin({ name: 'provider', apply: (ctx) => void ctx.provide('test.greeter', { greet: (n) => `hi ${n}` }) }))
    await k.ready()
    expect(log).toEqual(['hi leo'])
  })

  it('ready() reports unresolved plugins', async () => {
    const k = quiet()
    await k.root.plugin(definePlugin({ name: 'lonely', inject: ['nope'], apply() {} }))
    await expect(k.ready()).rejects.toMatchObject({ code: 'plugin_unresolved' })
  })

  it('disposes effects in LIFO order on unload', async () => {
    const k = quiet()
    const order: string[] = []
    const rt = await k.root.plugin(
      definePlugin({
        name: 'fx',
        async apply(ctx) {
          await ctx.effect(() => () => void order.push('a'))
          await ctx.effect(() => () => void order.push('b'))
          ctx.on('test/serial', () => 1)
        },
      }),
    )
    expect(k.bus.listenerCount('test/serial')).toBe(1)
    await rt.dispose()
    expect(order).toEqual(['b', 'a'])
    expect(k.bus.listenerCount('test/serial')).toBe(0)
  })

  it('restarts dependents when a service is replaced, and falls back when removed', async () => {
    const k = quiet()
    const seen: string[] = []
    await k.root.plugin(definePlugin({ name: 'p1', apply: (ctx) => void ctx.provide('test.greeter', { greet: () => 'v1' }) }))
    await k.root.plugin(
      definePlugin({ name: 'c', inject: ['test.greeter'], apply: (ctx) => void seen.push(ctx.get('test.greeter').greet('')) }),
    )
    const p2 = await k.root.plugin(definePlugin({ name: 'p2', apply: (ctx) => void ctx.provide('test.greeter', { greet: () => 'v2' }) }))
    await k.ready()
    expect(seen).toEqual(['v1', 'v2'])
    await p2.dispose()
    await k.ready()
    expect(seen).toEqual(['v1', 'v2', 'v1'])
  })

  it('validates plugin config with zod', async () => {
    const k = quiet()
    const p = definePlugin({ name: 'cfg', config: z.object({ n: z.number() }), apply() {} })
    await expect(k.root.plugin(p, { n: 'x' } as never)).rejects.toBeInstanceOf(LeoError)
  })

  it('supports function-style plugins', async () => {
    const k = quiet()
    let called = false
    const fn = Object.assign((ctx: unknown) => void (called = !!ctx), { pluginName: 'fn-style' })
    const rt = await k.root.plugin(fn)
    expect(called).toBe(true)
    expect(rt.name).toBe('fn-style')
  })

  it('implements waterfall / bail / serial semantics', async () => {
    const k = quiet()
    const ctx = k.root
    ctx.on('test/wf', async (p, next) => (await next({ n: p.n + 1 })) * 10)
    ctx.on('test/wf', (p, next) => (p.n > 100 ? -1 : next()))
    expect(await ctx.waterfall('test/wf', { n: 1 }, (p) => p.n)).toBe(20)
    expect(await ctx.waterfall('test/wf', { n: 200 }, (p) => p.n)).toBe(-10)

    ctx.on('test/bail', (n) => (n > 1 ? undefined : 'first'))
    ctx.on('test/bail', () => 'second')
    expect(await ctx.bail('test/bail', 1)).toBe('first')
    expect(await ctx.bail('test/bail', 2)).toBe('second')

    ctx.on('test/serial', (n) => n)
    ctx.on('test/serial', () => undefined)
    ctx.on('test/serial', (n) => n * 2)
    expect(await ctx.serial('test/serial', 3)).toEqual([3, 6])
  })

  it('fork creates scoped child contexts', async () => {
    const k = quiet()
    const child = k.root.fork({ tenant: { tenantId: 't1' }, agentId: 'a1' })
    expect(child.tenant?.tenantId).toBe('t1')
    expect(child.scope.agentId).toBe('a1')
    await k.root.dispose()
    expect(child.isDisposed).toBe(true)
  })
})
