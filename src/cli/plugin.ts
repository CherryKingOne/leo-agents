/**
 * `leo plugin`：从官方插件仓库（或自定义仓库）安装、移除、查看插件。
 *
 * 两种安装形态：
 *   - bundle（默认）：下载插件的单文件构建产物到 `<scope>/plugins/<id>.bundle.js`，被自动发现加载，校验 sha256
 *   - npm（--npm）：`npm install --prefix <scope> <package>`，并把包名写进 `<scope>/config.json` 的 plugins
 * scope 为项目 `.leo/`（默认）或用户 `~/.leo/`（--global）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
    io.log(`已安装 ${entry.id}@${entry.version} → ${file}（自动加载，使用默认配置）`)
    io.log(`要修改配置，在 ${join(o.scopeDir, 'config.json')} 的 plugins 中写：["./${o.projectRoot ? '.leo/' : ''}plugins/${entry.id}.bundle.js", { ... }]`)
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
  io.log(`已安装 ${pkgName}，并加入 ${cfg} 的 plugins`)
}

export interface RemoveOptions {
  name: string
  scopeDir: string
  registry: string
}

export async function removePlugin(o: RemoveOptions, io: PluginIo): Promise<boolean> {
  let entry: RegistryEntry | undefined
  try {
    entry = findEntry(await loadRegistry(o.registry, io), o.name)
  } catch {
    // 离线也能移除：按名字直接处理
  }
  const id = entry?.id ?? o.name
  const pkg = entry?.package ?? o.name
  let removed = false

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
    removed = true
  }
  if (!removed) io.log(`没有找到已安装的 "${o.name}"（${o.scopeDir}）`)
  return removed
}
