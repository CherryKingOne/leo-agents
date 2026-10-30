import { describe, expect, it } from 'vitest'
import { type AgentEvent, defineTool, definePlugin, LeoError, toolOutput, z } from '../src/index.js'
import { setup } from './helpers.js'

const collect = async (it: AsyncIterable<AgentEvent>) => {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('agent loop', () => {
  it('streams a plain answer and records the session log', async () => {
    const { leo } = await setup([{ text: '你好，我是 leo。', usage: { inputTokens: 100, outputTokens: 20 } }])
    const agent = leo.createAgent({ model: 'm', systemPrompt: 'be nice' })
    const events = await collect(agent.prompt('hi'))
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('turn_start')
    expect(types).toContain('text_delta')
    expect(types.at(-1)).toBe('turn_end')
    const end = events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>
    expect(end.reason).toBe('completed')
    expect(end.usage.inputTokens).toBe(100)
    expect(end.usage.costUsd).toBeCloseTo((100 * 1 + 20 * 2) / 1e6)

    const log = await leo.ctx.get('sessions').events(agent.sessionId)
    expect(log.map((e) => e.type)).toEqual(['turn/start', 'message', 'llm/request', 'llm/response', 'message', 'turn/end'])
    const req = log.find((e) => e.type === 'llm/request')!
    expect(req.type === 'llm/request' && req.data.system).toBe('be nice')
  })

  it('executes tools in parallel and keeps results in call order', async () => {
    const started: string[] = []
    const { leo, mock } = await setup([
      {
        toolCalls: [
          { id: 'a', name: 'sleep', arguments: { ms: 60, tag: 'slow' } },
          { id: 'b', name: 'sleep', arguments: { ms: 5, tag: 'fast' } },
        ],
      },
      { text: 'done' },
    ])
    leo.ctx.get('tools').register(
      defineTool({
        name: 'sleep',
        description: 'sleep',
        parameters: z.object({ ms: z.number(), tag: z.string() }),
        async execute({ ms, tag }) {
          started.push(tag)
          await new Promise((r) => setTimeout(r, ms))
          return `${tag} ok`
        },
      }),
    )
    const agent = leo.createAgent({ model: 'm' })
    const t0 = Date.now()
    const r = await agent.run('go')
    expect(Date.now() - t0).toBeLessThan(150)
    expect(r.reason).toBe('completed')
    expect(r.text).toBe('done')
    const toolMsgs = r.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['a', 'b'])
    // 第二次请求包含工具结果，且 assistant tool_call 与 tool 结果配对
    const second = mock.requests[1]!
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(second.tools?.[0]?.name).toBe('sleep')
  })

  it('returns validation errors to the model instead of crashing', async () => {
    const { leo, mock } = await setup([{ toolCalls: [{ name: 'add', arguments: { a: 'x' } }] }, { text: 'fixed' }])
    leo.ctx.get('tools').register(
      defineTool({ name: 'add', description: 'add', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => a + b }),
    )
    const r = await leo.createAgent({ model: 'm' }).run('1+1')
    expect(r.reason).toBe('completed')
    const tool = mock.requests[1]!.messages.find((m) => m.role === 'tool')!
    expect(tool.isError).toBe(true)
    expect(JSON.stringify(tool.content)).toContain('Invalid arguments')
  })

  it('handles unknown tools and malformed JSON arguments', async () => {
    const { leo, mock } = await setup([
      { toolCalls: [{ name: 'ghost', arguments: {} }, { name: 'echo', arguments: '{"x":' }] },
      { text: 'ok' },
    ])
    leo.ctx.get('tools').register(defineTool({ name: 'echo', description: 'e', parameters: z.object({ x: z.number() }), execute: (a) => a }))
    await leo.createAgent({ model: 'm' }).run('x')
    const tools = mock.requests[1]!.messages.filter((m) => m.role === 'tool')
    expect(tools.map((t) => t.meta?.errorCode)).toEqual(['tool_not_found', 'tool_invalid_args'])
  })

  it('retries retryable LLM errors with backoff', async () => {
    const { leo, mock } = await setup([
      { error: new LeoError('rate_limit', 'slow down', { retryAfterMs: 10 }) },
      { text: 'partial', error: new LeoError('overloaded', 'boom'), errorAfterText: true },
      { text: 'finally' },
    ])
    const events = await collect(leo.createAgent({ model: 'm', retry: { baseDelayMs: 1 } }).prompt('x'))
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2)
    expect((events.at(-1) as { reason: string }).reason).toBe('completed')
    expect(mock.requests).toHaveLength(3)
  })

  it('does not retry non-retryable errors and reports them', async () => {
    const { leo } = await setup([{ error: new LeoError('auth', 'bad key') }])
    const r = await leo.createAgent({ model: 'm' }).run('x')
    expect(r.reason).toBe('error')
    expect(r.error?.code).toBe('auth')
  })

  it('compacts and retries on context_overflow', async () => {
    const { leo, mock } = await setup(
      [{ text: 'a1' }, { text: 'a2' }, { text: 'a3' }, { error: new LeoError('context_overflow', 'too long') }, { text: 'after compaction' }],
      { context: { keepRecentTurns: 1 } },
    )
    const agent = leo.createAgent({ model: 'm' })
    await agent.run('q1')
    await agent.run('q2')
    await agent.run('q3')
    const r = await agent.run('q4')
    expect(r.reason).toBe('completed')
    expect(r.text).toBe('after compaction')
    const last = mock.requests.at(-1)!
    expect(last.messages[0]!.meta?.compaction).toBe(true)
    expect(last.messages.at(-1)!.content).toEqual([{ type: 'text', text: 'q4' }])
    const visible = await agent.messages()
    expect(visible[0]!.meta?.compaction).toBe(true)
  })

  it('stops at maxSteps', async () => {
    const loopCall = { toolCalls: [{ name: 'noop', arguments: {} }] }
    const { leo } = await setup([loopCall, loopCall, loopCall])
    leo.ctx.get('tools').register(defineTool({ name: 'noop', description: 'n', parameters: z.object({}), execute: () => 'ok' }))
    const r = await leo.createAgent({ model: 'm', limits: { maxSteps: 2 } }).run('x')
    expect(r.reason).toBe('max_steps')
    expect(r.steps).toBe(2)
  })

  it('stops when the token budget is exhausted', async () => {
    const call = { toolCalls: [{ name: 'noop', arguments: {} }], usage: { inputTokens: 600, outputTokens: 10 } }
    const { leo } = await setup([call, call])
    leo.ctx.get('tools').register(defineTool({ name: 'noop', description: 'n', parameters: z.object({}), execute: () => 'ok' }))
    const r = await leo.createAgent({ model: 'm' }).run('x', { maxTurnTokens: 1000 })
    expect(r.reason).toBe('budget_exceeded')
    expect(r.steps).toBe(2)
  })

  it('ends the turn when all tools terminate', async () => {
    const { leo, mock } = await setup([{ toolCalls: [{ name: 'finish', arguments: {} }] }])
    leo.ctx.get('tools').register(
      defineTool({ name: 'finish', description: 'f', parameters: z.object({}), execute: () => toolOutput({ content: 'bye', terminate: true }) }),
    )
    const r = await leo.createAgent({ model: 'm' }).run('x')
    expect(r.reason).toBe('terminated_by_tool')
    expect(mock.requests).toHaveLength(1)
  })

  it('cancels mid-tool and records cancelled tool results', async () => {
    const { leo } = await setup([{ toolCalls: [{ id: 'c1', name: 'hang', arguments: {} }] }])
    leo.ctx.get('tools').register(
      defineTool({
        name: 'hang',
        description: 'h',
        parameters: z.object({}),
        execute: (_a, exec) => new Promise((_r, rej) => exec.signal.addEventListener('abort', () => rej(exec.signal.reason))),
      }),
    )
    const agent = leo.createAgent({ model: 'm' })
    const events: AgentEvent[] = []
    for await (const e of agent.prompt('x')) {
      events.push(e)
      if (e.type === 'tool_start') agent.abort('user pressed stop')
    }
    expect((events.at(-1) as { reason: string }).reason).toBe('cancelled')
    const msgs = await agent.messages()
    const tool = msgs.find((m) => m.role === 'tool')!
    expect(tool.toolCallId).toBe('c1')
    expect(tool.meta?.errorCode).toBe('cancelled')
    expect(agent.status).toBe('idle')
  })

  it('cancels while streaming and keeps the partial text', async () => {
    const { leo } = await setup([{ text: 'a long long long answer', delayMs: 20 }])
    const agent = leo.createAgent({ model: 'm' })
    const ac = new AbortController()
    const events: AgentEvent[] = []
    for await (const e of agent.prompt('x', { signal: ac.signal })) {
      events.push(e)
      if (e.type === 'text_delta') ac.abort()
    }
    expect((events.at(-1) as { reason: string }).reason).toBe('cancelled')
    const msgs = await agent.messages()
    expect(msgs.at(-1)!.meta?.partial).toBe(true)
  })

  it('enforces the turn timeout', async () => {
    const { leo } = await setup([{ text: 'slow slow slow slow slow', delayMs: 50 }])
    const r = await leo.createAgent({ model: 'm' }).run('x', { turnTimeoutMs: 60 })
    expect(r.reason).toBe('timeout')
  })

  it('rejects concurrent turns on the same session', async () => {
    const { leo } = await setup([{ text: 'one', delayMs: 10 }])
    const agent = leo.createAgent({ model: 'm' })
    const first = agent.run('a')
    expect(() => agent.prompt('b')).toThrow(/active turn/)
    await first
  })

  it('injects steer messages before the next step and runs follow-ups', async () => {
    const { leo, mock } = await setup([
      { toolCalls: [{ name: 'noop', arguments: {} }] },
      { text: 'steered' },
      { text: 'followed up' },
    ])
    leo.ctx.get('tools').register(defineTool({ name: 'noop', description: 'n', parameters: z.object({}), execute: () => 'ok' }))
    const agent = leo.createAgent({ model: 'm' })
    agent.followUp('and then?')
    for await (const e of agent.prompt('start')) {
      if (e.type === 'tool_start') agent.steer('change of plan')
    }
    const roles = mock.requests[1]!.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(mock.requests[2]!.messages.at(-1)!.content).toEqual([{ type: 'text', text: 'and then?' }])
  })

  it('lets plugins deny tools, ask for approval, and stop steps', async () => {
    const approvals: string[] = []
    const { leo, mock } = await setup(
      [{ toolCalls: [{ name: 'rm', arguments: { path: '/' } }, { name: 'rm', arguments: { path: '/tmp/x' } }] }, { text: 'ok' }],
      {
        plugins: [
          definePlugin({
            name: 'policy',
            apply(ctx) {
              ctx.on('tools/pre-execute', (p, next) => {
                const path = (p.args as { path: string }).path
                if (path === '/') return { action: 'deny', reason: 'refusing to delete root' }
                return { action: 'ask', reason: 'destructive' }
              })
              ctx.provide('approval', {
                async request(req) {
                  approvals.push((req.args as { path: string }).path)
                  return { approved: true }
                },
              })
            },
          }),
        ],
      },
    )
    leo.ctx.get('tools').register(
      defineTool({ name: 'rm', description: 'rm', parameters: z.object({ path: z.string() }), execute: ({ path }) => `removed ${path}` }),
    )
    await leo.createAgent({ model: 'm' }).run('clean up')
    const tools = mock.requests[1]!.messages.filter((m) => m.role === 'tool')
    expect(tools[0]!.isError).toBe(true)
    expect(JSON.stringify(tools[0]!.content)).toContain('refusing')
    expect(tools[1]!.isError).toBe(false)
    expect(approvals).toEqual(['/tmp/x'])
  })

  it('fails closed when approval is required but not configured', async () => {
    const { leo } = await setup([{ toolCalls: [{ name: 't', arguments: {} }] }, { text: 'ok' }], {
      plugins: [(ctx) => void ctx.on('tools/pre-execute', () => ({ action: 'ask' }))],
    })
    leo.ctx.get('tools').register(defineTool({ name: 't', description: 't', parameters: z.object({}), execute: () => 'ran' }))
    const r = await leo.createAgent({ model: 'm' }).run('x')
    const tool = r.messages.find((m) => m.role === 'tool')!
    expect(tool.meta?.errorCode).toBe('tool_denied')
  })

  it('times out tools that ignore the abort signal', async () => {
    const { leo } = await setup([{ toolCalls: [{ name: 'stuck', arguments: {} }] }, { text: 'ok' }])
    leo.ctx.get('tools').register(
      defineTool({ name: 'stuck', description: 's', parameters: z.object({}), timeoutMs: 30, execute: () => new Promise(() => {}) }),
    )
    const r = await leo.createAgent({ model: 'm' }).run('x')
    expect(r.messages.find((m) => m.role === 'tool')!.meta?.errorCode).toBe('tool_timeout')
  })

  it('agent/pre-step can stop the turn (quota) and turn-stopping can continue it', async () => {
    let n = 0
    const { leo, mock } = await setup([{ text: 'draft' }, { text: 'final' }], {
      plugins: [
        (ctx) => {
          ctx.on('agent/turn-stopping', () => (n++ === 0 ? { continue: true, message: 'please refine' } : undefined))
        },
      ],
    })
    const r = await leo.createAgent({ model: 'm' }).run('x')
    expect(r.text).toBe('final')
    expect(mock.requests).toHaveLength(2)

    const blocked = await setup([], { plugins: [(ctx) => void ctx.on('agent/pre-step', () => ({ action: 'stop', reason: 'budget_exceeded' }))] })
    const r2 = await blocked.leo.createAgent({ model: 'm' }).run('x')
    expect(r2.reason).toBe('budget_exceeded')
    expect(blocked.mock.requests).toHaveLength(0)
  })

  it('emits usage/recorded for billing and supports prompt sections', async () => {
    const usage: number[] = []
    const { leo, mock } = await setup([{ text: 'ok', usage: { inputTokens: 7, outputTokens: 3 } }], {
      plugins: [
        definePlugin({
          name: 'billing+prompt',
          inject: ['context'],
          apply(ctx) {
            ctx.on('usage/recorded', (u) => void usage.push(u.usage.inputTokens))
            void ctx.effect(() =>
              ctx.get('context').registerSection({ id: 'platform.safety', layer: 'platform', render: () => 'SAFETY RULES' }),
            )
            void ctx.effect(() =>
              ctx.get('context').registerSection({ id: 'runtime.tenant', layer: 'runtime', render: (i) => `tenant=${i.tenant?.tenantId}` }),
            )
          },
        }),
      ],
    })
    await leo.createAgent({ model: 'm', systemPrompt: 'AGENT', tenant: { tenantId: 'acme' } }).run('x')
    expect(usage).toEqual([7])
    expect(mock.requests[0]!.system).toBe('SAFETY RULES\n\nAGENT\n\ntenant=acme')
  })

  it('continues an existing session by id', async () => {
    const { leo, mock } = await setup([{ text: 'first' }, { text: 'second' }])
    const a1 = leo.createAgent({ model: 'm', sessionId: 'ses_fixed' })
    await a1.run('hello')
    await a1.dispose()
    const a2 = leo.createAgent({ model: 'm', sessionId: 'ses_fixed' })
    await a2.run('again')
    expect(mock.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })
})
