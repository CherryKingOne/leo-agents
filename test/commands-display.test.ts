import { describe, expect, it } from 'vitest'
import { setup } from './helpers.js'

describe('commands service', () => {
  it('registers, runs, lists and unregisters plugin commands', async () => {
    const { leo } = await setup([])
    const cmds = leo.ctx.get('commands')
    const off = cmds.register({
      name: 'sticker',
      aliases: ['st'],
      usage: '<id>',
      run: ({ argv, surface }) => ({ text: `${surface}:${argv[0]}`, display: [{ type: 'text', text: 'hi' }], prompt: `[表情] ${argv[0]}` }),
    })
    expect(cmds.list().map((d) => d.name)).toEqual(['sticker'])
    const r = await cmds.run('st', { args: '  enough  ', surface: 'cli' })
    expect(r).toEqual({ text: 'cli:enough', display: [{ type: 'text', text: 'hi' }], prompt: '[表情] enough' })
    expect(() => cmds.register({ name: 'st', run: () => {} })).toThrow(/already registered/)
    expect(() => cmds.register({ name: 'Bad Name', run: () => {} })).toThrow(/Invalid command name/)
    off()
    expect(await cmds.run('sticker', { args: '', surface: 'cli' })).toBeUndefined()
  })

  it('turns string results and thrown errors into CommandResult', async () => {
    const { leo } = await setup([])
    const cmds = leo.ctx.get('commands')
    cmds.register({ name: 'echo', run: ({ args }) => args })
    cmds.register({
      name: 'boom',
      run: () => {
        throw new Error('nope')
      },
    })
    expect(await cmds.run('echo', { args: 'a b', surface: 'gateway' })).toEqual({ text: 'a b' })
    expect(await cmds.run('boom', { args: '', surface: 'cli' })).toEqual({ text: 'nope', isError: true })
  })
})

describe('tool display blocks', () => {
  it('passes display from tool output to the result, event and session log but not to the model', async () => {
    const { leo, mock } = await setup([{ toolCalls: [{ id: 'a', name: 'send_sticker', arguments: { id: 'enough' } }] }, { text: 'ok' }])
    leo.ctx.get('tools').register({
      name: 'send_sticker',
      description: 'send a sticker',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: (a: { id: string }) => a.id,
      render: (v: string) => ({ content: `已发送表情 ${v}`, display: [{ type: 'ansi', lines: ['\x1b[31m▀\x1b[0m'], fallback: '[这就够了]' }] }),
    })
    const agent = leo.createAgent({ model: 'm' })
    const seen: unknown[] = []
    for await (const ev of agent.prompt('go')) if (ev.type === 'tool_result') seen.push(ev.result.display)
    expect(seen).toEqual([[{ type: 'ansi', lines: ['\x1b[31m▀\x1b[0m'], fallback: '[这就够了]' }]])
    const msgs = await agent.messages()
    expect(msgs.find((m) => m.role === 'tool')?.meta?.display).toEqual(seen[0])
    const toolMsg = mock.requests[1]!.messages.find((m) => m.role === 'tool')!
    expect(JSON.stringify(toolMsg.content)).not.toContain('fallback')
    expect(toolMsg.content).toEqual([{ type: 'text', text: '已发送表情 enough' }])
  })
})
