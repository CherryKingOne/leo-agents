/**
 * 配置发现与合并。
 *
 *   ~/.leo/                 用户级（可用 LEO_HOME 改位置）
 *     config.json           用户默认配置
 *     credentials.json      用户密钥（0600）
 *     plugins/              用户插件（自动加载 *.js / *.mjs / *.ts）
 *     sessions/             不在项目内运行时的会话
 *   <project>/.leo/         项目级（从 cwd 向上查找第一个 .leo 目录）
 *     config.json           项目配置，覆盖用户配置
 *     credentials.json      项目密钥（务必加入 .gitignore；`leo init` 会自动添加）
 *     plugins/              项目插件
 *     sessions/             会话日志（JSONL）
 *
 * 合并规则：对象深合并（项目覆盖用户），`plugins` 数组拼接（用户在前），其他数组整体替换。
 */
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { LeoError } from '../errors.js'
import { type CredentialMap, readCredentialFile } from './secrets.js'
import { type LeoConfig, type LeoConfigInput, LeoConfigSchema } from './types.js'

export interface PluginRef {
  /** 模块说明符：绝对路径或 npm 包名 */
  spec: string
  config?: unknown
  /** 来源（诊断用） */
  from: string
}

export interface LeoPaths {
  cwd: string
  /** 项目根（包含 .leo 的目录），未找到时为 undefined */
  projectRoot?: string
  projectDir?: string
  userDir: string
  projectConfig?: string
  userConfig: string
  projectCredentials?: string
  userCredentials: string
}

export interface ResolvedConfig {
  config: LeoConfig
  paths: LeoPaths
  credentials: { project: CredentialMap; user: CredentialMap }
  plugins: PluginRef[]
  /** 实际读取到的配置文件 */
  loadedFiles: string[]
}

export interface LoadConfigOptions {
  cwd?: string
  /** 覆盖 ~/.leo */
  userDir?: string
  /** 最高优先级的覆盖（CLI 参数、代码传入） */
  overrides?: LeoConfigInput
  env?: NodeJS.ProcessEnv
  /** 不读取项目级 .leo（例如不信任当前目录时） */
  ignoreProject?: boolean
}

export function defaultUserDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LEO_HOME ? resolve(env.LEO_HOME) : join(homedir(), '.leo')
}

/** 从 cwd 向上查找包含 `.leo/` 目录的项目根（跳过用户目录本身的 ~/.leo） */
export function findProjectRoot(cwd: string, userDir: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    const candidate = join(dir, '.leo')
    if (resolve(candidate) !== resolve(userDir) && existsSync(candidate) && statSync(candidate).isDirectory()) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    // 允许 // 整行注释，方便手写
    const data = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('must be a JSON object')
    return data as Record<string, unknown>
  } catch (err) {
    throw new LeoError('plugin_config_invalid', `Invalid config file ${path}: ${(err as Error).message}`, { cause: err })
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 深合并：b 覆盖 a；plugins 数组拼接 */
export function mergeConfig(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue
    if (k === 'plugins' && Array.isArray(v) && Array.isArray(out[k])) out[k] = [...(out[k] as unknown[]), ...v]
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeConfig(out[k] as Record<string, unknown>, v)
    else out[k] = v
  }
  return out
}

function pluginRefs(raw: Record<string, unknown> | undefined, baseDir: string, from: string): PluginRef[] {
  const list = Array.isArray(raw?.plugins) ? (raw!.plugins as unknown[]) : []
  return list.map((e) => {
    const [spec, config] = Array.isArray(e) ? (e as [string, unknown]) : [e as string, undefined]
    if (typeof spec !== 'string') throw new LeoError('plugin_config_invalid', `Invalid plugin entry in ${from}`)
    const abs = spec.startsWith('.') || isAbsolute(spec) ? resolve(baseDir, spec) : spec
    return { spec: abs, ...(config !== undefined ? { config } : {}), from }
  })
}

async function discoverPluginDir(dir: string): Promise<PluginRef[]> {
  try {
    const files = (await readdir(dir)).filter((f) => /\.(m?js|ts)$/.test(f) && !f.endsWith('.d.ts')).sort()
    return files.map((f) => ({ spec: join(dir, f), from: dir }))
  } catch {
    return []
  }
}

/** 读取并合并用户级、项目级配置与覆盖项 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const env = opts.env ?? process.env
  const cwd = resolve(opts.cwd ?? process.cwd())
  const userDir = opts.userDir ? resolve(opts.userDir) : defaultUserDir(env)
  const projectRoot = opts.ignoreProject ? undefined : findProjectRoot(cwd, userDir)
  const paths: LeoPaths = {
    cwd,
    userDir,
    userConfig: join(userDir, 'config.json'),
    userCredentials: join(userDir, 'credentials.json'),
    ...(projectRoot
      ? {
          projectRoot,
          projectDir: join(projectRoot, '.leo'),
          projectConfig: join(projectRoot, '.leo', 'config.json'),
          projectCredentials: join(projectRoot, '.leo', 'credentials.json'),
        }
      : {}),
  }

  const loadedFiles: string[] = []
  const userRaw = await readJson(paths.userConfig)
  if (userRaw) loadedFiles.push(paths.userConfig)
  const projectRaw = paths.projectConfig ? await readJson(paths.projectConfig) : undefined
  if (projectRaw) loadedFiles.push(paths.projectConfig!)

  const all: PluginRef[] = [
    ...pluginRefs(userRaw, userDir, paths.userConfig),
    ...(await discoverPluginDir(join(userDir, 'plugins'))),
    ...(projectRoot ? pluginRefs(projectRaw, projectRoot, paths.projectConfig!) : []),
    ...(paths.projectDir ? await discoverPluginDir(join(paths.projectDir, 'plugins')) : []),
    ...pluginRefs(opts.overrides as Record<string, unknown> | undefined, cwd, 'overrides'),
  ]
  // 同一插件只加载一次：
  //   - 同一模块：显式声明（可带 config）优先于目录自动发现
  //   - 全局与项目各装了一份（plugins/ 目录里同名的文件，如 mcp.bundle.js）：项目的那份生效，
  //     位置保持在先出现处；配置优先用项目里写的，项目没写时沿用全局的
  const userPluginDir = join(userDir, 'plugins')
  const projectPluginDir = paths.projectDir ? join(paths.projectDir, 'plugins') : undefined
  const bundleKey = (spec: string): string | undefined => {
    const dir = dirname(spec)
    return dir === userPluginDir || dir === projectPluginDir ? `plugins/${basename(spec)}` : undefined
  }
  const plugins: PluginRef[] = []
  for (const ref of all) {
    const key = bundleKey(ref.spec)
    const i = plugins.findIndex((p) => p.spec === ref.spec || (key !== undefined && bundleKey(p.spec) === key))
    if (i < 0) plugins.push(ref)
    else if (plugins[i]!.spec !== ref.spec) {
      // 项目覆盖全局（all 中项目层排在全局之后）
      const config = ref.config ?? plugins[i]!.config
      plugins[i] = { ...ref, ...(config !== undefined ? { config } : {}) }
    } else if (ref.config !== undefined && plugins[i]!.config === undefined) plugins[i] = ref
  }

  let merged: Record<string, unknown> = {}
  for (const layer of [userRaw, projectRaw, opts.overrides as Record<string, unknown> | undefined]) {
    if (layer) merged = mergeConfig(merged, layer)
  }
  delete merged.plugins // 已单独解析为 PluginRef（含正确的相对路径基准）
  const parsed = LeoConfigSchema.safeParse(merged)
  if (!parsed.success) {
    throw new LeoError('plugin_config_invalid', `Invalid leo config: ${parsed.error.message}`, { cause: parsed.error })
  }

  return {
    config: parsed.data,
    paths,
    credentials: {
      user: await readCredentialFile(paths.userCredentials),
      project: paths.projectCredentials ? await readCredentialFile(paths.projectCredentials) : {},
    },
    plugins,
    loadedFiles,
  }
}
