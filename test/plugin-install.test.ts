import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { addPlugin, initPlugin, type PluginIo, removePlugin, uninstallPlugin } from '../src/cli/plugin.js'
import { parseArgs } from '../src/cli/args.js'
import { addPluginEntry, listPluginEntries, removePluginEntry } from '../src/config/jsonc.js'
import { createLeoFromConfig, resolvePluginPackage } from '../src/index.js'
import { setup } from './helpers.js'

const tmp = () => mkdtemp(join(tmpdir(), 'leo-plugin-'))

const PLUGIN_SRC = `export default { name: 'hello-plugin', apply(ctx) { ctx.provide('hello', { paths: ctx.maybe('leoPaths') }) } }\n`

describe('JSONC plugins 编辑', () => {
  const tpl = `{
  // 注释保留
  "model": "x/y",
  "plugins": [],
  "tools": { "approval": "ask" }
}
`
  it('追加、去重、删除，保留注释', () => {
    let t = addPluginEntry(tpl, 'a')
    t = addPluginEntry(t, 'b', { n: 1 })
    t = addPluginEntry(t, 'a')
    expect(listPluginEntries(t)).toEqual(['a', 'b'])
    expect(t).toContain('// 注释保留')
    expect(JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')).plugins).toEqual(['a', ['b', { n: 1 }]])
    t = removePluginEntry(t, 'a')
    expect(JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')).plugins).toEqual([['b', { n: 1 }]])
    t = removePluginEntry(t, 'b')
    expect(JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')).plugins).toEqual([])
  })

  it('没有 plugins 键或空文件时创建', () => {
    expect(JSON.parse(addPluginEntry('{ "model": "m" }', 'p'))).toEqual({ plugins: ['p'], model: 'm' })
    expect(JSON.parse(addPluginEntry('{}', 'p'))).toEqual({ plugins: ['p'] })
    expect(JSON.parse(addPluginEntry('', 'p'))).toEqual({ plugins: ['p'] })
  })

  it('字符串里的括号和注释符号不干扰解析', () => {
    const t = `{ "a": "x ] // [", "plugins": ["q" /* c */, ["r", { "s": "]" }]] }`
    expect(listPluginEntries(t)).toEqual(['q', 'r'])
    expect(JSON.parse(removePluginEntry(t, 'q').replace(/\/\*.*?\*\//g, '')).plugins).toEqual([['r', { s: ']' }]])
  })
})

describe('工具筛选在执行时强制生效', () => {
  it('模型调用未暴露的工具会被拒绝', async () => {
    let ran = false
    const { leo } = await setup([{ toolCalls: [{ name: 'hidden', arguments: {} }] }, { text: 'ok' }])
    leo.ctx.get('tools').register({ name: 'shown', description: '', parameters: z.object({}), execute: () => 'x' })
    leo.ctx.get('tools').register({
      name: 'hidden',
      description: '',
      parameters: z.object({}),
      execute: () => {
        ran = true
        return 'secret'
      },
    })
    const r = await leo.createAgent({ model: 'm', tools: { names: ['shown'] } }).run('hi')
    expect(ran).toBe(false)
    const tool = r.messages.find((m) => m.role === 'tool')!
    expect(tool.isError).toBe(true)
    expect(JSON.stringify(tool.content)).toContain('not available to this agent')
    await leo.dispose()
  })

  it('tools: false 时任何调用都被拒绝', async () => {
    const { leo } = await setup([{ toolCalls: [{ name: 'x', arguments: {} }] }, { text: 'ok' }])
    leo.ctx.get('tools').register({ name: 'x', description: '', parameters: z.object({}), execute: () => 'x' })
    const r = await leo.createAgent({ model: 'm', tools: false }).run('hi')
    expect(r.messages.find((m) => m.role === 'tool')!.isError).toBe(true)
    await leo.dispose()
  })
})

describe('插件解析', () => {
  it('解析 .leo/node_modules 里的纯 ESM 包（exports 只有 import 条件）', async () => {
    const root = await tmp()
    const pkg = join(root, '.leo', 'node_modules', 'leo-plugin-hello')
    await mkdir(join(pkg, 'dist'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'leo-plugin-hello', type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }))
    await writeFile(join(pkg, 'dist', 'index.js'), PLUGIN_SRC)
    await writeFile(join(root, '.leo', 'config.json'), JSON.stringify({ plugins: ['leo-plugin-hello'], tools: { builtin: false } }))

    expect(resolvePluginPackage('leo-plugin-hello', [join(root, '.leo')])).toBe(join(pkg, 'dist', 'index.js'))
    const app = await createLeoFromConfig({ cwd: root, userDir: join(root, 'home'), env: {} })
    const hello = (app.leo.ctx as never as { get(k: string): { paths: { projectRoot: string } } }).get('hello')
    // leoPaths 服务在用户插件之前提供
    expect(hello.paths.projectRoot).toBe(root)
    await app.dispose()
  })

  it('用户级 ~/.leo/node_modules 的包也能解析', async () => {
    const root = await tmp()
    const home = join(root, 'home')
    const pkg = join(home, 'node_modules', 'leo-plugin-hello')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'leo-plugin-hello', type: 'module', main: 'index.js' }))
    await writeFile(join(pkg, 'index.js'), PLUGIN_SRC)
    await writeFile(join(home, 'config.json'), JSON.stringify({ plugins: ['leo-plugin-hello'], tools: { builtin: false } }))
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {} })
    expect(app.leo.ctx.has('hello' as never)).toBe(true)
    await app.dispose()
  })
})

describe('leo plugin add / remove', () => {
  async function fixture(opts: { sha?: string; status?: string; init?: unknown; purge?: unknown } = {}) {
    const root = await tmp()
    const bundle = Buffer.from(PLUGIN_SRC)
    const sha = createHash('sha256').update(bundle).digest('hex')
    await mkdir(join(root, 'reg'), { recursive: true })
    await writeFile(join(root, 'reg', 'hello.bundle.js'), bundle)
    await writeFile(
      join(root, 'reg', 'registry.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          { id: 'hello', package: 'leo-plugin-hello', version: '1.0.0', status: opts.status ?? 'experimental', description: 'd', leo: '>=0.1.0', bundle: { url: 'hello.bundle.js', sha256: opts.sha ?? sha }, ...(opts.init ? { init: opts.init } : {}), ...(opts.purge ? { purge: opts.purge } : {}) },
          { id: 'future', package: 'leo-plugin-future', version: '0.0.0', status: 'planned', description: 'd' },
        ],
      }),
    )
    const logs: string[] = []
    const npmCalls: string[][] = []
    const io: PluginIo = {
      fetchBytes: (l) => readFile(l),
      npm: async (args) => {
        npmCalls.push(args)
        return 0
      },
      log: (s) => void logs.push(s),
    }
    return { root, registry: join(root, 'reg', 'registry.json'), io, logs, npmCalls }
  }

  it('默认下载 bundle 到 .leo/plugins/ 并被自动加载，可移除', async () => {
    const f = await fixture()
    const scopeDir = join(f.root, '.leo')
    await addPlugin({ name: 'hello', scopeDir, projectRoot: f.root, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    expect(await readFile(join(scopeDir, 'plugins', 'hello.bundle.js'), 'utf8')).toBe(PLUGIN_SRC)

    const app = await createLeoFromConfig({ cwd: f.root, userDir: join(f.root, 'home'), env: {}, overrides: { tools: { builtin: false } } })
    expect(app.leo.ctx.has('hello' as never)).toBe(true)
    await app.dispose()

    expect(await removePlugin({ name: 'hello', scopeDir, registry: f.registry }, f.io)).toBe(true)
    const again = await createLeoFromConfig({ cwd: f.root, userDir: join(f.root, 'home'), env: {}, overrides: { tools: { builtin: false } } })
    expect(again.leo.ctx.has('hello' as never)).toBe(false)
    await again.dispose()
  })

  it('sha256 不符时拒绝安装', async () => {
    const f = await fixture({ sha: 'deadbeef' })
    const scopeDir = join(f.root, '.leo')
    await expect(addPlugin({ name: 'hello', scopeDir, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)).rejects.toThrow(/校验失败/)
    await expect(readFile(join(scopeDir, 'plugins', 'hello.bundle.js'))).rejects.toThrow()
  })

  it('规划中的插件、未知插件、版本不兼容都会报错', async () => {
    const f = await fixture()
    const base = { scopeDir: join(f.root, '.leo'), npm: false, registry: f.registry }
    await expect(addPlugin({ ...base, name: 'future', leoVersion: '0.1.0' }, f.io)).rejects.toThrow(/规划中/)
    await expect(addPlugin({ ...base, name: 'nope', leoVersion: '0.1.0' }, f.io)).rejects.toThrow(/可安装：hello/)
    await expect(addPlugin({ ...base, name: 'hello', leoVersion: '0.0.9' }, f.io)).rejects.toThrow(/需要 leo-agents >=0.1.0/)
  })

  it('--npm 安装到 scope 目录并写入配置，移除时反向操作', async () => {
    const f = await fixture()
    const scopeDir = join(f.root, '.leo')
    await mkdir(scopeDir, { recursive: true })
    await writeFile(join(scopeDir, 'config.json'), '{\n  // keep\n  "plugins": []\n}\n')
    await addPlugin({ name: 'hello', scopeDir, projectRoot: f.root, npm: true, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    expect(f.npmCalls[0]).toEqual(['install', '--prefix', scopeDir, '--no-audit', '--no-fund', 'leo-plugin-hello@1.0.0'])
    const cfg = await readFile(join(scopeDir, 'config.json'), 'utf8')
    expect(cfg).toContain('// keep')
    expect(listPluginEntries(cfg)).toEqual(['leo-plugin-hello'])
    expect(await readFile(join(f.root, '.gitignore'), 'utf8')).toContain('.leo/node_modules/')

    // 模拟 npm 装好的包
    await mkdir(join(scopeDir, 'node_modules', 'leo-plugin-hello'), { recursive: true })
    await writeFile(join(scopeDir, 'node_modules', 'leo-plugin-hello', 'package.json'), '{}')
    await removePlugin({ name: 'hello', scopeDir, registry: f.registry }, f.io)
    expect(listPluginEntries(await readFile(join(scopeDir, 'config.json'), 'utf8'))).toEqual([])
    expect(f.npmCalls[1]?.[0]).toBe('uninstall')
  })

  it('--npm 可安装仓库外的任意包', async () => {
    const f = await fixture()
    const scopeDir = join(f.root, '.leo')
    await addPlugin({ name: '@acme/leo-tools', scopeDir, npm: true, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    expect(f.npmCalls[0]?.at(-1)).toBe('@acme/leo-tools')
    expect(listPluginEntries(await readFile(join(scopeDir, 'config.json'), 'utf8'))).toEqual(['@acme/leo-tools'])
  })

  it('全局与项目各装一份时只加载一次，项目的那份生效', async () => {
    const f = await fixture()
    const home = join(f.root, 'home')
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    await addPlugin({ name: 'hello', scopeDir: join(f.root, '.leo'), projectRoot: f.root, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    // 全局配置里给全局那份写了选项：项目那份生效时沿用
    await writeFile(join(home, 'config.json'), JSON.stringify({ plugins: [['./plugins/hello.bundle.js', { n: 1 }]] }))
    const { loadConfig } = await import('../src/config/load.js')
    const r = await loadConfig({ cwd: f.root, userDir: home, env: {} })
    const hellos = r.plugins.filter((p) => p.spec.endsWith('hello.bundle.js'))
    expect(hellos).toHaveLength(1)
    expect(hellos[0]!.spec).toBe(join(f.root, '.leo', 'plugins', 'hello.bundle.js'))
    expect(hellos[0]!.config).toEqual({ n: 1 })
    const app = await createLeoFromConfig({ cwd: f.root, userDir: home, env: {}, overrides: { tools: { builtin: false } } })
    expect(app.leo.ctx.has('hello' as never)).toBe(true)
    await app.dispose()
  })

  it('只装在全局时，任何项目里都会加载', async () => {
    const f = await fixture()
    const home = join(f.root, 'home')
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    const other = join(f.root, 'other-project')
    await mkdir(join(other, '.leo'), { recursive: true })
    const app = await createLeoFromConfig({ cwd: other, userDir: home, env: {}, overrides: { tools: { builtin: false } } })
    expect(app.leo.ctx.has('hello' as never)).toBe(true)
    await app.dispose()
  })

  it('安装时自动用插件自带模板初始化配置文件（url 校验 sha256、内联内容、子目录），已存在的不覆盖', async () => {
    const tpl = '{\n  "mcpServers": {}\n}\n'
    const f0 = await fixture()
    await writeFile(join(f0.root, 'reg', 'servers.json'), tpl)
    const sha = createHash('sha256').update(tpl).digest('hex')
    const f = await fixture({
      init: {
        files: [
          { path: 'hello-servers.json', url: 'servers.json', sha256: sha, description: '服务器列表' },
          { path: 'agents/reviewer.md', content: '# reviewer\n' },
        ],
      },
    })
    await writeFile(join(f.root, 'reg', 'servers.json'), tpl)
    const home = join(f.root, 'home')
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    expect(await readFile(join(home, 'hello-servers.json'), 'utf8')).toBe(tpl)
    expect(await readFile(join(home, 'agents', 'reviewer.md'), 'utf8')).toBe('# reviewer\n')

    await writeFile(join(home, 'hello-servers.json'), '{"mine":true}')
    await initPlugin({ name: 'hello', scopeDir: home, registry: f.registry, from: true, force: false }, f.io)
    expect(await readFile(join(home, 'hello-servers.json'), 'utf8')).toBe('{"mine":true}')
    expect(f.logs.some((l) => l.includes('已存在，保留'))).toBe(true)
    await initPlugin({ name: 'hello', scopeDir: home, registry: f.registry, from: true, force: true }, f.io)
    expect(await readFile(join(home, 'hello-servers.json'), 'utf8')).toBe(tpl)
  })

  it('--no-init 不初始化；插件没有模板时静默跳过', async () => {
    const f = await fixture({ init: { files: [{ path: 'x.json', content: '{}' }] } })
    const home = join(f.root, 'home')
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0', init: false }, f.io)
    await expect(readFile(join(home, 'x.json'))).rejects.toThrow()
    const g = await fixture()
    await addPlugin({ name: 'hello', scopeDir: join(g.root, 'home'), npm: false, registry: g.registry, leoVersion: '0.1.0' }, g.io)
    expect(g.logs.some((l) => l.includes('没有需要初始化'))).toBe(false)
  })

  it('模板 sha256 不符、路径越界时拒绝', async () => {
    const f = await fixture({ init: { files: [{ path: 'x.json', content: '{}', sha256: 'bad' }] } })
    await expect(initPlugin({ name: 'hello', scopeDir: join(f.root, 'home'), registry: f.registry, from: true, force: false }, f.io)).rejects.toThrow(/校验失败/)
    const g = await fixture({ init: { files: [{ path: '../escape.json', content: '{}' }] } })
    await expect(initPlugin({ name: 'hello', scopeDir: join(g.root, 'home'), registry: g.registry, from: true, force: false }, g.io)).rejects.toThrow(/不合法/)
  })

  it('--init-from 使用用户提供的模板目录或单个文件', async () => {
    const f = await fixture({ init: { files: [{ path: 'hello-servers.json', content: '{}' }] } })
    const mine = join(f.root, 'my-templates')
    await mkdir(join(mine, 'agents'), { recursive: true })
    await writeFile(join(mine, 'hello-servers.json'), '{"a":1}')
    await writeFile(join(mine, 'agents', 'a.md'), 'A')
    const proj = join(f.root, '.leo')
    await addPlugin({ name: 'hello', scopeDir: proj, projectRoot: f.root, npm: false, registry: f.registry, leoVersion: '0.1.0', init: mine }, f.io)
    expect(await readFile(join(proj, 'hello-servers.json'), 'utf8')).toBe('{"a":1}')
    expect(await readFile(join(proj, 'agents', 'a.md'), 'utf8')).toBe('A')

    // 单个文件：放到插件声明的唯一配置文件位置
    await writeFile(join(f.root, 'custom.jsonc'), '{"b":2}')
    await initPlugin({ name: 'hello', scopeDir: join(f.root, 'home'), registry: f.registry, from: join(f.root, 'custom.jsonc'), force: false }, f.io)
    expect(await readFile(join(f.root, 'home', 'hello-servers.json'), 'utf8')).toBe('{"b":2}')
  })
  it('卸载：默认全局；--project 只卸项目；--all 两处；另一处还装着时提示', async () => {
    const f = await fixture()
    const home = join(f.root, 'home')
    const proj = join(f.root, 'proj', '.leo')
    const both = async () => {
      await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
      await addPlugin({ name: 'hello', scopeDir: proj, projectRoot: join(f.root, 'proj'), npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    }
    const g = join(home, 'plugins', 'hello.bundle.js')
    const p = join(proj, 'plugins', 'hello.bundle.js')
    const base = { name: 'hello', registry: f.registry, userDir: home, projectDir: proj }

    await both()
    f.logs.length = 0
    expect(await uninstallPlugin({ ...base, scope: 'global' }, f.io)).toBe(true)
    expect(existsSync(g)).toBe(false)
    expect(existsSync(p)).toBe(true)
    expect(f.logs.some((l) => l.includes('项目级安装'))).toBe(true)

    await both()
    f.logs.length = 0
    expect(await uninstallPlugin({ ...base, scope: 'project' }, f.io)).toBe(true)
    expect(existsSync(g)).toBe(true)
    expect(existsSync(p)).toBe(false)
    expect(f.logs.some((l) => l.includes('改用全局'))).toBe(true)

    await both()
    expect(await uninstallPlugin({ ...base, scope: 'all' }, f.io)).toBe(true)
    expect(existsSync(g) || existsSync(p)).toBe(false)
    expect(await uninstallPlugin({ ...base, scope: 'all' }, f.io)).toBe(false)
    expect(await uninstallPlugin({ name: 'hello', registry: f.registry, userDir: home, scope: 'project' }, f.io)).toBe(false)
  })

  it('卸载默认保留配置文件，--purge 一起删除', async () => {
    const f = await fixture({ init: { files: [{ path: 'hello.json', content: '{}' }] } })
    const home = join(f.root, 'home')
    const base = { name: 'hello', registry: f.registry, userDir: home, scope: 'global' as const }
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    await uninstallPlugin(base, f.io)
    expect(existsSync(join(home, 'hello.json'))).toBe(true)
    expect(f.logs.some((l) => l.includes('--purge'))).toBe(true)
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    await uninstallPlugin({ ...base, purge: true }, f.io)
    expect(existsSync(join(home, 'hello.json'))).toBe(false)
  })

  it('--purge 按 purge.credentials 清理 credentials.json 里的键（/ 结尾为前缀），其他键保留', async () => {
    const f = await fixture({ purge: { credentials: ['gateway/qq/', 'hello/token'] } })
    const home = join(f.root, 'home')
    const creds = join(home, 'credentials.json')
    const base = { name: 'hello', registry: f.registry, userDir: home, scope: 'global' as const }
    const seed = { openai: 'sk-1', 'gateway/qq/appId': '1', 'gateway/qq/appSecret': 's', 'gateway/qq2/appId': '2', 'hello/token': 't', 'hello/tokenx': 'x' }
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    await writeFile(creds, JSON.stringify(seed))
    await uninstallPlugin(base, f.io)
    expect(JSON.parse(await readFile(creds, 'utf8'))).toEqual(seed)
    await addPlugin({ name: 'hello', scopeDir: home, npm: false, registry: f.registry, leoVersion: '0.1.0' }, f.io)
    await uninstallPlugin({ ...base, purge: true }, f.io)
    expect(JSON.parse(await readFile(creds, 'utf8'))).toEqual({ openai: 'sk-1', 'gateway/qq2/appId': '2', 'hello/tokenx': 'x' })
    expect(f.logs.some((l) => l.includes('删除凭据') && l.includes('gateway/qq/appId'))).toBe(true)
  })

})

describe('leo plugin 参数', () => {
  it('默认全局；--project / --local / -l 指向项目；默认初始化，--no-init 关闭', () => {
    expect(parseArgs(['plugin', 'add', 'mcp']).project).toBe(false)
    for (const flag of ['--project', '--local', '-l']) expect(parseArgs(['plugin', 'add', 'mcp', flag]).project).toBe(true)
    const a = parseArgs(['plugin', 'add', 'mcp', '--init-from', './t', '--force'])
    expect(a).toMatchObject({ noInit: false, initFrom: './t', force: true, positionals: ['add', 'mcp'] })
    expect(parseArgs(['plugin', 'add', 'mcp', '--no-init']).noInit).toBe(true)
    expect(parseArgs(['plugin', 'add', 'mcp', '--init']).noInit).toBe(false)
    expect(parseArgs(['plugin', 'add', 'mcp', '-g']).global).toBe(true)
  })

  it('remove 参数：--all / --purge', () => {
    const a = parseArgs(['plugin', 'remove', 'mcp', '--all', '--purge'])
    expect(a).toMatchObject({ all: true, purge: true, project: false })
    expect(parseArgs(['plugin', 'rm', 'mcp', '-l']).project).toBe(true)
  })
})
