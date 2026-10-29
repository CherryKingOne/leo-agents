import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineTool, parsePromptFile, renderTemplate, z } from '../src/index.js'
import { setup } from './helpers.js'

const now = () => new Date('2026-10-30T02:00:00Z')

describe('prompts', () => {
  it('parses frontmatter and renders vars / conditional blocks', () => {
    const t = parsePromptFile('---\nid: a.b\nlayer: tenant\npriority: 5 # comment\nwhen: tools\n---\nHi {{name}}{{#org}} of {{org}}{{/org}}!')
    expect(t).toMatchObject({ id: 'a.b', layer: 'tenant', priority: 5, when: 'tools' })
    expect(renderTemplate(t!.body, { name: 'Leo' })).toBe('Hi Leo!')
    expect(renderTemplate(t!.body, { name: 'Leo', org: 'Acme' })).toBe('Hi Leo of Acme!')
    expect(parsePromptFile('# no frontmatter')).toBeUndefined()
  })

  it('loads default persona prompts in layer order, tool-use only with tools', async () => {
    const { leo, mock } = await setup([{ text: 'a' }, { text: 'b' }], {
      prompts: { vars: { organization: 'Acme' }, timezone: 'Asia/Shanghai', now },
    })
    await leo.createAgent({ model: 'm', systemPrompt: 'AGENT ROLE', state: { assistantName: '小智' } }).run('x')
    const sys = mock.requests[0]!.system!
    expect(sys.startsWith('你是 小智，一个由 Acme 提供的 AI 助手。')).toBe(true)
    expect(sys).toContain('# 安全底线')
    expect(sys).not.toContain('# 工具使用')
    expect(sys).not.toMatch(/\{\{/)
    expect(sys.indexOf('# 输出')).toBeLessThan(sys.indexOf('AGENT ROLE'))
    expect(sys.indexOf('AGENT ROLE')).toBeLessThan(sys.indexOf('当前日期：2026-10-30（时区 Asia/Shanghai）'))

    leo.ctx.get('tools').register(defineTool({ name: 't', description: 't', parameters: z.object({}), execute: () => 'ok' }))
    await leo.createAgent({ model: 'm' }).run('y')
    expect(mock.requests[1]!.system).toContain('# 工具使用')
  })

  it('supports dir overrides, inline overrides and disabling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leo-prompts-'))
    await writeFile(join(dir, 'identity.md'), '---\nid: platform.identity\nlayer: platform\npriority: 10\n---\nI am {{assistantName}}.')
    await writeFile(join(dir, 'extra.md'), '---\nid: tenant.rules\nlayer: tenant\n---\nTENANT {{tenantId}}')
    const { leo, mock } = await setup([{ text: 'a' }], {
      prompts: {
        dir,
        vars: { assistantName: 'Bot' },
        overrides: { 'platform.behavior': false, 'platform.tool-use': false, 'platform.output': false, 'runtime.environment': false, 'platform.safety': 'SAFE' },
      },
    })
    await leo.createAgent({ model: 'm', tenant: { tenantId: 'acme' } }).run('x')
    expect(mock.requests[0]!.system).toBe('I am Bot.\n\nSAFE\n\nTENANT acme')
  })
})
