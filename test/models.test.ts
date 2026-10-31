import { describe, expect, it } from 'vitest'
import { createLeo, type LlmProvider, MockProvider, type ModelInfo, providerPlugin } from '../src/index.js'
import { describeModel, describeReasoning, parseEffort, parseSwitch, withEffort, withThinking } from '../src/cli/models.js'
import { setup } from './helpers.js'

const flash: ModelInfo = {
  id: 'deepseek-flash',
  name: 'DeepSeek-V4.1-Flash',
  contextWindow: 1_048_576,
  maxOutputTokens: 393_216,
  inputModalities: ['text', 'image'],
  reasoning: { supported: true, canDisable: true, defaultEnabled: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
}

describe('llm.models', () => {
  it('refreshes from providers, hides aliases, falls back on failure', async () => {
    const remote: LlmProvider = {
      id: 'r',
      stream: async function* () {},
      listModels: () => [{ id: 'old', contextWindow: 1 }],
      refreshModels: async () => [flash, { ...flash, id: 'deepseek-chat', alias: true }],
    }
    const broken: LlmProvider = {
      id: 'b',
      stream: async function* () {},
      listModels: () => [{ id: 'builtin', contextWindow: 2, source: 'builtin' }],
      refreshModels: async () => {
        throw new Error('401 unauthorized')
      },
    }
    const leo = await createLeo({ logLevel: 'silent', providers: [remote, broken] })
    const llm = leo.ctx.get('llm')
    const groups = await llm.models({ refresh: true })
    expect(groups.map((g) => [g.provider.id, g.models.map((m) => m.id), g.error])).toEqual([
      ['r', ['deepseek-flash'], undefined],
      ['b', ['builtin'], '401 unauthorized'],
    ])
    // 不 refresh 时只用 listModels
    expect((await llm.models({ provider: 'r' }))[0]!.models.map((m) => m.id)).toEqual(['old'])
    await expect(llm.models({ provider: 'nope' })).rejects.toThrow(/Unknown LLM provider/)
    await leo.dispose()
  })
})

describe('reasoning options', () => {
  it('agent passes reasoning to the provider request', async () => {
    const { leo, mock } = await setup([{ text: 'ok' }, { text: 'ok' }])
    const a = leo.createAgent({ model: 'm', reasoning: { enabled: true, effort: 'max' } })
    for await (const _ of a.prompt('hi'));
    expect(mock.requests[0]!.reasoning).toEqual({ enabled: true, effort: 'max' })
    const b = leo.createAgent({ model: 'm' })
    for await (const _ of b.prompt('hi'));
    expect(mock.requests[1]!.reasoning).toBeUndefined()
    await leo.dispose()
  })

  it('cli helpers', () => {
    expect(parseSwitch('on')).toBe(true)
    expect(parseSwitch('关')).toBe(false)
    expect(parseSwitch('maybe')).toBeUndefined()
    expect(parseEffort('MAX')).toBe('max')
    expect(parseEffort('ultra')).toBeUndefined()
    expect(withEffort('none')).toEqual({ enabled: false })
    expect(withEffort('low')).toEqual({ enabled: true, effort: 'low' })
    expect(withThinking({ effort: 'max' }, false)).toEqual({ enabled: false })
    expect(withThinking({ effort: 'none' }, true)).toEqual({ enabled: true })
    expect(describeModel(flash)).toBe('DeepSeek-V4.1-Flash · 上下文 1M · 最大输出 384K · 输入 text+image · 思考（默认开），强度 low/high*/max')
    expect(describeReasoning(undefined, flash)).toBe('思考开（默认） · 强度 high（默认）')
    expect(describeReasoning({ enabled: false }, flash)).toBe('思考关')
    expect(describeReasoning({ enabled: true, effort: 'max' }, flash)).toBe('思考开 · 强度 max')
    expect(describeReasoning(undefined, { id: 'x', contextWindow: 1, reasoning: { supported: false } })).toBe('不支持思考')
  })

  it('config agent.reasoning becomes the agent default and can be overridden', async () => {
    const { createLeoFromConfig } = await import('../src/index.js')
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'leo-r-'))
    await mkdir(join(dir, '.leo'))
    await writeFile(join(dir, '.leo', 'config.json'), JSON.stringify({ model: 'mock/m', agent: { reasoning: { effort: 'low' } }, sessions: { persist: false } }))
    const mock = new MockProvider({ script: [{ text: 'a' }, { text: 'b' }] })
    const app = await createLeoFromConfig({ cwd: dir, env: {}, userDir: join(dir, 'home'), plugins: [providerPlugin(mock)], watchPlugins: false })
    for await (const _ of app.createAgent().prompt('x'));
    for await (const _ of app.createAgent({ reasoning: { enabled: false } }).prompt('y'));
    expect(mock.requests.map((r) => r.reasoning)).toEqual([{ effort: 'low' }, { effort: 'low', enabled: false }])
    await app.dispose()
  })
})
