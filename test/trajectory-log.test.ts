import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defineTool,
  FileSessionStore,
  InMemorySessionStore,
  LeoError,
  type SessionEvent,
  type SessionStore,
  toolOutput,
  z,
} from '../src/index.js'
import { setup } from './helpers.js'

const ofType = <T extends SessionEvent['type']>(log: SessionEvent[], type: T) =>
  log.filter((e) => e.type === type) as Extract<SessionEvent, { type: T }>[]

describe('轨迹记录（0.2.2）', () => {
  it('工具调用写入 tool/start 与 tool/end，顺序在工具结果消息之前', async () => {
    const { leo } = await setup([
      {
        toolCalls: [
          { id: 'a', name: 'sleep', arguments: { ms: 40 } },
          { id: 'b', name: 'boom', arguments: {} },
          { id: 'c', name: 'missing', arguments: {} },
        ],
      },
      { text: 'done' },
    ])
    const tools = leo.ctx.get('tools')
    tools.register(
      defineTool({
        name: 'sleep',
        description: 'sleep',
        parameters: z.object({ ms: z.number() }),
        async execute({ ms }) {
          await new Promise((r) => setTimeout(r, ms))
          return 'ok'
        },
      }),
    )
    tools.register(
      defineTool({
        name: 'boom',
        description: 'fails',
        parameters: z.object({}),
        async execute() {
          return toolOutput({ content: 'bad', isError: true })
        },
      }),
    )
    const agent = leo.createAgent({ model: 'm' })
    await agent.run('go')
    const log = await leo.ctx.get('sessions').events(agent.sessionId)

    const starts = ofType(log, 'tool/start')
    const ends = ofType(log, 'tool/end')
    // missing 工具从未开始执行：没有 start/end
    expect(starts.map((e) => e.data.callId).sort()).toEqual(['a', 'b'])
    expect(ends.map((e) => e.data.callId).sort()).toEqual(['a', 'b'])

    const req = ofType(log, 'llm/request')[0]!
    const assistant = log.find((e) => e.type === 'message' && e.data.message.role === 'assistant')!
    for (const s of starts) {
      expect(s.data.turnId).toBe(req.data.turnId)
      expect(s.data.stepId).toBe(req.data.stepId)
      expect(s.data.messageId).toBe(assistant.type === 'message' && assistant.data.message.id)
      expect(typeof s.data.at).toBe('number')
    }
    const a = ends.find((e) => e.data.callId === 'a')!
    expect(a.data.name).toBe('sleep')
    expect(a.data.isError).toBe(false)
    expect(a.data.durationMs).toBeGreaterThanOrEqual(30)
    expect(a.data.endedAt - a.data.startedAt).toBeGreaterThanOrEqual(30)
    const b = ends.find((e) => e.data.callId === 'b')!
    expect(b.data.isError).toBe(true)

    // 所有 tool/end 都在第一条 tool 结果消息之前（seq 更小）
    const firstToolMsg = log.find((e) => e.type === 'message' && e.data.message.role === 'tool')!
    for (const e of ends) expect(e.seq).toBeLessThan(firstToolMsg.seq)
    for (const s of starts) {
      const end = ends.find((e) => e.data.callId === s.data.callId)!
      expect(s.seq).toBeLessThan(end.seq)
    }
  })

  it('llm/response 带 startedAt 与 firstTokenAt（TTFT），失败尝试带 startedAt', async () => {
    const { leo } = await setup([
      { error: new LeoError('network', 'flaky') },
      { text: 'hello world', delayMs: 30 },
    ])
    const agent = leo.createAgent({ model: 'm', retry: { baseDelayMs: 1, maxDelayMs: 2 } })
    const r = await agent.run('hi')
    expect(r.reason).toBe('completed')
    const log = await leo.ctx.get('sessions').events(agent.sessionId)
    const failed = ofType(log, 'llm/attempt-failed')[0]!
    expect(typeof failed.data.startedAt).toBe('number')
    const res = ofType(log, 'llm/response')[0]!
    expect(res.data.attempts).toBe(2)
    expect(res.data.startedAt).toBeGreaterThanOrEqual(failed.data.startedAt!)
    expect(res.data.firstTokenAt).toBeDefined()
    expect(res.data.firstTokenAt! - res.data.startedAt!).toBeGreaterThanOrEqual(25)
    expect(res.at).toBeGreaterThanOrEqual(res.data.firstTokenAt!)
  })

  it('不传 sessionMeta 时日志形状与 0.2.1 相同（不写 session/meta）', async () => {
    const { leo } = await setup([{ text: 'x' }])
    const agent = leo.createAgent({ model: 'm' })
    await agent.run('hi')
    const log = await leo.ctx.get('sessions').events(agent.sessionId)
    expect(log[0]!.type).toBe('turn/start')
    expect(ofType(log, 'session/meta')).toHaveLength(0)
  })

  it('sessionMeta 在新会话第一个 turn 前写入一次，补上 agentId / model / label', async () => {
    const { leo } = await setup([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    const agent = leo.createAgent({
      model: 'm',
      label: 'sub-agent:explorer',
      sessionMeta: { origin: 'sub-agent', parentSessionId: 'ses_parent', parentToolCallId: 'call_1', extra: { type: 'explorer' } },
    })
    await agent.run('one')
    await agent.run('two')
    // 换一个 Agent 续写同一会话：已有 session/meta，不重复写
    const again = leo.createAgent({ model: 'm', sessionId: agent.sessionId, sessionMeta: { origin: 'other' } })
    await again.run('three')
    const log = await leo.ctx.get('sessions').events(agent.sessionId)
    const metas = ofType(log, 'session/meta')
    expect(metas).toHaveLength(1)
    expect(log[0]!.type).toBe('session/meta')
    expect(metas[0]!.data).toEqual({
      origin: 'sub-agent',
      parentSessionId: 'ses_parent',
      parentToolCallId: 'call_1',
      extra: { type: 'explorer' },
      label: 'sub-agent:explorer',
      agentId: agent.id,
      model: 'm',
    })
  })

  it('agentFactory 透传 sessionMeta', async () => {
    const { leo } = await setup([{ text: 'a' }])
    const agent = leo.ctx.get('agentLoop').create({ model: 'm', sessionMeta: { origin: 'team-member', label: 'dev' } })
    await agent.run('x')
    const [meta] = ofType(await leo.ctx.get('sessions').events(agent.sessionId), 'session/meta')
    expect(meta!.data.origin).toBe('team-member')
    expect(meta!.data.label).toBe('dev')
  })

  it('InMemorySessionStore.list() 返回会话及元信息，按更新时间倒序', async () => {
    const store: SessionStore = new InMemorySessionStore()
    await store.append('s1', 'session/meta', { origin: 'main', label: 'one' })
    await store.append('s1', 'custom', { kind: 'k', data: 1 })
    await new Promise((r) => setTimeout(r, 5))
    await store.append('s2', 'custom', { kind: 'k', data: 2 })
    const list = await store.list!()
    expect(list.map((s) => s.sessionId)).toEqual(['s2', 's1'])
    const s1 = list.find((s) => s.sessionId === 's1')!
    expect(s1.events).toBe(2)
    expect(s1.meta).toEqual({ origin: 'main', label: 'one' })
    expect(s1.updatedAt).toBeGreaterThanOrEqual(s1.createdAt)
    expect(list.find((s) => s.sessionId === 's2')!.meta).toBeUndefined()
  })

  it('FileSessionStore：新事件往返读写，list() 读目录并跳过坏文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leo-traj-'))
    try {
      expect(await new FileSessionStore(join(dir, 'nope')).list()).toEqual([])
      const { leo } = await setup([{ toolCalls: [{ id: 't1', name: 'echo', arguments: { s: 'x' } }] }, { text: 'ok', delayMs: 5 }], {
        sessions: { dir },
      })
      leo.ctx.get('tools').register(
        defineTool({ name: 'echo', description: 'echo', parameters: z.object({ s: z.string() }), execute: ({ s }) => s }),
      )
      const agent = leo.createAgent({ model: 'm', sessionMeta: { origin: 'main', label: '主会话' } })
      await agent.run('go')
      await writeFile(join(dir, 'broken.jsonl'), 'not json\n')
      await writeFile(join(dir, 'ignore.txt'), 'x')

      const fresh = new FileSessionStore(dir)
      const log = await fresh.events(agent.sessionId)
      expect(log.map((e) => e.type)).toEqual([
        'session/meta',
        'turn/start',
        'message',
        'llm/request',
        'llm/response',
        'message',
        'tool/start',
        'tool/end',
        'message',
        'llm/request',
        'llm/response',
        'message',
        'turn/end',
      ])
      const res = ofType(log, 'llm/response')[1]!
      expect(res.data.firstTokenAt).toBeGreaterThanOrEqual(res.data.startedAt!)
      const list = await fresh.list()
      expect(list).toHaveLength(1)
      expect(list[0]!.sessionId).toBe(agent.sessionId)
      expect(list[0]!.events).toBe(log.length)
      expect(list[0]!.meta?.label).toBe('主会话')
      expect(list[0]!.createdAt).toBe(log[0]!.at)
      expect(list[0]!.updatedAt).toBe(log.at(-1)!.at)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('不实现 list 的第三方存储仍然满足接口', () => {
    const minimal: SessionStore = {
      append: async () => ({}) as never,
      events: async () => [],
      messages: async () => [],
      delete: async () => {},
    }
    expect(minimal.list).toBeUndefined()
  })
})
