#!/usr/bin/env node
/**
 * leo 命令行：让底座开箱即可运行、干活。实现完全基于公开 API（createLeoFromConfig + Agent 事件流），
 * 也可以作为“如何在自己的产品里使用 Agent Loop”的参考。
 */
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Interface } from 'node:readline/promises'
import { createLeoFromConfig, type LeoApp, type PluginNotice } from '../config/create.js'
import { loadConfig } from '../config/load.js'
import { maskSecret, readCredentialFile, writeCredential } from '../config/secrets.js'
import { LeoError } from '../errors.js'
import type { Agent, AgentEvent } from '../loop/types.js'
import { textOf } from '../protocol/messages.js'
import type { ApprovalService } from '../tools/types.js'
import { type CliArgs, HELP, parseArgs } from './args.js'
import { collectModels, describeModel, describeReasoning, type ModelChoice, parseEffort, parseSwitch, withEffort, withThinking } from './models.js'
import type { ReasoningOptions } from '../llm/types.js'
import { addPlugin, DEFAULT_PLUGIN_REGISTRY, defaultIo, initPlugin, loadRegistry, uninstallPlugin } from './plugin.js'
import { askSecret, c, makeRl, oneLine, readStdin } from './ui.js'

const out = process.stdout
const err = process.stderr
const log = (s = '') => err.write(`${s}\n`)

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    log(c.red((e as Error).message))
    log('运行 leo --help 查看用法')
    return 2
  }
  if (args.help || args.command === 'help') return void out.write(`${HELP}\n`), 0
  if (args.version || args.command === 'version') return void out.write(`${version()}\n`), 0
  const cwd = resolve(args.cwd ?? process.cwd())

  switch (args.command) {
    case 'init':
      return cmdInit(cwd)
    case 'auth':
      return cmdAuth(cwd, args)
    case 'models':
      return cmdModels(cwd, args)
    case 'doctor':
      return cmdDoctor(cwd, args)
    case 'plugin':
    case 'plugins':
      return cmdPlugin(cwd, args)
    case 'serve':
      return cmdServe(cwd, args)
    default:
      return cmdRun(cwd, args)
  }
}

// —— leo init ——————————————————————————————————————————————————————————
const CONFIG_TEMPLATE = `{
  // leo 项目配置。完整说明见 docs/development-guide.md「.leo 配置」一节
  // 默认模型：<provider>/<model>。不写时用模型供应商插件的默认模型
  // "model": "deepseek/deepseek-flash",   // 可选模型：leo models

  // 模型供应商由插件提供，底座不内置任何厂商：
  //   leo plugin add provider            注册层（自带通用 OpenAI 兼容协议，配置在 .leo/provider.json）
  //   leo plugin add provider-deepseek   DeepSeek 子插件
  //   leo auth set deepseek              密钥存到 credentials.json（或 export DEEPSEEK_API_KEY）
  // 0.1.x 的 "providers": { ... } 写法仍然有效，由 provider 插件读取。

  // 第三方或自定义插件：npm 包名或相对路径；也会自动加载 .leo/plugins/ 下的 .js/.mjs/.ts
  "plugins": [],

  "tools": {
    // ask：写文件/执行命令前询问；auto：直接执行；deny：禁止
    "approval": "ask"
  },

  "agent": {
    "maxSteps": 50
    // 思考模式与推理强度（不写由模型决定，DeepSeek 默认开启、强度 high；各模型支持的档位见 leo models）
    // "reasoning": { "enabled": true, "effort": "high" },
    // "systemPrompt": "覆盖默认 system prompt",
    // "appendSystemPrompt": "追加的项目约定"
  }
}
`

const NO_PROVIDER_HINT = '没有模型供应商插件。运行 leo plugin add provider && leo plugin add provider-deepseek，再 leo auth set deepseek'
const NO_DRIVER_HINT = '还没有可用的模型：安装厂商子插件（如 leo plugin add provider-deepseek），或在 .leo/provider.json 里配置 OpenAI 兼容端点'
/** 没有任何 provider 时的提示：区分“没装注册层”和“装了但没有驱动 / 配置” */
const noProviderHint = (app: LeoApp) => (app.leo.ctx.has('providers' as never) ? NO_DRIVER_HINT : NO_PROVIDER_HINT)

async function cmdInit(cwd: string): Promise<number> {
  const dir = join(cwd, '.leo')
  await mkdir(join(dir, 'plugins'), { recursive: true })
  const cfg = join(dir, 'config.json')
  const exists = await stat(cfg).then(() => true, () => false)
  if (!exists) await writeFile(cfg, CONFIG_TEMPLATE, 'utf8')
  const gi = join(cwd, '.gitignore')
  const current = await readFile(gi, 'utf8').catch(() => '')
  const need = ['.leo/credentials.json', '.leo/sessions/'].filter((l) => !current.split(/\r?\n/).includes(l))
  if (need.length) await appendFile(gi, `${current && !current.endsWith('\n') ? '\n' : ''}# leo\n${need.join('\n')}\n`)
  log(`${exists ? c.yellow('已存在') : c.green('已创建')} ${cfg}`)
  if (need.length) log(`${c.green('已更新')} .gitignore（${need.join(', ')}）`)

  if (process.stdin.isTTY) {
    const app = await createLeoFromConfig({ cwd }).catch(() => undefined)
    const hasProvider = Boolean(app?.providers.length)
    const hasModel = Boolean(app?.model)
    await app?.dispose()
    if (!hasProvider) {
      log(c.yellow('\n还没有模型供应商插件。先安装：'))
      log(`  ${c.bold('leo plugin add provider')}            模型供应商注册层`)
      log(`  ${c.bold('leo plugin add provider-deepseek')}   DeepSeek 子插件`)
    }
    if (!hasModel) {
      const rl = makeRl()
      try {
        const provider = (await rl.question(`为哪个提供方保存密钥 ${c.gray('(provider id，留空跳过)')} [deepseek]: `)).trim() || 'deepseek'
        const key = await askSecret(rl, `${provider} API Key（留空跳过）: `)
        if (key) {
          await writeCredential(join(dir, 'credentials.json'), provider, key)
          log(`${c.green('已保存')} 密钥到 .leo/credentials.json（权限 600，已加入 .gitignore）`)
        }
      } finally {
        rl.close()
      }
    }
  }
  log(`\n下一步：运行 ${c.bold('leo')} 开始对话，或 ${c.bold('leo doctor')} 检查配置`)
  return 0
}

// —— leo plugin ——————————————————————————————————————————————————————————
async function cmdPlugin(cwd: string, args: CliArgs): Promise<number> {
  const [sub = 'list', name] = args.positionals
  const resolved = await loadConfig({ cwd })
  const registry = args.registry ?? process.env.LEO_PLUGIN_REGISTRY ?? DEFAULT_PLUGIN_REGISTRY
  const io = defaultIo(log)
  const { paths } = resolved
  if (args.global && args.project) return void log(c.red('-g 与 --project 不能同时使用')), 2
  // 默认全局（~/.leo）；--project 才装到当前项目。-g 仍可写，等同默认
  const project = args.project
  const projectRoot = project ? (paths.projectRoot ?? cwd) : undefined
  const scopeDir = project ? (paths.projectDir ?? join(cwd, '.leo')) : paths.userDir
  // 插件声明了配置文件模板时自动初始化（已存在的文件保留）；--no-init 跳过，--init-from 用自己的模板
  const init: boolean | string = args.initFrom ?? !args.noInit
  try {
    if (sub === 'add' || sub === 'install' || sub === 'i') {
      if (!name) return void log(c.red('用法：leo plugin add <id> [--project] [--no-init | --init-from <path>] [--npm]')), 2
      await addPlugin(
        { name, scopeDir, ...(projectRoot ? { projectRoot } : {}), npm: args.npm, registry, leoVersion: version(), init, force: args.force },
        io,
      )
      return 0
    }
    if (sub === 'init') {
      if (!name) return void log(c.red('用法：leo plugin init <id> [--project] [--init-from <path>] [--force]')), 2
      log(`初始化 ${name} 的配置文件 → ${scopeDir}`)
      const written = await initPlugin({ name, scopeDir, registry, from: args.initFrom ?? true, force: args.force }, io)
      if (!written.length) log(c.gray('没有写入新文件'))
      return 0
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
      if (!name) return void log(c.red('用法：leo plugin remove <id> [--project | --all] [--purge]')), 2
      if (args.all && (args.project || args.global)) return void log(c.red('--all 不能与 -g / --project 同时使用')), 2
      const ok = await uninstallPlugin(
        {
          name,
          registry,
          userDir: paths.userDir,
          ...(paths.projectDir ? { projectDir: paths.projectDir } : {}),
          scope: args.all ? 'all' : project ? 'project' : 'global',
          purge: args.purge,
        },
        io,
      )
      return ok ? 0 : 1
    }
    if (sub === 'list' || sub === 'ls') {
      const scopeOf = (p: { spec: string; from: string }) =>
        paths.projectDir && (p.from.startsWith(paths.projectDir) || p.spec.startsWith(paths.projectDir) || (paths.projectConfig && p.from === paths.projectConfig))
          ? '项目'
          : p.from === 'overrides'
            ? '参数'
            : '全局'
      log(c.bold('已安装'))
      if (!resolved.plugins.length) log(c.gray('  （无）'))
      for (const p of resolved.plugins) log(`  ${c.cyan(`[${scopeOf(p)}]`)} ${p.spec} ${c.gray(`(${p.from})`)}`)
      try {
        const reg = await loadRegistry(registry, io)
        log(`\n${c.bold('插件仓库')} ${c.gray(registry)}`)
        for (const e of reg.plugins) {
          const hit = resolved.plugins.find((p) => p.spec === e.package || p.spec.endsWith(`/${e.id}.bundle.js`) || p.spec.endsWith(`\\${e.id}.bundle.js`))
          const mark = hit ? c.green(` 已安装（${scopeOf(hit)}）`) : ''
          const status = e.status === 'stable' ? '' : c.yellow(` [${e.status}]`)
          const initMark = e.init?.files?.length ? c.gray(` [配置: ${e.init.files.map((f) => f.path).join(', ')}]`) : ''
          log(`  ${c.bold(e.id)} ${e.version}${status}${initMark}${mark}  ${c.gray(e.description)}`)
        }
      } catch (e) {
        log(c.yellow(`\n${(e as Error).message}`))
      }
      return 0
    }
    log(c.red(`未知子命令：${sub}`))
    log('用法：leo plugin list | add <id> [--project] | init <id> | remove <id> [--project | --all] [--purge]')
    return 2
  } catch (e) {
    log(c.red(`✗ ${(e as Error).message}`))
    return 1
  }
}

// —— leo auth ——————————————————————————————————————————————————————————
async function cmdAuth(cwd: string, args: CliArgs): Promise<number> {
  const [sub, provider, keyArg] = args.positionals
  const resolved = await loadConfig({ cwd })
  const target = args.project
    ? (resolved.paths.projectCredentials ?? join(cwd, '.leo', 'credentials.json'))
    : resolved.paths.userCredentials
  if (sub === 'list' || !sub) {
    for (const [label, file] of [['项目', resolved.paths.projectCredentials], ['用户', resolved.paths.userCredentials]] as const) {
      if (!file) continue
      const creds = await readCredentialFile(file)
      log(`${c.bold(label)} ${c.gray(file)}`)
      const entries = Object.entries(creds)
      if (!entries.length) log(c.gray('  (空)'))
      for (const [id, v] of entries) log(`  ${id.padEnd(14)} ${v.startsWith('$') || v.startsWith('!') ? v : maskSecret(v)}`)
    }
    return 0
  }
  if (!provider) {
    log(c.red('用法：leo auth set <provider> [key] [--project] | leo auth remove <provider> [--project]'))
    return 2
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'logout') {
    await writeCredential(target, provider, undefined)
    log(`${c.green('已删除')} ${provider}（${target}）`)
    return 0
  }
  if (sub !== 'set' && sub !== 'login') {
    log(c.red(`未知子命令：${sub}`))
    return 2
  }
  let key = keyArg
  if (!key) {
    if (process.stdin.isTTY) {
      const rl = makeRl()
      try {
        key = await askSecret(rl, `${provider} API Key: `)
      } finally {
        rl.close()
      }
    } else key = (await readStdin()).trim()
  }
  if (!key) {
    log(c.red('未输入密钥'))
    return 2
  }
  await writeCredential(target, provider, key)
  log(`${c.green('已保存')} ${provider} → ${target}（权限 600）`)
  log(c.gray(`提示：模型由插件提供。还没装的话：leo plugin add provider && leo plugin add provider-${provider}（没有对应子插件时在 .leo/provider.json 里配置 baseURL）`))
  return 0
}

// —— leo models / doctor ————————————————————————————————————————————————
async function cmdModels(cwd: string, args: CliArgs): Promise<number> {
  const app = await createLeoFromConfig({ cwd, ...(args.model ? { overrides: { model: args.model } } : {}) })
  try {
    if (!app.providers.length) log(c.yellow(noProviderHint(app)))
    const only = args.positionals[0]
    if (only && !app.providers.some((p) => p.id === only)) {
      log(c.red(`没有提供方 "${only}"`))
      return 1
    }
    const statuses = new Map(app.providers.map((p) => [p.id, p]))
    const { groups } = await collectModels(app.leo.ctx.get('llm'), { refresh: !args.offline, ...(only ? { provider: only } : {}) })
    for (const g of groups) {
      const p = statuses.get(g.provider.id)
      if (!p) continue
      const mark = p.loaded ? c.green('●') : c.gray('○')
      log(`${mark} ${c.bold(p.id)} ${c.gray(p.name)}  ${p.loaded ? '' : c.yellow(`${p.reason ?? ''}  `)}${c.gray(`密钥 ${p.credential.masked}${p.credential.source ? ` (${p.credential.source})` : ''}${p.via ? ` · ${p.via}` : ''}`)}`)
      if (g.error) log(c.yellow(`    实时获取模型失败（${g.error}），以下为插件内置列表`))
      else if (!args.offline && g.models.some((m) => m.source === 'builtin') && p.loaded) log(c.gray('    （该提供方不支持实时获取，以下为插件内置列表）'))
      if (!g.models.length) log(c.gray(`    （没有已知模型，用 ${p.id}/<model> 指定）`))
      for (const m of g.models) {
        const isDefault = m.id === p.defaultModel
        log(`    ${isDefault ? c.green('*') : ' '} ${`${p.id}/${m.id}`.padEnd(28)} ${c.gray(describeModel(m))}`)
      }
    }
    log(`\n当前默认：${app.model ? c.bold(app.model) : c.yellow('(无)')}${c.gray('（* 为各提供方默认模型；切换：leo -m <provider/model>，或交互中 /model）')}`)
    const r = app.resolved.config.agent.reasoning
    if (r) log(c.gray(`思考设置（配置）：${describeReasoning(r)}`))
    return 0
  } finally {
    await app.dispose()
  }
}

async function cmdDoctor(cwd: string, args: CliArgs): Promise<number> {
  let app: LeoApp
  try {
    app = await createLeoFromConfig({ cwd, ...(args.model ? { overrides: { model: args.model } } : {}) })
  } catch (e) {
    log(c.red(`✗ 配置加载失败：${(e as Error).message}`))
    return 1
  }
  const { paths, loadedFiles, plugins, config } = app.resolved
  log(c.bold('配置'))
  log(`  项目根      ${paths.projectRoot ?? c.gray('(未找到 .leo，使用当前目录；运行 leo init 创建)')}`)
  log(`  用户目录    ${paths.userDir}`)
  log(`  已读取      ${loadedFiles.length ? loadedFiles.join(', ') : c.gray('(无配置文件，使用默认值)')}`)
  log(c.bold('提供方'))
  if (!app.providers.length) log(`  ${c.yellow('无')} — ${noProviderHint(app)}`)
  for (const p of app.providers) {
    log(`  ${p.loaded ? c.green('✓') : c.red('✗')} ${p.id.padEnd(12)} ${p.baseURL ?? ''} ${c.gray(`key=${p.credential.masked}${p.credential.source ? ` from ${p.credential.source}` : ''}${p.via ? ` · ${p.via}` : ''}`)} ${p.reason ? c.yellow(p.reason) : ''}`)
  }
  log(`  默认模型    ${app.model ?? c.yellow('(无)')}`)
  log(c.bold('插件'))
  if (!plugins.length) log(c.gray('  (无第三方插件)'))
  for (const p of plugins) log(`  ${p.spec} ${c.gray(`(${p.from})`)}`)
  log(c.bold('工具'))
  log(`  ${app.leo.ctx.get('tools').list().map((t) => t.name).join(', ') || c.gray('(无)')}`)
  log(`  审批模式    ${config.tools.approval}`)
  log(c.bold('会话'))
  log(`  ${config.sessions.persist ? (config.sessions.dir ?? join(paths.projectDir ?? paths.userDir, 'sessions')) : '(内存，不持久化)'}`)
  await app.dispose()
  return app.model ? 0 : 1
}

// —— leo serve ——————————————————————————————————————————————————————————————
/**
 * 后台常驻：只加载配置与插件，不创建对话 Agent，直到 Ctrl+C / SIGTERM。
 * 插件在线（热加载照常生效），由插件自己决定做什么——例如 leo-plugin-gateway 接入聊天平台并替用户起 Agent。
 * 这里不提供 approval 服务：需要人工审批的插件（如网关）自己提供，否则 ask 一律拒绝（fail closed）。
 */
async function cmdServe(cwd: string, args: CliArgs): Promise<number> {
  let app: LeoApp
  let started = false
  const early: PluginNotice[] = []
  try {
    app = await createLeoFromConfig({
      cwd,
      // 启动阶段的提示先攒着，等打印完标题再输出
      onNotice: (n) => (started ? log(noticeLine(n)) : early.push(n)),
      overrides: {
        ...(args.model ? { model: args.model } : {}),
        ...(args.yes || args.noTools ? { tools: { ...(args.yes ? { approval: 'auto' as const } : {}), ...(args.noTools ? { builtin: false as const } : {}) } } : {}),
      },
    })
  } catch (e) {
    log(c.red(`✗ ${(e as Error).message}`))
    return 1
  }
  const plugins = app.loadedPlugins()
  const approval = args.yes ? 'auto' : app.resolved.config.tools.approval
  log(c.gray(`leo ${version()} · serve · ${app.model ?? '(无默认模型)'} · 审批 ${approval}`))
  log(plugins.length ? `插件：${plugins.map((p) => p.name).join(', ')}` : c.yellow('没有加载任何插件：leo serve 只是让插件常驻，先用 leo plugin add <id> 安装，例如 leo plugin add gateway'))
  if (!app.model) log(c.yellow(`还没有可用的模型：插件创建 Agent 时会失败。${app.providers.length ? '运行 leo auth set <provider> 配置密钥' : noProviderHint(app)}`))
  app.leo.ctx.on('plugin/loaded', ({ name, reason }) => log(c.gray(`[插件] ${reason === 'added' ? '已加载' : '已重新加载'} ${name}`)))
  app.leo.ctx.on('plugin/unloaded', ({ name }) => log(c.gray(`[插件] 已卸载 ${name}`)))
  app.leo.ctx.on('plugin/failed', ({ spec, error }) => log(c.red(`[插件] 加载失败 ${spec}：${error}`)))
  for (const n of early.splice(0)) log(noticeLine(n))
  started = true
  log(c.gray('运行中，Ctrl+C 停止'))
  await new Promise<void>((done) => {
    const stop = () => done()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  log(c.gray('正在停止…'))
  await app.dispose()
  return 0
}

function noticeLine(n: PluginNotice, gray = false): string {
  const text = `[${n.plugin}] ${n.message}`
  return n.level === 'error' ? c.red(text) : n.level === 'warn' ? c.yellow(text) : gray ? c.gray(text) : text
}

// —— leo / leo run ——————————————————————————————————————————————————————
async function latestSession(dir: string): Promise<string | undefined> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })))
    withTime.sort((a, b) => b.t - a.t)
    return withTime[0]?.f.replace(/\.jsonl$/, '')
  } catch {
    return undefined
  }
}

function makeApproval(rl: Interface | undefined, labelOf: (agentId: string) => string | undefined): ApprovalService | undefined {
  if (!rl) return undefined
  const always = new Set<string>()
  return {
    async request(req) {
      if (always.has(req.tool.name)) return { approved: true }
      const args = req.args as Record<string, unknown>
      const preview = typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : JSON.stringify(args)
      const label = labelOf(req.agentId)
      log(`\n${c.yellow('?')} ${label ? c.magenta(`[${label}] `) : ''}${c.bold(req.tool.name)} ${oneLine(String(preview), 300)}`)
      const a = (await rl.question(`  允许执行？${c.gray('[y]是 / [n]否 / [a]本次会话都允许')} `)).trim().toLowerCase()
      if (a === 'a' || a === 'always') {
        always.add(req.tool.name)
        return { approved: true }
      }
      return a === 'y' || a === 'yes' || a === '是' ? { approved: true } : { approved: false, reason: 'User declined' }
    },
  }
}

function render(ev: AgentEvent, args: CliArgs, state: { midLine: boolean; reasoning: boolean }) {
  if (args.json) return void out.write(`${JSON.stringify(ev)}\n`)
  const ensureNewline = () => {
    if (state.midLine) out.write('\n')
    state.midLine = false
  }
  switch (ev.type) {
    case 'reasoning_delta':
      if (args.reasoning) {
        if (!state.reasoning) {
          if (state.midLine) out.write('\n')
          state.midLine = false
          err.write(c.gray('💭 '))
        }
        state.reasoning = true
        err.write(c.gray(ev.text))
      }
      break
    case 'text_delta':
      if (state.reasoning) {
        err.write('\n\n')
        state.reasoning = false
      }
      out.write(ev.text)
      state.midLine = !ev.text.endsWith('\n')
      break
    case 'tool_start': {
      if (state.reasoning) {
        err.write('\n')
        state.reasoning = false
      }
      ensureNewline()
      const a = ev.call.arguments as Record<string, unknown> | undefined
      const preview = a ? (typeof a.command === 'string' ? a.command : typeof a.path === 'string' ? a.path : typeof a.url === 'string' ? a.url : typeof a.pattern === 'string' ? a.pattern : JSON.stringify(a)) : ''
      log(c.cyan(`⚙ ${ev.call.name} ${oneLine(String(preview))}`))
      break
    }
    case 'tool_update': {
      // 只显示约定的进度格式 { type: 'progress', message }（见 ToolProgress）
      const p = ev.partial as { type?: unknown; message?: unknown } | null
      if (p && typeof p === 'object' && p.type === 'progress' && typeof p.message === 'string') {
        ensureNewline()
        log(c.gray(`  … ${oneLine(p.message, 200)}`))
      }
      break
    }
    case 'tool_result': {
      const text = oneLine(textOf(ev.result.content), 200)
      log(ev.result.isError ? c.red(`  ✗ ${text}`) : c.gray(`  ✓ ${text}`))
      break
    }
    case 'retry':
      ensureNewline()
      log(c.yellow(`↻ ${ev.error.message}，${Math.round(ev.delayMs / 1000)}s 后重试（第 ${ev.attempt} 次）`))
      break
    case 'compaction':
      log(c.gray(`（上下文已压缩：${ev.strategy}）`))
      break
    case 'turn_end': {
      if (state.reasoning) {
        err.write('\n')
        state.reasoning = false
      }
      ensureNewline()
      const u = ev.usage
      const cost = u.costUsd ? ` · $${u.costUsd.toFixed(4)}` : ''
      if (ev.reason !== 'completed') log(c.yellow(`[${ev.reason}]${ev.error ? ` ${ev.error.message}` : ''}`))
      log(c.gray(`${ev.steps} 步 · ${u.inputTokens}↑ ${u.outputTokens}↓${u.reasoningTokens ? `（思考 ${u.reasoningTokens}）` : ''} tokens${cost}`))
      break
    }
  }
}

async function runTurn(agent: Agent, input: string, args: CliArgs, rl: Interface | undefined): Promise<boolean> {
  const state = { midLine: false, reasoning: false }
  let ok = true
  const onSigint = () => {
    log(c.yellow('\n已取消'))
    agent.abort('user interrupt')
  }
  rl?.on('SIGINT', onSigint)
  process.on('SIGINT', onSigint)
  try {
    for await (const ev of agent.prompt(input, args.maxSteps ? { maxSteps: args.maxSteps } : {})) {
      render(ev, args, state)
      if (ev.type === 'turn_end' && ev.reason === 'error') ok = false
    }
  } finally {
    rl?.off('SIGINT', onSigint)
    process.off('SIGINT', onSigint)
  }
  return ok
}

async function cmdRun(cwd: string, args: CliArgs): Promise<number> {
  let prompt = args.positionals.join(' ').trim()
  if (!process.stdin.isTTY) {
    const piped = (await readStdin()).trim()
    if (piped) prompt = prompt ? `${prompt}\n\n<stdin>\n${piped}\n</stdin>` : piped
  }
  const interactive = !args.print && !args.json && Boolean(process.stdin.isTTY) && Boolean(err.isTTY)
  const rl = interactive ? makeRl() : undefined

  // --api-key 作用的提供方
  let credentialOverrides: Record<string, string> | undefined
  if (args.apiKey) {
    const pre = await loadConfig({ cwd })
    const fromModel = (m?: string) => (m?.includes('/') ? m.slice(0, m.indexOf('/')) : undefined)
    const id = args.provider ?? fromModel(args.model) ?? fromModel(pre.config.model) ?? 'deepseek'
    credentialOverrides = { [id]: args.apiKey }
  }

  let app: LeoApp
  let ready: LeoApp | undefined
  const labelOf = (agentId: string) => ready?.leo.ctx.get('agentLoop').get(agentId)?.options.label
  try {
    app = await createLeoFromConfig({
      cwd,
      ...(interactive ? { onNotice: (n: PluginNotice) => log(noticeLine(n, true)) } : {}),
      overrides: {
        ...(args.model ? { model: args.model } : {}),
        ...(args.yes || args.noTools ? { tools: { ...(args.yes ? { approval: 'auto' as const } : {}), ...(args.noTools ? { builtin: false as const } : {}) } } : {}),
      },
      ...(credentialOverrides ? { credentialOverrides } : {}),
      ...(rl ? { approval: makeApproval(rl, labelOf)! } : {}),
    })
  } catch (e) {
    rl?.close()
    log(c.red(`✗ ${(e as Error).message}`))
    return 1
  }

  ready = app
  // 插件热加载：运行中安装、移除、更新插件时提示一行
  if (interactive) {
    app.leo.ctx.on('plugin/loaded', ({ name, reason }) => log(c.gray(`\n[插件] ${reason === 'added' ? '已加载' : '已重新加载'} ${name}`)))
    app.leo.ctx.on('plugin/unloaded', ({ name, reason }) => void (reason === 'removed' && log(c.gray(`\n[插件] 已卸载 ${name}`))))
    app.leo.ctx.on('plugin/failed', ({ spec, error }) => log(c.yellow(`\n[插件] 加载失败 ${spec}：${error}`)))
  }
  if (!app.model) {
    log(c.yellow('还没有可用的模型：'))
    if (!app.providers.length && app.leo.ctx.has('providers' as never)) {
      log(`  ${NO_DRIVER_HINT}`)
    } else if (!app.providers.length) {
      log(`  1) ${c.bold('leo plugin add provider')}            安装模型供应商注册层`)
      log(`  2) ${c.bold('leo plugin add provider-deepseek')}   安装 DeepSeek 子插件（其他 OpenAI 兼容端点在 .leo/provider.json 里写 baseURL）`)
      log(`  3) ${c.bold('leo auth set deepseek')}              保存密钥（或 export DEEPSEEK_API_KEY=sk-...）`)
    } else {
      for (const p of app.providers) log(`  ${p.id}: ${p.reason ?? '不可用'}`)
      log(`  运行 ${c.bold('leo auth set <provider>')} 保存密钥，或 ${c.bold('leo doctor')} 查看详情`)
    }
    rl?.close()
    await app.dispose()
    return 1
  }

  let sessionId = args.session
  if (!sessionId && args.continue) {
    const dir = app.resolved.config.sessions.dir
      ? resolve(app.resolved.paths.projectRoot ?? cwd, app.resolved.config.sessions.dir)
      : join(app.resolved.paths.projectDir ?? app.resolved.paths.userDir, 'sessions')
    sessionId = await latestSession(dir)
    if (!sessionId) log(c.gray('没有找到历史会话，开始新会话'))
  }
  let model = app.model
  let reasoning: ReasoningOptions = { ...app.resolved.config.agent.reasoning }
  if (args.thinking !== undefined) {
    const on = parseSwitch(args.thinking)
    if (on === undefined) {
      log(c.red(`--thinking 只能是 on / off，收到 "${args.thinking}"`))
      await app.dispose()
      return 2
    }
    reasoning = withThinking(reasoning, on)
  }
  if (args.effort !== undefined) {
    const e = parseEffort(args.effort)
    if (!e) {
      log(c.red(`--effort 只能是 none / minimal / low / medium / high / xhigh / max，收到 "${args.effort}"`))
      await app.dispose()
      return 2
    }
    reasoning = args.thinking !== undefined && parseSwitch(args.thinking) === false ? { enabled: false } : withEffort(e)
  }
  const llm = app.leo.ctx.get('llm')
  const infoOf = (m: string) => {
    try {
      return llm.resolve(m).info
    } catch {
      return undefined
    }
  }
  const newAgent = (sid?: string) => app.createAgent({ ...(sid ? { sessionId: sid } : {}), model, reasoning })
  let agent = newAgent(sessionId)
  let choices: ModelChoice[] = []
  const approvalMode = args.yes ? 'auto' : app.resolved.config.tools.approval
  const footer = () => log(c.gray(`leo ${version()} · ${model} · ${describeReasoning(reasoning, infoOf(model))} · 会话 ${agent.sessionId} · 审批 ${approvalMode}${!interactive && approvalMode === 'ask' ? '（非交互模式下写文件/执行命令会被拒绝，可加 -y）' : ''}`))

  let code = 0
  try {
    if (!interactive) {
      if (!prompt) {
        log(c.red('非交互模式需要任务描述：leo -p "任务"，或通过管道输入'))
        return 2
      }
      if (!args.json) footer()
      return (await runTurn(agent, prompt, args, undefined)) ? 0 : 1
    }

    footer()
    log(c.gray('输入任务开始；/help 查看命令，Ctrl+C 取消当前任务，Ctrl+D 退出\n'))
    if (prompt) {
      log(`${c.bold('›')} ${prompt}`)
      await runTurn(agent, prompt, args, rl)
    }
    let closed = false
    rl!.on('close', () => (closed = true))
    while (!closed) {
      let line: string
      try {
        line = (await rl!.question(`\n${c.bold('›', err)} `)).trim()
      } catch {
        break
      }
      if (!line) continue
      if (line.startsWith('/')) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/)
        if (cmd === 'exit' || cmd === 'quit') break
        if (cmd === 'help') log(HELP.slice(HELP.indexOf('交互模式命令')))
        else if (cmd === 'new') {
          await agent.dispose()
          agent = newAgent()
          log(c.gray(`新会话 ${agent.sessionId}`))
        } else if (cmd === 'model') {
          if (!rest[0]) {
            const info = infoOf(model)
            log(`当前模型：${model}${info ? c.gray(`  ${describeModel(info)}`) : ''}`)
          } else {
            const n = /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined
            if (n !== undefined && !choices.length) choices = (await collectModels(llm)).choices
            const target = n !== undefined ? choices[n - 1]?.ref : rest[0]
            if (!target) log(c.red(`没有编号 ${rest[0]} 的模型，输入 /models 查看`))
            else {
              try {
                llm.resolve(target)
                const sid = agent.sessionId
                await agent.dispose()
                model = target
                agent = newAgent(sid)
                const info = infoOf(model)
                log(c.gray(`已切换到 ${model}${info ? `（${describeModel(info)}）` : ''} · ${describeReasoning(reasoning, info)}`))
              } catch (e) {
                log(c.red((e as Error).message))
              }
            }
          }
        } else if (cmd === 'models') {
          const { groups, choices: list } = await collectModels(llm, { refresh: rest[0] !== 'offline' })
          choices = list
          let i = 0
          for (const g of groups) {
            if (g.error) log(c.yellow(`  ${g.provider.id}：实时获取失败（${g.error}），显示内置列表`))
            for (const m of g.models) {
              i++
              const ref = `${g.provider.id}/${m.id}`
              log(`  ${String(i).padStart(2)}. ${ref === model ? c.green(ref) : ref}  ${c.gray(describeModel(m))}`)
            }
          }
          if (!i) log(c.gray('  （没有已知模型）'))
          else log(c.gray('  /model <编号> 切换'))
        } else if (cmd === 'think' || cmd === 'thinking') {
          if (!rest[0]) log(`当前：${describeReasoning(reasoning, infoOf(model))} · 思考过程${args.reasoning ? '显示' : '隐藏'}`)
          else if (rest[0] === 'show' || rest[0] === 'hide') {
            args.reasoning = rest[0] === 'show'
            log(c.gray(`思考过程${args.reasoning ? '显示' : '隐藏'}`))
          } else {
            const on = parseSwitch(rest[0])
            if (on === undefined) log(c.red('用法：/think on | off | show | hide'))
            else {
              reasoning = withThinking(reasoning, on)
              const sid = agent.sessionId
              await agent.dispose()
              agent = newAgent(sid)
              log(c.gray(describeReasoning(reasoning, infoOf(model))))
            }
          }
        } else if (cmd === 'effort') {
          const info = infoOf(model)
          if (!rest[0]) {
            const lv = info?.reasoning?.efforts
            log(`当前：${describeReasoning(reasoning, info)}${lv?.length ? c.gray(`（${model} 支持 none / ${lv.join(' / ')}）`) : ''}`)
          } else {
            const e = parseEffort(rest[0])
            if (!e) log(c.red('用法：/effort none | minimal | low | medium | high | xhigh | max'))
            else {
              reasoning = withEffort(e)
              const sid = agent.sessionId
              await agent.dispose()
              agent = newAgent(sid)
              const lv = info?.reasoning?.efforts
              const note = e !== 'none' && lv?.length && !lv.includes(e) ? c.yellow(`（${model} 不支持 ${e}，由插件映射到最接近的档位；支持 ${lv.join(' / ')}）`) : ''
              log(c.gray(describeReasoning(reasoning, info)) + note)
            }
          }
        } else if (cmd === 'plugins') {
          if (rest[0] === 'reload') {
            const r = await app.reloadPlugins()
            log(c.gray(`新增 ${r.added.length} · 更新 ${r.changed.length} · 移除 ${r.removed.length}${r.failed.length ? ` · 失败 ${r.failed.length}` : ''}`))
          }
          const list = app.loadedPlugins()
          if (!list.length) log(c.gray('  （没有加载第三方插件）'))
          for (const p of list) log(`  ${p.name} ${c.gray(p.spec)}`)
        } else if (cmd === 'session') log(`会话 ${agent.sessionId}（leo -s ${agent.sessionId} 可恢复）`)
        else log(c.yellow(`未知命令 /${cmd}，输入 /help`))
        continue
      }
      await runTurn(agent, line, args, rl)
    }
    log(c.gray(`\n再见。继续这次会话：leo -c 或 leo -s ${agent.sessionId}`))
  } catch (e) {
    log(c.red(`✗ ${e instanceof LeoError ? `[${e.code}] ` : ''}${(e as Error).message}`))
    code = 1
  } finally {
    rl?.close()
    await app.dispose()
  }
  return code
}

// 输出被管道提前关闭（如 `leo -p ... | head`）时安静退出
for (const s of [out, err]) s.on('error', (e: NodeJS.ErrnoException) => (e.code === 'EPIPE' ? process.exit(0) : undefined))

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    log(c.red(`✗ ${(e as Error).stack ?? e}`))
    process.exitCode = 1
  },
)
