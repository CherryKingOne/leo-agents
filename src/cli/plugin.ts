/**
 * `leo plugin`：从官方插件仓库（或自定义仓库）安装、移除、查看插件。
 *
 * 两种安装形态：
 *   - bundle（默认）：下载插件的单文件构建产物到 `<scope>/plugins/<id>.bundle.js`，被自动发现加载，校验 sha256
 *   - npm（--npm）：`npm install --prefix <scope> <package>`，并把包名写进 `<scope>/config.json` 的 plugins
 * scope 默认为用户 `~/.leo/`（全局，所有项目可用）；`--project` 装到当前项目的 `.leo/`，
 * 同一插件在两处都装时项目里的优先。
 *
 * 初始化：插件声明了配置文件模板（registry 的 init.files）时，安装后自动写进 scope 目录，
 * 例如 mcp 的 `mcp-servers.json`；没有模板则跳过。已存在的文件不覆盖（--force 才覆盖），
 * --no-init 跳过，--init-from <path> 改用用户提供的模板。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addPluginEntry, listPluginEntries, removePluginEntry } from '../config/jsonc.js'

export const DEFAULT_PLUGIN_REGISTRY = 'https://raw.githubusercontent.com/CherryKingOne/leo-plugin/main/registry.json'

export interface RegistryEntry {
  id: string
  package: string
  version: string
  status: 'planned' | 'experimental' | 'stable' | 'deprecated'
  description: string
  path?: string
  /** 兼容的 leo-agents 版本范围（目前只识别 ">=x.y.z"） */
  leo?: string
  bundle?: { url: string; sha256?: string }
  /** `--init` 时写进 scope 目录的配置文件模板 */
  init?: { files: InitFile[] }
}

export interface InitFile {
  /** 相对 scope 目录（`~/.leo/` 或 `<project>/.leo/`）的目标路径，如 `mcp-servers.json`、`agents/reviewer.md` */
  path: string
  /** 模板地址（相对地址以仓库文件为基准）；与 content 二选一 */
  url?: string
  sha256?: string
  /** 内联模板内容 */
  content?: string
  /** 说明，安装时打印 */
  description?: string
}

export interface Registry {
  version: number
  plugins: RegistryEntry[]
}

export interface PluginIo {
  /** 读取 URL（http/https/file）或本地路径 */
  fetchBytes(location: string): Promise<Uint8Array>
  /** 运行 npm，返回退出码 */
  npm(args: string[], cwd: string): Promise<number>
  log(line: string): void
}

export const defaultIo = (log: (s: string) => void): PluginIo => ({
  async fetchBytes(location) {
    if (location.startsWith('file:')) return readFile(fileURLToPath(location))
    if (!/^https?:\/\//.test(location)) return readFile(location)
    const res = await fetch(location, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`GET ${location} → HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  },
  npm(args, cwd) {
    return new Promise((resolveCode) => {
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
      child.on('error', () => resolveCode(127))
      child.on('close', (code) => resolveCode(code ?? 1))
    })
  },
  log,
})

export async function loadRegistry(location: string, io: PluginIo): Promise<Registry> {
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(await io.fetchBytes(location)))
  } catch (err) {
    throw new Error(`无法读取插件仓库 ${location}：${(err as Error).message}`)
  }
  const reg = data as Registry
  if (!reg || !Array.isArray(reg.plugins)) throw new Error(`插件仓库格式不正确：${location}`)
  return reg
}

export function findEntry(reg: Registry, idOrPackage: string): RegistryEntry | undefined {
  return reg.plugins.find((p) => p.id === idOrPackage || p.package === idOrPackage)
}

/** 解析 bundle 地址：相对地址以仓库地址为基准 */
function resolveLocation(location: string, base: string): string {
  if (/^[a-z]+:\/\//i.test(location) || location.startsWith('file:') || isAbsolute(location)) return location
  if (/^https?:\/\//.test(base) || base.startsWith('file:')) return new URL(location, base).href
  return resolve(dirname(base), location)
}

function satisfies(range: string | undefined, current: string): boolean {
  const m = range?.match(/^>=\s*(\d+)\.(\d+)\.(\d+)/)
  if (!m) return true
  const want = m.slice(1).map(Number)
  const have = current.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i]!
  }
  return true
}

const bundleFile = (scopeDir: string, id: string) => join(scopeDir, 'plugins', `${id}.bundle.js`)

async function ensureGitignore(projectRoot: string, lines: string[]) {
  const gi = join(projectRoot, '.gitignore')
  const current = await readFile(gi, 'utf8').catch(() => '')
  const need = lines.filter((l) => !current.split(/\r?\n/).includes(l))
  if (need.length) await appendFile(gi, `${current && !current.endsWith('\n') ? '\n' : ''}${need.join('\n')}\n`)
}

export interface AddOptions {
  /** 插件 id、包名（--npm 时可以是仓库外的任意 npm 包） */
  name: string
  scopeDir: string
  /** 项目级安装时的项目根，用于更新 .gitignore */
  projectRoot?: string
  npm: boolean
  registry: string
  leoVersion: string
  /** 安装后初始化插件的配置文件（默认 true：有模板就初始化，没有就跳过）；false 跳过；字符串为用户提供的模板目录或文件 */
  init?: boolean | string
  /** 初始化时覆盖已存在的文件 */
  force?: boolean
}

export async function addPlugin(o: AddOptions, io: PluginIo): Promise<void> {
  let entry: RegistryEntry | undefined
  let reg: Registry | undefined
  try {
    reg = await loadRegistry(o.registry, io)
    entry = findEntry(reg, o.name)
  } catch (err) {
    if (!o.npm) throw err
    io.log(`（${(err as Error).message}，按 npm 包名安装）`)
  }
  if (!entry && !o.npm) {
    const ids = reg?.plugins.filter((p) => p.status !== 'planned').map((p) => p.id) ?? []
    throw new Error(`插件仓库里没有 "${o.name}"。可安装：${ids.join(', ') || '（无）'}。安装任意 npm 包请加 --npm`)
  }
  if (entry?.status === 'planned') throw new Error(`插件 "${entry.id}" 还在规划中，尚未发布`)
  if (entry?.status === 'deprecated') io.log(`注意：插件 "${entry.id}" 已弃用`)
  if (entry && !satisfies(entry.leo, o.leoVersion)) {
    throw new Error(`插件 "${entry.id}" 需要 leo-agents ${entry.leo}，当前为 ${o.leoVersion}`)
  }

  await mkdir(o.scopeDir, { recursive: true })

  if (!o.npm) {
    if (!entry?.bundle) throw new Error(`插件 "${entry?.id}" 没有提供单文件版本，请加 --npm 从 npm 安装`)
    const url = resolveLocation(entry.bundle.url, o.registry)
    io.log(`下载 ${entry.id}@${entry.version}：${url}`)
    const bytes = await io.fetchBytes(url)
    if (entry.bundle.sha256) {
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== entry.bundle.sha256.toLowerCase()) {
        throw new Error(`校验失败：${entry.id} 的 sha256 应为 ${entry.bundle.sha256}，实际为 ${got}。已放弃安装`)
      }
    } else io.log('注意：插件仓库未提供 sha256，跳过完整性校验')
    const file = bundleFile(o.scopeDir, entry.id)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
    io.log(`已安装 ${entry.id}@${entry.version} → ${file}（${o.projectRoot ? '当前项目' : '全局，所有项目可用'}；正在运行的 leo 会自动加载）`)
    if (o.init !== false) await initFiles({ entry, scopeDir: o.scopeDir, registry: o.registry, from: o.init ?? true, force: !!o.force, quiet: true }, io)
    io.log(`要修改插件选项，在 ${join(o.scopeDir, 'config.json')} 的 plugins 中写：["./${o.projectRoot ? '.leo/' : ''}plugins/${entry.id}.bundle.js", { ... }]`)
    return
  }

  const pkg = entry?.package ?? o.name
  const spec = entry ? `${pkg}@${entry.version}` : pkg
  io.log(`npm install ${spec}（安装到 ${o.scopeDir}）`)
  const code = await io.npm(['install', '--prefix', o.scopeDir, '--no-audit', '--no-fund', spec], o.scopeDir)
  if (code !== 0) throw new Error(`npm install 失败（退出码 ${code}）`)
  const cfg = join(o.scopeDir, 'config.json')
  const text = await readFile(cfg, 'utf8').catch(() => '')
  const pkgName = pkg.replace(/@[^@/]+$/, '') || pkg
  await writeFile(cfg, addPluginEntry(text, pkgName), 'utf8')
  if (o.projectRoot) await ensureGitignore(o.projectRoot, ['.leo/node_modules/'])
  io.log(`已安装 ${pkgName}（${o.projectRoot ? '当前项目' : '全局，所有项目可用'}），并加入 ${cfg} 的 plugins`)
  if (o.init !== false) {
    const local = await manifestInit(join(o.scopeDir, 'node_modules', pkgName))
    await initFiles({ entry: local ?? entry, scopeDir: o.scopeDir, registry: o.registry, from: o.init ?? true, force: !!o.force, quiet: true }, io)
  }
}

// —— 初始化配置文件 ——————————————————————————————————————————————————————

/** 读取 npm 包自带的 leo-plugin.json 里的 init（模板路径相对包目录） */
async function manifestInit(pkgDir: string): Promise<{ id: string; init?: { files: InitFile[] } } | undefined> {
  try {
    const m = JSON.parse(await readFile(join(pkgDir, 'leo-plugin.json'), 'utf8')) as { id?: string; init?: { files?: (InitFile & { template?: string })[] } }
    if (!m.init?.files?.length) return undefined
    return {
      id: m.id ?? pkgDir,
      init: { files: m.init.files.map((f) => ({ ...f, ...(f.template && !f.url && f.content === undefined ? { url: join(pkgDir, f.template) } : {}) })) },
    }
  } catch {
    return undefined
  }
}

/** 目标路径必须留在 scope 目录内 */
function safeTarget(scopeDir: string, path: string): string {
  const target = resolve(scopeDir, normalize(path))
  const rel = relative(resolve(scopeDir), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || isAbsolute(path)) throw new Error(`初始化文件路径不合法：${path}（必须是 .leo 内的相对路径）`)
  return target
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(p)).map((f) => join(e.name, f)))
    else if (e.isFile()) out.push(e.name)
  }
  return out
}

export interface InitOptions {
  entry: { id: string; init?: { files: InitFile[] } } | undefined
  scopeDir: string
  registry: string
  /** true：插件自带模板；字符串：用户提供的模板目录（按相对路径复制）或单个文件 */
  from: boolean | string
  force: boolean
  /** 插件没有模板时不打印提示（安装时自动初始化用） */
  quiet?: boolean
}

/** 把插件的配置文件模板写进 scope 目录。返回写入的文件 */
export async function initFiles(o: InitOptions, io: PluginIo): Promise<string[]> {
  const declared = o.entry?.init?.files ?? []
  const jobs: { path: string; load: () => Promise<Uint8Array>; sha256?: string; description?: string }[] = []

  if (typeof o.from === 'string') {
    const src = resolve(o.from)
    const st = await stat(src).catch(() => undefined)
    if (!st) throw new Error(`找不到模板：${o.from}`)
    if (st.isDirectory()) {
      for (const f of await listFiles(src)) jobs.push({ path: f.split(sep).join('/'), load: () => readFile(join(src, f)) })
    } else {
      // 单个文件：写到插件声明的唯一配置文件位置；插件没声明或声明了多个时按文件名放
      const name = src.split(sep).pop()!
      const target = declared.length === 1 ? declared[0]!.path : (declared.find((d) => d.path.split('/').pop() === name)?.path ?? name)
      jobs.push({ path: target, load: () => readFile(src) })
    }
  } else {
    if (!declared.length) {
      if (!o.quiet) io.log(`插件 "${o.entry?.id ?? '?'}" 没有需要初始化的配置文件`)
      return []
    }
    for (const f of declared) {
      if (f.content !== undefined) jobs.push({ path: f.path, load: async () => new TextEncoder().encode(f.content!), ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.description ? { description: f.description } : {}) })
      else if (f.url) {
        const url = resolveLocation(f.url, o.registry)
        jobs.push({ path: f.path, load: () => io.fetchBytes(url), ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.description ? { description: f.description } : {}) })
      } else throw new Error(`初始化文件 ${f.path} 缺少 url 或 content`)
    }
  }

  const written: string[] = []
  for (const job of jobs) {
    const target = safeTarget(o.scopeDir, job.path)
    if (existsSync(target) && !o.force) {
      io.log(`  已存在，保留：${target}（--force 覆盖）`)
      continue
    }
    const bytes = await job.load()
    if (job.sha256) {
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== job.sha256.toLowerCase()) throw new Error(`模板 ${job.path} 校验失败：sha256 应为 ${job.sha256}，实际为 ${got}`)
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    written.push(target)
    io.log(`  已初始化 ${target}${job.description ? `：${job.description}` : ''}`)
  }
  return written
}

export interface InitPluginOptions {
  name: string
  scopeDir: string
  registry: string
  from: boolean | string
  force: boolean
}

/** `leo plugin init <id>`：给已安装（或尚未安装）的插件初始化配置文件 */
export async function initPlugin(o: InitPluginOptions, io: PluginIo): Promise<string[]> {
  let entry: RegistryEntry | { id: string; init?: { files: InitFile[] } } | undefined
  try {
    entry = findEntry(await loadRegistry(o.registry, io), o.name)
  } catch (err) {
    if (o.from === true) throw err
  }
  if (!entry) {
    const local = await manifestInit(join(o.scopeDir, 'node_modules', o.name))
    if (local) entry = local
  }
  if (!entry && o.from === true) throw new Error(`找不到插件 "${o.name}" 的配置模板`)
  return initFiles({ entry: entry ?? { id: o.name }, scopeDir: o.scopeDir, registry: o.registry, from: o.from, force: o.force }, io)
}

export interface RemoveOptions {
  name: string
  scopeDir: string
  registry: string
  /** 同时删除插件安装时初始化的配置文件（默认保留，用户可能改过） */
  purge?: boolean
}

async function entryFor(name: string, registry: string, io: PluginIo): Promise<RegistryEntry | undefined> {
  try {
    return findEntry(await loadRegistry(registry, io), name)
  } catch {
    return undefined // 离线也能移除：按名字直接处理
  }
}

/** scope 目录里是否装了这个插件（plugins/ 单文件、config.json 里的包名，或 node_modules 里的包） */
export async function isPluginInstalled(scopeDir: string, name: string, entry?: RegistryEntry): Promise<boolean> {
  const id = entry?.id ?? name
  const pkg = entry?.package ?? name
  if (existsSync(bundleFile(scopeDir, id))) return true
  if (existsSync(join(scopeDir, 'node_modules', pkg, 'package.json'))) return true
  const text = await readFile(join(scopeDir, 'config.json'), 'utf8').catch(() => '')
  return !!text && listPluginEntries(text).includes(pkg)
}

/** 从一个 scope（全局 ~/.leo 或项目 .leo）卸载插件。返回是否找到并移除了 */
export async function removePlugin(o: RemoveOptions, io: PluginIo, known?: RegistryEntry): Promise<boolean> {
  const entry = known ?? (await entryFor(o.name, o.registry, io))
  const id = entry?.id ?? o.name
  const pkg = entry?.package ?? o.name
  let removed = false

  // 先记下要清理的配置文件（npm 包卸载后就读不到清单了）
  const purgeFiles = o.purge
    ? ((await manifestInit(join(o.scopeDir, 'node_modules', pkg)))?.init?.files ?? entry?.init?.files ?? []).map((f) => f.path)
    : []

  const file = bundleFile(o.scopeDir, id)
  if (existsSync(file)) {
    await rm(file)
    io.log(`已删除 ${file}`)
    removed = true
  }
  const cfg = join(o.scopeDir, 'config.json')
  const text = await readFile(cfg, 'utf8').catch(() => '')
  if (text && listPluginEntries(text).includes(pkg)) {
    await writeFile(cfg, removePluginEntry(text, pkg), 'utf8')
    io.log(`已从 ${cfg} 移除 ${pkg}`)
    removed = true
  }
  if (existsSync(join(o.scopeDir, 'node_modules', pkg, 'package.json'))) {
    const code = await io.npm(['uninstall', '--prefix', o.scopeDir, '--no-audit', '--no-fund', pkg], o.scopeDir)
    if (code !== 0) throw new Error(`npm uninstall 失败（退出码 ${code}）`)
    io.log(`已卸载 npm 包 ${pkg}`)
    removed = true
  }
  if (removed) {
    for (const rel of purgeFiles) {
      const target = safeTarget(o.scopeDir, rel)
      if (existsSync(target)) {
        await rm(target, { recursive: true })
        io.log(`已删除配置文件 ${target}`)
      }
    }
  }
  if (!removed) io.log(`没有找到已安装的 "${o.name}"（${o.scopeDir}）`)
  return removed
}

export interface UninstallOptions {
  name: string
  registry: string
  /** 全局目录（~/.leo） */
  userDir: string
  /** 当前项目的 .leo（没有项目时为 undefined） */
  projectDir?: string
  /** 'global'（默认）| 'project' | 'all' */
  scope: 'global' | 'project' | 'all'
  purge?: boolean
}

/**
 * `leo plugin remove`：默认卸载全局安装；--project 卸载当前项目里的；--all 两处都卸载。
 * 卸载一处后提示另一处是否还装着（项目里的安装会继续在该项目生效，删掉项目那份后全局那份接管）。
 */
export async function uninstallPlugin(o: UninstallOptions, io: PluginIo): Promise<boolean> {
  const entry = await entryFor(o.name, o.registry, io)
  const scopes: { label: string; dir: string }[] = []
  if (o.scope !== 'project') scopes.push({ label: '全局', dir: o.userDir })
  if (o.scope !== 'global') {
    if (!o.projectDir) {
      if (o.scope === 'project') {
        io.log('当前目录及上级没有项目 .leo/，没有可卸载的项目插件')
        return false
      }
    } else if (o.projectDir !== o.userDir) scopes.push({ label: '项目', dir: o.projectDir })
  }
  let any = false
  for (const s of scopes) {
    io.log(`卸载${s.label}插件 ${entry?.id ?? o.name}（${s.dir}）`)
    if (await removePlugin({ name: o.name, scopeDir: s.dir, registry: o.registry, ...(o.purge ? { purge: true } : {}) }, io, entry)) any = true
  }
  if (o.scope !== 'all') {
    const other = o.scope === 'global' ? (o.projectDir && o.projectDir !== o.userDir ? { label: '项目', dir: o.projectDir, flag: ' --project' } : undefined) : { label: '全局', dir: o.userDir, flag: '' }
    if (other && (await isPluginInstalled(other.dir, o.name, entry))) {
      io.log(
        o.scope === 'global'
          ? `提示：当前项目里还有项目级安装，在这个项目中仍会生效；一起卸载用 leo plugin remove ${o.name} --all，只卸载项目的用 leo plugin remove ${o.name}${other.flag}`
          : `提示：全局还装着 ${o.name}，这个项目会改用全局那份；彻底卸载用 leo plugin remove ${o.name} --all`,
      )
    }
  }
  if (any) {
    io.log('正在运行的 leo 会自动卸载它（热加载）')
    if (!o.purge && entry?.init?.files?.length) io.log(`配置文件已保留（${entry.init.files.map((f) => f.path).join(', ')}）；连同配置一起删除请加 --purge`)
  }
  return any
}
