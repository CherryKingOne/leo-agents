#!/usr/bin/env node
/**
 * leo 命令行：让底座开箱即可运行、干活。实现完全基于公开 API（createLeoFromConfig + Agent 事件流），
 * 也可以作为“如何在自己的产品里使用 Agent Loop”的参考。
 */
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Interface } from 'node:readline/promises'
import { createLeoFromConfig, type LeoApp } from '../config/create.js'
import { loadConfig } from '../config/load.js'
import { maskSecret, readCredentialFile, writeCredential } from '../config/secrets.js'
import { LeoError } from '../errors.js'
import type { Agent, AgentEvent } from '../loop/types.js'
import { textOf } from '../protocol/messages.js'
import { PROVIDER_PRESETS } from '../providers/catalog.js'
import type { ApprovalService } from '../tools/types.js'
import { type CliArgs, HELP, parseArgs } from './args.js'
import { addPlugin, DEFAULT_PLUGIN_REGISTRY, defaultIo, initPlugin, loadRegistry, removePlugin } from './plugin.js'
import { runApiServer } from '../api/server.js'
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
    case 'api':
      return cmdApi(cwd, args)
    default:
      return cmdRun(cwd, args)
  }
}

// —— leo init ——————————————————————————————————————————————————————————
const CONFIG_TEMPLATE = `{
  // leo 项目配置。完整说明见 docs/development-guide.md「.leo 配置」一节
  // 默认模型：<provider>/<model>
  "model": "deepseek/deepseek-chat",

  // 提供方：内置预设（deepseek/openai/qwen/moonshot/zhipu/siliconflow/openrouter/ollama）只需写要覆盖的字段；
  // 任何 OpenAI 兼容端点（vLLM、SGLang、公司网关……）写 baseURL 即可。
  // 密钥不要写在这里：用 \`leo auth set <provider>\` 存到 credentials.json，或写 "$ENV_NAME" / "!command"。
  "providers": {
    "deepseek": {}
    // "vllm": { "baseURL": "http://localhost:8000/v1", "models": ["Qwen/Qwen3-32B"] }
  },

  // 第三方或自定义插件：npm 包名或相对路径；也会自动加载 .leo/plugins/ 下的 .js/.mjs/.ts
  "plugins": [],

  "tools": {
    // ask：写文件/执行命令前询问；auto：直接执行；deny：禁止
    "approval": "ask"
  },

  "agent": {
    "maxSteps": 50
    // "systemPrompt": "覆盖默认 system prompt",
    // "appendSystemPrompt": "追加的项目约定"
  }
}
`

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
    const hasKey = app?.providers.some((p) => p.loaded)
    await app?.dispose()
    if (!hasKey) {
      const rl = makeRl()
      try {
        const provider = (await rl.question(`选择提供方 ${c.gray(`(${Object.keys(PROVIDER_PRESETS).join('/')})`)} [deepseek]: `)).trim() || 'deepseek'
        if (!PROVIDER_PRESETS[provider]?.keyless) {
          const key = await askSecret(rl, `${provider} API Key（留空跳过）: `)
          if (key) {
            await writeCredential(join(dir, 'credentials.json'), provider, key)
            log(`${c.green('已保存')} 密钥到 .leo/credentials.json（权限 600，已加入 .gitignore）`)
          }
        }
        if (provider !== 'deepseek') {
          const text = (await readFile(cfg, 'utf8')).replace('"deepseek/deepseek-chat"', `"${provider}/${PROVIDER_PRESETS[provider]?.defaultModel ?? '<model>'}"`).replace('"deepseek": {}', `"${provider}": {}`)
          await writeFile(cfg, text, 'utf8')
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
  const init = args.initFrom ?? (args.init ? true : undefined)
  try {
    if (sub === 'add' || sub === 'install' || sub === 'i') {
      if (!name) return void log(c.red('用法：leo plugin add <id> [--project] [--init | --init-from <path>] [--npm]')), 2
      await addPlugin(
        { name, scopeDir, ...(projectRoot ? { projectRoot } : {}), npm: args.npm, registry, leoVersion: version(), ...(init !== undefined ? { init } : {}), force: args.force },
        io,
      )
      if (!init) log(c.gray(`提示：加 --init 可把插件的配置文件模板初始化到 ${scopeDir}（或运行 leo plugin init ${name}${project ? ' --project' : ''}）`))
      return 0
    }
    if (sub === 'init') {
      if (!name) return void log(c.red('用法：leo plugin init <id> [--project] [--init-from <path>] [--force]')), 2
      log(`初始化 ${name} 的配置文件 → ${scopeDir}`)
      await initPlugin({ name, scopeDir, registry, from: args.initFrom ?? true, force: args.force }, io)
      return 0
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
      if (!name) return void log(c.red('用法：leo plugin remove <id> [--project]')), 2
      const ok = await removePlugin({ name, scopeDir, registry }, io)
      if (!ok && !project && paths.projectDir) log(c.gray(`当前项目里的安装请用：leo plugin remove ${name} --project`))
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
          const initMark = e.init?.files?.length ? c.gray(' [--init]') : ''
          log(`  ${c.bold(e.id)} ${e.version}${status}${initMark}${mark}  ${c.gray(e.description)}`)
        }
      } catch (e) {
        log(c.yellow(`\n${(e as Error).message}`))
      }
      return 0
    }
    log(c.red(`未知子命令：${sub}`))
    log('用法：leo plugin list | add <id> | init <id> | remove <id>')
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
  if (!PROVIDER_PRESETS[provider] && !resolved.config.providers[provider]) {
    log(c.yellow(`提示："${provider}" 不是内置提供方，请在 .leo/config.json 的 providers 中配置 baseURL`))
  }
  return 0
}

// —— leo models / doctor ————————————————————————————————————————————————
async function cmdModels(cwd: string, args: CliArgs): Promise<number> {
  const app = await createLeoFromConfig({ cwd, ...(args.model ? { overrides: { model: args.model } } : {}) })
  try {
    if (!app.providers.length) log(c.yellow('没有配置任何提供方。运行 leo auth set deepseek 或设置 DEEPSEEK_API_KEY'))
    for (const p of app.providers) {
      const mark = p.loaded ? c.green('●') : c.gray('○')
      log(`${mark} ${p.id.padEnd(12)} ${c.gray(p.name)}  ${p.loaded ? `默认模型 ${p.defaultModel ?? '(需指定)'}` : c.yellow(p.reason ?? '')}  ${c.gray(`密钥 ${p.credential.masked}${p.credential.source ? ` (${p.credential.source})` : ''}`)}`)
    }
    log(`\n当前默认：${app.model ? c.bold(app.model) : c.yellow('(无)')}`)
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
  if (!app.providers.length) log(`  ${c.yellow('无')} — 运行 leo auth set deepseek 或设置 DEEPSEEK_API_KEY`)
  for (const p of app.providers) {
    log(`  ${p.loaded ? c.green('✓') : c.red('✗')} ${p.id.padEnd(12)} ${p.baseURL ?? ''} ${c.gray(`key=${p.credential.masked}${p.credential.source ? ` from ${p.credential.source}` : ''}`)} ${p.reason ? c.yellow(p.reason) : ''}`)
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

// —— leo api ——————————————————————————————————————————————————————————————
async function cmdApi(cwd: string, args: CliArgs): Promise<number> {
  const host = args.host ?? process.env.LEO_API_HOST ?? '127.0.0.1'
  const port = args.port ?? (process.env.LEO_API_PORT ? Number(process.env.LEO_API_PORT) : 8765)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log(c.red(`✗ 无效端口：${port}`))
    return 2
  }
  const token = args.token ?? process.env.LEO_API_TOKEN
  let app: LeoApp
  try {
    app = await createLeoFromConfig({
      cwd,
      overrides: {
        ...(args.model ? { model: args.model } : {}),
        ...(args.yes || args.noTools ? { tools: { ...(args.yes ? { approval: 'auto' } : {}), ...(args.noTools ? { builtin: false } : {}) } } : {}),
      },
    })
  } catch (e) {
    log(c.red(`✗ ${(e as Error).message}`))
    return 1
  }
  const { config, paths } = app.resolved
  const sessionsDir = config.sessions.persist
    ? config.sessions.dir
      ? resolve(paths.projectRoot ?? cwd, config.sessions.dir)
      : join(paths.projectDir ?? paths.userDir, 'sessions')
    : undefined
  const approval = args.yes ? 'auto' : config.tools.approval
  log(c.gray(`leo ${version()} · api · ${app.model ?? '(无默认模型)'} · 审批 ${approval}${approval === 'ask' ? '（API 模式无人审批，写文件/执行命令会被拒绝，可加 -y）' : ''}`))
  if (!app.model) log(c.yellow('还没有可用的模型：聊天接口会返回错误，插件与工具接口仍可使用。运行 leo auth set <provider> 配置密钥'))
  if (!token && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') log(c.yellow(`⚠ 监听 ${host} 且未设置 --token，任何能访问该地址的人都能调用 leo`))
  try {
    return await runApiServer(
      {
        leo: app.leo,
        ...(app.model ? { model: app.model } : {}),
        createAgent: (o) => app.createAgent(o),
        ...(sessionsDir ? { sessionsDir } : {}),
        providers: app.providers.map((p) => ({ id: p.id, name: p.name, loaded: p.loaded, defaultModel: p.defaultModel ?? null, reason: p.reason ?? null })),
        info: { version: version(), cwd, projectRoot: paths.projectRoot ?? null, approval },
      },
      { host, port, ...(token ? { token } : {}), ...(args.python ? { python: args.python } : {}), venvDir: join(paths.userDir, 'api', '.venv'), log },
    )
  } finally {
    await app.dispose()
  }
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
        if (!state.reasoning) err.write(c.gray('思考：'))
        state.reasoning = true
        err.write(c.gray(ev.text))
      }
      break
    case 'text_delta':
      if (state.reasoning) {
        err.write('\n')
        state.reasoning = false
      }
      out.write(ev.text)
      state.midLine = !ev.text.endsWith('\n')
      break
    case 'tool_start': {
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
      ensureNewline()
      const u = ev.usage
      const cost = u.costUsd ? ` · $${u.costUsd.toFixed(4)}` : ''
      if (ev.reason !== 'completed') log(c.yellow(`[${ev.reason}]${ev.error ? ` ${ev.error.message}` : ''}`))
      log(c.gray(`${ev.steps} 步 · ${u.inputTokens}↑ ${u.outputTokens}↓ tokens${cost}`))
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
  if (!app.model) {
    log(c.yellow('还没有可用的模型。三选一：'))
    log(`  1) ${c.bold('leo auth set deepseek')}            保存密钥（其他：openai / qwen / moonshot / zhipu / siliconflow / openrouter）`)
    log(`  2) ${c.bold('export DEEPSEEK_API_KEY=sk-...')}   使用环境变量`)
    log(`  3) ${c.bold('leo init')}                         在项目中创建 .leo/config.json，配置任意 OpenAI 兼容端点`)
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
  let agent = app.createAgent({ ...(sessionId ? { sessionId } : {}), model })
  const approvalMode = args.yes ? 'auto' : app.resolved.config.tools.approval
  const footer = () => log(c.gray(`leo ${version()} · ${model} · 会话 ${agent.sessionId} · 审批 ${approvalMode}${!interactive && approvalMode === 'ask' ? '（非交互模式下写文件/执行命令会被拒绝，可加 -y）' : ''}`))

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
          agent = app.createAgent({ model })
          log(c.gray(`新会话 ${agent.sessionId}`))
        } else if (cmd === 'model') {
          if (!rest[0]) log(`当前模型：${model}`)
          else {
            try {
              app.leo.ctx.get('llm').resolve(rest[0])
              const sid = agent.sessionId
              await agent.dispose()
              model = rest[0]
              agent = app.createAgent({ model, sessionId: sid })
              log(c.gray(`已切换到 ${model}`))
            } catch (e) {
              log(c.red((e as Error).message))
            }
          }
        } else if (cmd === 'models') {
          for (const p of app.providers.filter((x) => x.loaded)) log(`  ${p.id}/${p.defaultModel ?? '<model>'}`)
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
