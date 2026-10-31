import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLeoFromConfig } from '../src/index.js'

const tmp = () => mkdtemp(join(tmpdir(), 'leo-hot-'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 一个注册服务和工具的插件；value 用来区分版本 */
const pluginSrc = (value: string, name = 'hot') => `import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
export default {
  name: '${name}',
  watch: ['hot-data.json'],
  async apply(ctx) {
    const paths = ctx.maybe('leoPaths')
    const f = paths && join(paths.userDir, 'hot-data.json')
    const data = f && existsSync(f) ? readFileSync(f, 'utf8') : ''
    ctx.provide('${name}', { value: '${value}', data })
    await ctx.effect(() => ctx.get('tools').register({ name: '${name}_tool', description: 'd', parameters: { safeParse: (v) => ({ success: true, data: v }), parse: (v) => v, _def: {} }, execute: () => '${value}' }))
  },
}
`

async function fixture() {
  const root = await tmp()
  const home = join(root, 'home')
  const proj = join(root, 'proj')
  await mkdir(join(home, 'plugins'), { recursive: true })
  await mkdir(join(proj, '.leo'), { recursive: true })
  const app = await createLeoFromConfig({ cwd: proj, userDir: home, env: {}, overrides: { tools: { builtin: false } }, pluginPollMs: 0 })
  const events: string[] = []
  app.leo.ctx.on('plugin/loaded', (e) => void events.push(`loaded:${e.name}:${e.reason}`))
  app.leo.ctx.on('plugin/unloaded', (e) => void events.push(`unloaded:${e.name}:${e.reason}`))
  app.leo.ctx.on('plugin/failed', () => void events.push('failed'))
  const svc = (k = 'hot') => (app.leo.ctx.has(k as never) ? (app.leo.ctx.get(k as never) as { value: string; data: string }) : undefined)
  const toolNames = () => app.leo.ctx.get('tools').list().map((t) => t.name)
  return { root, home, proj, app, events, svc, toolNames }
}

describe('插件热加载', () => {
  it('运行中安装、更新、移除插件，不需要重启', async () => {
    const f = await fixture()
    expect(f.svc()).toBeUndefined()

    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), pluginSrc('v1'))
    let r = await f.app.reloadPlugins()
    expect(r.added).toHaveLength(1)
    expect(f.svc()?.value).toBe('v1')
    expect(f.toolNames()).toContain('hot_tool')

    await sleep(20) // 保证 mtime 变化
    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), pluginSrc('v2-updated'))
    r = await f.app.reloadPlugins()
    expect(r.changed).toHaveLength(1)
    expect(f.svc()?.value).toBe('v2-updated')
    expect(f.toolNames().filter((n) => n === 'hot_tool')).toHaveLength(1)

    await rm(join(f.home, 'plugins', 'hot.bundle.js'))
    r = await f.app.reloadPlugins()
    expect(r.removed).toHaveLength(1)
    expect(f.svc()).toBeUndefined()
    expect(f.toolNames()).not.toContain('hot_tool')
    expect(f.events).toEqual(['loaded:hot:added', 'unloaded:hot:changed', 'loaded:hot:changed', 'unloaded:hot:removed'])
    await f.app.dispose()
  })

  it('项目里安装同一插件时切换到项目的那份', async () => {
    const f = await fixture()
    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), pluginSrc('global'))
    await f.app.reloadPlugins()
    await mkdir(join(f.proj, '.leo', 'plugins'), { recursive: true })
    await writeFile(join(f.proj, '.leo', 'plugins', 'hot.bundle.js'), pluginSrc('project'))
    const r = await f.app.reloadPlugins()
    expect(r.removed).toHaveLength(1)
    expect(r.added).toHaveLength(1)
    expect(f.svc()?.value).toBe('project')
    await f.app.dispose()
  })

  it('插件 watch 的数据文件变化时重新加载该插件', async () => {
    const f = await fixture()
    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), pluginSrc('v1'))
    await f.app.reloadPlugins()
    expect(f.svc()?.data).toBe('')
    await writeFile(join(f.home, 'hot-data.json'), '{"a":1}')
    const r = await f.app.reloadPlugins()
    expect(r.changed).toHaveLength(1)
    expect(f.svc()?.data).toBe('{"a":1}')
    await f.app.dispose()
  })

  it('新版本加载失败时恢复旧版本，修好后再加载', async () => {
    const f = await fixture()
    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), pluginSrc('good'))
    await f.app.reloadPlugins()
    await sleep(20)
    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), 'export default { name: "hot", apply() { throw new Error("boom") } }')
    let r = await f.app.reloadPlugins()
    expect(r.failed[0]?.error).toContain('boom')
    expect(f.svc()?.value).toBe('good')
    // 同一个坏版本不会反复重试
    r = await f.app.reloadPlugins()
    expect(r.failed).toHaveLength(0)
    await sleep(20)
    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), pluginSrc('fixed'))
    r = await f.app.reloadPlugins()
    expect(f.svc()?.value).toBe('fixed')
    await f.app.dispose()
  })

  it('插件选项（config.json）变化时重新加载', async () => {
    const f = await fixture()
    await writeFile(join(f.home, 'plugins', 'hot.bundle.js'), pluginSrc('v1'))
    await f.app.reloadPlugins()
    await writeFile(join(f.home, 'config.json'), JSON.stringify({ plugins: [['./plugins/hot.bundle.js', { n: 1 }]] }))
    const r = await f.app.reloadPlugins()
    expect(r.changed).toHaveLength(1)
    await f.app.dispose()
  })

  it('自动监听：放进 plugins/ 目录后无需手动调用即可加载', async () => {
    const root = await tmp()
    const home = join(root, 'home')
    await mkdir(join(home, 'plugins'), { recursive: true })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, pluginPollMs: 200 })
    await writeFile(join(home, 'plugins', 'auto.bundle.js'), pluginSrc('auto', 'auto'))
    for (let i = 0; i < 40 && !app.leo.ctx.has('auto' as never); i++) await sleep(100)
    expect(app.leo.ctx.has('auto' as never)).toBe(true)
    await app.dispose()
  })

  it('watchPlugins: false 时不自动加载', async () => {
    const root = await tmp()
    const home = join(root, 'home')
    await mkdir(join(home, 'plugins'), { recursive: true })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, watchPlugins: false, pluginPollMs: 100 })
    await writeFile(join(home, 'plugins', 'auto.bundle.js'), pluginSrc('auto', 'auto'))
    await sleep(800)
    expect(app.leo.ctx.has('auto' as never)).toBe(false)
    await app.dispose()
  })
})
