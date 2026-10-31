import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBuiltinTools, createLeoFromConfig, DefaultCredentialService, loadConfig, resolveSecret, textOf } from '../src/index.js'

// —— 测试用模型供应商插件：第一步要求 write_file，第二步返回文本；记录取到的密钥 ——
const seenAuth: (string | undefined)[] = []
;(globalThis as { __leoSeenAuth?: unknown }).__leoSeenAuth = seenAuth
const SCRIPTED_PROVIDER = `export default { name: 'scripted-provider', inject: ['llm', 'credentials'], apply(ctx, cfg = {}) {
  const id = cfg.id ?? 'local'
  const provider = {
    id, name: 'Scripted', defaultModel: cfg.defaultModel ?? 'm',
    status: () => ({ ready: cfg.ready ?? true, ...(cfg.ready === false ? { reason: 'no API key' } : {}), via: 'scripted' }),
    async *stream(req) {
      globalThis.__leoSeenAuth?.push(ctx.get('credentials').get({ id }))
      const last = req.messages.at(-1)
      if (last.role === 'user') {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'write_file', argumentsDelta: '{"path":"out.txt","content":"ok"}' }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        const text = Array.isArray(last.content) ? last.content.map((b) => b.text ?? '').join('') : String(last.content)
        yield { type: 'text_delta', text: 'tool said: ' + text }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
  }
  ctx.effect(() => ctx.get('llm').registerProvider(provider, cfg.default ? { default: true } : {}))
} }`

async function project(config: unknown, creds?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'leo-proj-'))
  const home = await mkdtemp(join(tmpdir(), 'leo-home-'))
  await mkdir(join(root, '.leo', 'plugins'), { recursive: true })
  await writeFile(join(root, 'scripted.mjs'), SCRIPTED_PROVIDER)
  await writeFile(join(root, '.leo', 'config.json'), `// comment\n${JSON.stringify(config)}`)
  if (creds) await writeFile(join(root, '.leo', 'credentials.json'), JSON.stringify(creds))
  return { root, home }
}

describe('secrets', () => {
  it('resolves $ENV, ${ENV}, !command and escapes', () => {
    const env = { FOO: 'bar' }
    expect(resolveSecret('$FOO', env)).toBe('bar')
    expect(resolveSecret('${FOO}', env)).toBe('bar')
    expect(resolveSecret('$MISSING', env)).toBeUndefined()
    expect(resolveSecret('!echo hi')).toBe('hi')
    expect(resolveSecret('$$lit')).toBe('$lit')
    expect(resolveSecret('sk-plain')).toBe('sk-plain')
  })

  it('applies credential priority: override > project > user > config > env', () => {
    const svc = new DefaultCredentialService({ project: { a: 'P' }, user: { a: 'U', b: 'U' } }, { B_KEY: 'E', C_KEY: 'E' })
    expect(svc.get({ id: 'a' })).toBe('P')
    expect(svc.get({ id: 'b', envKeys: ['B_KEY'] })).toBe('U')
    expect(svc.get({ id: 'c', configured: '$C_KEY', envKeys: ['NOPE'] })).toBe('E')
    expect(new DefaultCredentialService({ overrides: { a: 'O' }, project: { a: 'P' } }).describe({ id: 'a' }).source).toBe('override')
  })
})

describe('loadConfig', () => {
  it('merges user + project config and resolves plugin paths', async () => {
    const { root, home } = await project({ model: 'x/y', plugins: ['./p.mjs'], tools: { approval: 'auto' } })
    await writeFile(join(home, 'config.json'), JSON.stringify({ model: 'u/v', agent: { maxSteps: 7 }, plugins: ['user-plugin'] }))
    const r = await loadConfig({ cwd: join(root), userDir: home, env: {} })
    expect(r.config.model).toBe('x/y')
    expect(r.config.agent.maxSteps).toBe(7)
    expect(r.config.tools.approval).toBe('auto')
    expect(r.plugins.map((p) => p.spec)).toEqual(['user-plugin', join(root, 'p.mjs')])
    expect(r.paths.projectRoot).toBe(root)
  })

  it('rejects invalid config loudly', async () => {
    const { root, home } = await project({ tools: { approval: 'sometimes' } })
    await expect(loadConfig({ cwd: root, userDir: home, env: {} })).rejects.toThrow(/Invalid leo config/)
  })
})

describe('createLeoFromConfig', () => {
  it('runs a real agent loop against a configured endpoint with builtin tools', async () => {
    const { root, home } = await project(
      { model: 'local/m', plugins: ['./scripted.mjs'], tools: { approval: 'auto' } },
      { local: 'sk-proj' },
    )
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    expect(app.model).toBe('local/m')
    const r = await app.createAgent().run('write it')
    expect(r.reason).toBe('completed')
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('ok')
    expect(r.text).toContain('Wrote 2 bytes')
    expect(seenAuth.at(-1)).toBe('sk-proj')
    expect((await stat(join(root, '.leo', 'sessions'))).isDirectory()).toBe(true)
    await app.dispose()
  })

  it('denies side-effect tools when approval=ask and nobody can approve', async () => {
    const { root, home } = await project({ model: 'local/m', plugins: ['./scripted.mjs'] })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    const r = await app.createAgent().run('write it')
    const tool = r.messages.find((m) => m.role === 'tool')!
    expect(tool.isError).toBe(true)
    expect(textOf(tool.content)).toMatch(/-y/)
    await expect(stat(join(root, 'out.txt'))).rejects.toThrow()
    await app.dispose()
  })

  it('approval policy honours permissions declared with sideEffect: true', async () => {
    const { approvalPolicy, createLeo, MockProvider } = await import('../src/index.js')
    const ran: string[] = []
    const tool = (name: string, sideEffect?: boolean) => ({
      name,
      description: name,
      parameters: { type: 'object' as const, properties: {} },
      permissions: [{ kind: 'x.custom', ...(sideEffect === undefined ? {} : { sideEffect }) }],
      execute: () => { ran.push(name); return 'ok' },
    })
    const mock = new MockProvider({ script: [{ toolCalls: [{ id: 'a', name: 'risky', arguments: {} }, { id: 'b', name: 'plain', arguments: {} }] }, { text: 'done' }] })
    const leo = await createLeo({
      logLevel: 'silent',
      providers: [mock],
      plugins: [
        { name: 't', inject: ['tools'], apply: async (ctx) => { for (const t of [tool('risky', true), tool('plain')]) await ctx.effect(() => ctx.get('tools').register(t)) } },
        [approvalPolicy, { mode: 'ask' }],
      ],
    })
    const r = await leo.createAgent({ model: 'm' }).run('go')
    expect(ran).toEqual(['plain'])
    expect(r.messages.find((m) => m.role === 'tool' && m.toolName === 'risky')?.isError).toBe(true)
    await leo.dispose()
  })

  it('has no built-in vendors: without a provider plugin there is no model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-empty-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-home-'))
    const none = await createLeoFromConfig({ cwd: root, userDir: home, env: { DEEPSEEK_API_KEY: 'sk-env' } })
    expect(none.model).toBeUndefined()
    expect(none.providers).toEqual([])
    expect(() => none.createAgent()).toThrow(/leo plugin add provider/)
    await none.dispose()
  })

  it('takes the default model from provider plugins, skipping providers that report not ready', async () => {
    const { root, home } = await project({
      plugins: [
        ['./scripted.mjs', { id: 'nokey', defaultModel: 'a', ready: false, default: true }],
        ['./scripted2.mjs', { id: 'ok', defaultModel: 'b' }],
      ],
    })
    await writeFile(join(root, 'scripted2.mjs'), SCRIPTED_PROVIDER.replace("'scripted-provider'", "'scripted-provider-2'"))
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    expect(app.model).toBe('ok/b')
    expect(app.providers.map((p) => [p.id, p.loaded, p.reason, p.default, p.via])).toEqual([
      ['nokey', false, 'no API key', true, 'scripted'],
      ['ok', true, undefined, false, 'scripted'],
    ])
    await app.dispose()
  })

  it('exposes the merged config (including 0.1.x providers) to provider plugins via leoConfig', async () => {
    const { root, home } = await project({ model: 'x/y', providers: { deepseek: { baseURL: 'https://example.invalid/v1', models: ['m'] } } })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    const cfg = app.leo.ctx.get('leoConfig')
    expect(cfg.model).toBe('x/y')
    expect(cfg.providers.deepseek).toEqual({ baseURL: 'https://example.invalid/v1', models: ['m'] })
    expect(app.model).toBe('x/y') // 显式配置的 model 原样使用
    await app.dispose()
  })

  it('loads third-party plugins that register providers into llm', async () => {
    const { root, home } = await project({ model: 'e/x', plugins: [['./.leo/plugins/echo.mjs', { prefix: '>' }]] })
    await writeFile(
      join(root, '.leo', 'plugins', 'echo.mjs'),
      `export default { name: 'echo', inject: ['llm'], async apply(ctx, cfg) {
        await ctx.effect(() => ctx.get('llm').registerProvider({ id: 'e', async *stream(req) {
          yield { type: 'text_delta', text: cfg.prefix + req.messages.at(-1).content[0].text }
          yield { type: 'done', finishReason: 'stop' }
        } }))
      } }`,
    )
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    expect((await app.createAgent({ tools: false }).run('hi')).text).toBe('>hi')
    expect(app.resolved.plugins).toHaveLength(1) // 显式声明与目录发现去重
    await app.dispose()
  })

  it('provides agentFactory so plugins create agents with the host defaults', async () => {
    const { root, home } = await project({ agent: { systemPrompt: 'HOST PROMPT', maxSteps: 7 }, plugins: ['./.leo/plugins/bot.mjs'] })
    await writeFile(
      join(root, '.leo', 'plugins', 'bot.mjs'),
      `export default { name: 'bot', inject: ['llm'], async apply(ctx) {
        await ctx.effect(() => ctx.get('llm').registerProvider({ id: 'e', defaultModel: 'x', async *stream(req) {
          yield { type: 'text_delta', text: 'echo:' + req.messages.at(-1).content[0].text }
          yield { type: 'done', finishReason: 'stop' }
        } }))
        ctx.provide('botProbe', { run: (text) => ctx.get('agentFactory').create({ tools: false, label: 'bot' }).run(text), factory: () => ctx.get('agentFactory') })
      } }`,
    )
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    const probe = app.leo.ctx.get('botProbe' as never) as { run(t: string): Promise<{ text: string }>; factory(): { defaultModel?: string; systemPrompt(): string; create(o: object): { options: { model: string; systemPrompt?: string; limits?: { maxSteps?: number }; label?: string } } } }
    const f = probe.factory()
    expect(f.defaultModel).toBe('e/x')
    expect(f.systemPrompt()).toContain('HOST PROMPT')
    const agent = f.create({ label: 'x', limits: { turnTimeoutMs: 5 } })
    expect(agent.options.model).toBe('e/x')
    expect(agent.options.systemPrompt).toContain('HOST PROMPT')
    expect(agent.options.limits).toMatchObject({ maxSteps: 7, turnTimeoutMs: 5 })
    expect((await probe.run('hi')).text).toBe('echo:hi')
    await app.dispose()
  })

  it('delivers plugin notices emitted during startup to onNotice', async () => {
    const { root, home } = await project({ plugins: ['./.leo/plugins/srv.mjs'] })
    await writeFile(join(root, '.leo', 'plugins', 'srv.mjs'), `export default { name: 'srv', apply(ctx) { ctx.emit('plugin/notice', { plugin: 'srv', message: 'listening on http://127.0.0.1:1' }) } }`)
    const notices: unknown[] = []
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, onNotice: (n) => notices.push(n) })
    expect(notices).toEqual([{ plugin: 'srv', message: 'listening on http://127.0.0.1:1' }])
    app.leo.ctx.emit('plugin/notice', { plugin: 'srv', message: 'later', level: 'warn' })
    expect(notices).toHaveLength(2)
    await app.dispose()
  })
})

describe('builtin tools', () => {
  it('confines paths, edits uniquely and runs commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-ws-'))
    const tools = Object.fromEntries(createBuiltinTools({ workspace: root }).map((t) => [t.name, t]))
    const exec = { signal: new AbortController().signal, onUpdate() {} } as never
    await tools.write_file!.execute({ path: 'a.txt', content: 'x x' }, exec)
    const dup = await tools.edit_file!.execute({ path: 'a.txt', old_string: 'x', new_string: 'y' }, exec)
    expect(dup.isError).toBe(true)
    await tools.edit_file!.execute({ path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, exec)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('y y')
    await expect(tools.read_file!.execute({ path: '/etc/hostname' }, exec)).rejects.toThrow(/outside the workspace/)
    const r = await tools.bash!.execute({ command: 'echo hi && exit 3' }, exec)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/hi[\s\S]*exit code 3/)
  })
})
