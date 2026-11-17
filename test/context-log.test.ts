import { describe, expect, it } from 'vitest'
import { defineTool, sectionOwner, type SessionEvent, z } from '../src/index.js'
import { setup } from './helpers.js'

const ofType = <T extends SessionEvent['type']>(log: SessionEvent[], type: T) =>
  log.filter((e) => e.type === type) as Extract<SessionEvent, { type: T }>[]

describe('上下文组成记录（0.2.3）', () => {
  it('llm/request 带 breakdown：system 片段、工具定义、消息、窗口与预留', async () => {
    const { leo } = await setup([{ text: 'hi' }])
    const context = leo.ctx.get('context')
    context.registerSection({ id: 'skills.catalog', layer: 'runtime', render: () => 'skills: a, b' })
    context.registerSection({ id: 'persona', layer: 'tenant', owner: 'interaction', render: () => 'be nice' })
    context.registerSection({ id: 'empty.one', layer: 'task', render: () => '  ' })
    leo.ctx.get('tools').register(
      defineTool({ name: 'echo', description: 'echo back', parameters: z.object({ text: z.string() }), async execute({ text }) { return text } }),
    )
    const agent = leo.createAgent({ model: 'm', systemPrompt: 'You are leo.' })
    await agent.run('hello')
    const [req] = ofType(await leo.ctx.get('sessions').events(agent.sessionId), 'llm/request')
    const b = req!.data.breakdown!
    expect(b.tokenizer).toBe('approx')
    // 按层排序，空片段不出现
    expect(b.sections.map((s) => [s.id, s.layer, s.owner])).toEqual([
      ['persona', 'tenant', 'interaction'],
      ['agent.system', 'agent', 'agent'],
      ['skills.catalog', 'runtime', 'skills'],
    ])
    expect(b.sections.every((s) => s.tokens > 0)).toBe(true)
    expect(Object.keys(b.tools)).toContain('echo')
    expect(b.tools.echo).toBeGreaterThan(0)
    expect(b.messages).toBeGreaterThan(0)
    expect(b.limitTokens).toBe(b.contextWindow - b.reserveOutputTokens)
    expect(b.softLimitTokens).toBeLessThanOrEqual(b.limitTokens)
    // 片段合计与 system 全文同口径
    const systemTokens = Math.ceil(Buffer.byteLength(req!.data.system, 'utf8') / 3.5)
    const sum = b.sections.reduce((n, s) => n + s.tokens, 0)
    expect(Math.abs(sum - systemTokens)).toBeLessThanOrEqual(b.sections.length)
  })

  it('sectionOwner：显式 owner 优先，否则取 id 第一段', () => {
    expect(sectionOwner({ id: 'skills.catalog' })).toBe('skills')
    expect(sectionOwner({ id: 'mcp/instructions' })).toBe('mcp')
    expect(sectionOwner({ id: 'x:y' })).toBe('x')
    expect(sectionOwner({ id: 'plain' })).toBe('plain')
    expect(sectionOwner({ id: 'interaction.persona', owner: 'interaction-persona-whale' })).toBe('interaction-persona-whale')
  })
})
