import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBuiltinTools, createLeoFromConfig, DefaultCredentialService, loadConfig, resolveSecret, textOf } from '../src/index.js'

// —— 一个最小的 OpenAI 兼容假服务：第一步要求 write_file，第二步返回文本 ——
let server: Server
let baseURL = ''
const seenAuth: (string | undefined)[] = []
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seenAuth.push(req.headers.authorization)
      const j = JSON.parse(body) as { messages: { role: string; content: unknown }[] }
      const last = j.messages.at(-1)!
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      if (last.role === 'user') {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"out.txt","content":"ok"}' } }] }, finish_reason: 'tool_calls' }] })
      } else {
        send({ choices: [{ delta: { content: `tool said: ${String(last.content)}` }, finish_reason: 'stop' }] })
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

async function project(config: unknown, creds?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'leo-proj-'))
  const home = await mkdtemp(join(tmpdir(), 'leo-home-'))
  await mkdir(join(root, '.leo'), { recursive: true })
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
      { model: 'local/m', providers: { local: { baseURL, models: ['m'] } }, tools: { approval: 'auto' } },
      { local: 'sk-proj' },
    )
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    expect(app.model).toBe('local/m')
    const r = await app.createAgent().run('write it')
    expect(r.reason).toBe('completed')
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('ok')
    expect(r.text).toContain('Wrote 2 bytes')
    expect(seenAuth.at(-1)).toBe('Bearer sk-proj')
    expect((await stat(join(root, '.leo', 'sessions'))).isDirectory()).toBe(true)
    await app.dispose()
  })

  it('denies side-effect tools when approval=ask and nobody can approve', async () => {
    const { root, home } = await project({ model: 'local/m', providers: { local: { baseURL, models: ['m'] } } })
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

  it('auto-detects built-in providers from env and reports missing keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-empty-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-home-'))
    const none = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    expect(none.model).toBeUndefined()
    expect(() => none.createAgent()).toThrow(/leo auth set/)
    await none.dispose()
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: { DEEPSEEK_API_KEY: 'sk-env' } })
    expect(app.model).toBe('deepseek/deepseek-chat')
    expect(app.providers.find((p) => p.id === 'deepseek')?.credential.source).toBe('env')
    await app.dispose()
  })

  it('loads third-party plugins that register new provider kinds', async () => {
    const { root, home } = await project({ model: 'e/x', providers: { e: { type: 'echo' } }, plugins: [['./.leo/plugins/echo.mjs', { prefix: '>' }]] })
    await mkdir(join(root, '.leo', 'plugins'), { recursive: true })
    await writeFile(
      join(root, '.leo', 'plugins', 'echo.mjs'),
      `export default { name: 'echo', inject: ['providerKinds'], async apply(ctx, cfg) {
        await ctx.effect(() => ctx.get('providerKinds').register('echo', ({ id }) => ({ id, async *stream(req) {
          yield { type: 'text_delta', text: cfg.prefix + req.messages.at(-1).content[0].text }
          yield { type: 'done', finishReason: 'stop' }
        } })))
      } }`,
    )
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    expect((await app.createAgent({ tools: false }).run('hi')).text).toBe('>hi')
    expect(app.resolved.plugins).toHaveLength(1) // 显式声明与目录发现去重
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
