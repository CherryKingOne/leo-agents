import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveMessages, FileSessionStore, newId, sanitizeMessages, type AgentMessage } from '../src/index.js'

const msg = (role: string, text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id: newId('msg'),
  role,
  content: [{ type: 'text', text }],
  createdAt: 0,
  ...extra,
})

describe('sessions', () => {
  it('file store appends JSONL with monotonic seq under concurrency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leo-'))
    try {
      const store = new FileSessionStore(dir)
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.append('s1', 'message', { message: msg('user', `m${i}`) })))
      const events = await store.events('s1')
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
      expect(await store.messages('s1')).toHaveLength(20)
      const fresh = new FileSessionStore(dir)
      const e = await fresh.append('s1', 'custom', { kind: 'x', data: 1 })
      expect(e.seq).toBe(21)
      await expect(store.append('../evil', 'custom', { kind: 'x', data: 1 })).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deriveMessages applies compaction', () => {
    const a = msg('user', 'a')
    const b = msg('assistant', 'b')
    const c = msg('user', 'c')
    const summary = msg('user', 'summary', { meta: { compaction: true } })
    const base = { sessionId: 's', at: 0 }
    const out = deriveMessages([
      { ...base, id: '1', seq: 1, type: 'message', data: { message: a } },
      { ...base, id: '2', seq: 2, type: 'message', data: { message: b } },
      { ...base, id: '3', seq: 3, type: 'compaction', data: { summary, replacesUpTo: b.id, strategy: 't' } },
      { ...base, id: '4', seq: 4, type: 'message', data: { message: c } },
    ])
    expect(out.map((m) => m.id)).toEqual([summary.id, c.id])
  })

  it('sanitizeMessages repairs missing and orphan tool results', () => {
    const asst: AgentMessage = {
      id: 'a',
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 't1', name: 'x', arguments: {}, rawArguments: '{}' },
        { type: 'tool_call', id: 't2', name: 'y', arguments: {}, rawArguments: '{}' },
      ],
      createdAt: 0,
    }
    const out = sanitizeMessages([
      msg('tool', 'orphan', { toolCallId: 'zzz' }),
      msg('user', 'u'),
      asst,
      msg('tool', 'r2', { toolCallId: 't2' }),
    ])
    expect(out.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 't1'],
      ['tool', 't2'],
    ])
    expect(out[2]!.isError).toBe(true)
  })
})
