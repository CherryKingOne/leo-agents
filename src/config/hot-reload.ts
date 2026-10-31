/**
 * 插件热加载：运行中的 leo 感知插件的安装、移除、更新与插件数据文件的变化，不需要重启。
 *
 * 监听（fs.watch + 低频轮询兜底，都不会让进程常驻）：
 *   - `~/.leo/config.json`、`~/.leo/plugins/`、项目 `.leo/config.json`、项目 `.leo/plugins/`
 *   - 已加载插件在定义里声明的 `watch` 路径（相对 `.leo/`，全局与项目各一份），如 mcp 的 `mcp-servers.json`
 *
 * 任一变化后（去抖）重新解析插件列表并与当前状态比较：
 *   - 新出现的插件 → 加载（`plugin/loaded`，reason: added）
 *   - 消失的插件 → 卸载，撤销它注册的全部服务、工具、监听器（`plugin/unloaded`，reason: removed）
 *   - 模块文件、插件选项或 watch 文件变化 → 卸载旧实例再加载新实例（reason: changed）；
 *     新实例加载失败时恢复旧实例并发出 `plugin/failed`
 * 先卸载、再加载，避免同名工具冲突。Agent 每一步都会重新读取工具列表，所以热加载的工具从下一步起可用。
 *
 * 不热更新的部分：模型、提供方、内置工具、审批等宿主配置，修改后仍需重启。
 */
import { type FSWatcher, existsSync, statSync, watch as fsWatch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, PluginRuntime } from '../kernel/context.js'
import type { Logger } from '../kernel/logger.js'
import { normalizePlugin, type PluginLike } from '../kernel/plugin.js'
import type { EventDef } from '../kernel/types.js'
import { type LoadConfigOptions, loadConfig, type LeoPaths, type PluginRef } from './load.js'

export type PluginChangeReason = 'added' | 'changed' | 'removed'

declare module '../kernel/types.js' {
  interface Events {
    /** 热加载了一个插件（启动时的加载不发） */
    'plugin/loaded': EventDef<'emit', { spec: string; name: string; reason: Exclude<PluginChangeReason, 'removed'> }>
    /** 热卸载了一个插件 */
    'plugin/unloaded': EventDef<'emit', { spec: string; name: string; reason: Exclude<PluginChangeReason, 'added'> }>
    /** 热加载失败（changed 时已恢复旧实例） */
    'plugin/failed': EventDef<'emit', { spec: string; error: string }>
  }
}

export interface ReloadResult {
  added: string[]
  removed: string[]
  changed: string[]
  failed: { spec: string; error: string }[]
}

interface Slot {
  ref: PluginRef
  plugin: PluginLike
  name: string
  watch: readonly string[]
  /** 模块文件 + 插件选项 + watch 文件 的指纹 */
  moduleStamp: string
  configStamp: string
  dataStamp: string
  rt?: PluginRuntime
}

export interface HotReloaderOptions {
  loadOptions: LoadConfigOptions
  paths: LeoPaths
  logger: Logger
  /** 导入插件模块；version 用来绕过 ESM 缓存 */
  importPlugin(ref: PluginRef, version?: string): Promise<PluginLike>
  /** 解析插件模块对应的入口文件（用于计算指纹），找不到返回 undefined */
  resolveFile(ref: PluginRef): string | undefined
  /** 去抖时间，默认 300ms */
  debounceMs?: number
  /** 轮询兜底间隔，默认 3000ms；0 关闭 */
  pollMs?: number
}

type Loader = (p: PluginLike, config: unknown) => Promise<PluginRuntime>

async function fileStamp(file: string | undefined): Promise<string> {
  if (!file) return ''
  try {
    const s = await stat(file)
    if (!s.isDirectory()) return `${s.mtimeMs}:${s.size}`
    const entries = (await readdir(file)).sort()
    const parts = await Promise.all(entries.map(async (e) => `${e}=${await fileStamp(join(file, e))}`))
    return `dir[${parts.join(',')}]`
  } catch {
    return 'missing'
  }
}

export class PluginHotReloader {
  private readonly slots = new Map<string, Slot>()
  /** 加载失败过的插件：指纹不变就不再重试，避免轮询刷屏 */
  private readonly failedStamps = new Map<string, string>()
  private loader?: Loader
  private emit?: (event: 'plugin/loaded' | 'plugin/unloaded' | 'plugin/failed', payload: never) => void
  private readonly watchers = new Map<string, FSWatcher>()
  private timer?: NodeJS.Timeout
  private poll?: NodeJS.Timeout
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false
  private paths: LeoPaths

  private logger: Logger

  constructor(private readonly o: HotReloaderOptions) {
    this.paths = o.paths
    this.logger = o.logger
  }

  setLogger(logger: Logger) {
    this.logger = logger
  }

  /** 当前加载的插件（spec → 插件名） */
  loaded(): { spec: string; name: string; from: string }[] {
    return [...this.slots.values()].map((s) => ({ spec: s.ref.spec, name: s.name, from: s.ref.from }))
  }

  /** 启动时加载：在宿主的插件槽里按顺序加载，失败直接抛出（与之前行为一致） */
  async loadInitial(ctx: Context, refs: PluginRef[]): Promise<void> {
    this.loader = (p, c) => ctx.plugin(p as PluginLike<unknown>, c)
    for (const ref of refs) {
      const slot = await this.prepare(ref)
      slot.rt = await this.loader(slot.plugin, ref.config)
      this.slots.set(ref.spec, slot)
    }
  }

  /** 启动完成后接管后续热加载，并开始监听 */
  start(loader: Loader, emit: (event: string, payload: unknown) => void, watch: boolean) {
    this.loader = loader
    this.emit = emit as never
    if (!watch) return
    this.ensureWatchers()
    const pollMs = this.o.pollMs ?? 3000
    if (pollMs > 0) {
      this.poll = setInterval(() => this.schedule(), pollMs)
      this.poll.unref()
    }
  }

  private async prepare(ref: PluginRef, version?: string): Promise<Slot> {
    const file = this.o.resolveFile(ref)
    const moduleStamp = await fileStamp(file)
    const plugin = await this.o.importPlugin(ref, version ?? (moduleStamp && moduleStamp !== 'missing' ? moduleStamp : undefined))
    let name = ref.spec
    let watch: readonly string[] = []
    try {
      const def = normalizePlugin(plugin)
      name = def.name
      watch = def.watch ?? []
    } catch {
      // 交给加载阶段报错
    }
    const slot: Slot = { ref, plugin, name, watch, moduleStamp, configStamp: JSON.stringify(ref.config ?? null), dataStamp: '' }
    slot.dataStamp = await this.dataStamp(slot)
    return slot
  }

  private dataDirs(): string[] {
    return [this.paths.userDir, ...(this.paths.projectDir ? [this.paths.projectDir] : [])]
  }

  private async dataStamp(slot: Pick<Slot, 'watch'>): Promise<string> {
    if (!slot.watch.length) return ''
    const parts: string[] = []
    for (const dir of this.dataDirs()) for (const w of slot.watch) parts.push(`${w}@${dir}=${await fileStamp(join(dir, w))}`)
    return parts.join('|')
  }

  /** 合并短时间内的多次变化后重新加载（已有待执行的就不再推迟，避免持续写入时一直不生效） */
  schedule() {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.reload().catch((err) => this.logger.error({ err }, 'plugin hot reload failed'))
    }, this.o.debounceMs ?? 300)
    this.timer.unref?.()
  }

  /** 立即对比并应用变化（串行执行） */
  reload(): Promise<ReloadResult> {
    const run = this.chain.then(() => this.doReload())
    this.chain = run.catch(() => undefined)
    return run
  }

  private async doReload(): Promise<ReloadResult> {
    const result: ReloadResult = { added: [], removed: [], changed: [], failed: [] }
    if (this.closed || !this.loader) return result
    let refs: PluginRef[]
    try {
      const resolved = await loadConfig(this.o.loadOptions)
      this.paths = resolved.paths
      refs = resolved.plugins
    } catch (err) {
      // 配置文件写到一半之类：保持现状，等下一次变化
      this.logger.warn({ err: (err as Error).message }, 'plugin hot reload skipped: config not readable')
      return result
    }
    const want = new Map(refs.map((r) => [r.spec, r]))

    // 1. 卸载已消失的
    for (const [spec, slot] of [...this.slots]) {
      if (want.has(spec)) continue
      await slot.rt?.dispose()
      this.slots.delete(spec)
      result.removed.push(spec)
      this.emit?.('plugin/unloaded', { spec, name: slot.name, reason: 'removed' } as never)
      this.logger.info({ plugin: slot.name, spec }, 'plugin unloaded')
    }

    // 2. 变化的：先卸载旧实例再加载新实例；失败时恢复旧实例
    for (const [spec, ref] of want) {
      const slot = this.slots.get(spec)
      if (!slot) continue
      const moduleStamp = await fileStamp(this.o.resolveFile(ref))
      const configStamp = JSON.stringify(ref.config ?? null)
      const dataStamp = await this.dataStamp(slot)
      if (moduleStamp === slot.moduleStamp && configStamp === slot.configStamp && dataStamp === slot.dataStamp) continue
      const stamp = `${moduleStamp}|${configStamp}|${dataStamp}`
      if (this.failedStamps.get(spec) === stamp) continue
      await slot.rt?.dispose()
      this.emit?.('plugin/unloaded', { spec, name: slot.name, reason: 'changed' } as never)
      try {
        const next = moduleStamp === slot.moduleStamp ? { ...slot, ref, configStamp, dataStamp, rt: undefined } : await this.prepare(ref)
        next.rt = await this.loader(next.plugin, ref.config)
        this.slots.set(spec, next)
        this.failedStamps.delete(spec)
        result.changed.push(spec)
        this.emit?.('plugin/loaded', { spec, name: next.name, reason: 'changed' } as never)
        this.logger.info({ plugin: next.name, spec }, 'plugin reloaded')
      } catch (err) {
        const error = (err as Error).message
        this.failedStamps.set(spec, stamp)
        result.failed.push({ spec, error })
        this.emit?.('plugin/failed', { spec, error } as never)
        this.logger.error({ err, spec }, 'plugin reload failed, restoring previous version')
        try {
          slot.rt = await this.loader(slot.plugin, slot.ref.config)
        } catch (err2) {
          this.slots.delete(spec)
          this.logger.error({ err: err2, spec }, 'failed to restore previous plugin version')
        }
      }
    }

    // 3. 新增的（按配置顺序）
    for (const [spec, ref] of want) {
      if (this.slots.has(spec)) continue
      const moduleStamp = await fileStamp(this.o.resolveFile(ref))
      const stamp = `${moduleStamp}|${JSON.stringify(ref.config ?? null)}`
      if (this.failedStamps.get(spec) === stamp) continue
      try {
        const slot = await this.prepare(ref)
        slot.rt = await this.loader(slot.plugin, ref.config)
        this.slots.set(spec, slot)
        this.failedStamps.delete(spec)
        result.added.push(spec)
        this.emit?.('plugin/loaded', { spec, name: slot.name, reason: 'added' } as never)
        this.logger.info({ plugin: slot.name, spec }, 'plugin loaded')
      } catch (err) {
        const error = (err as Error).message
        this.failedStamps.set(spec, stamp)
        result.failed.push({ spec, error })
        this.emit?.('plugin/failed', { spec, error } as never)
        this.logger.error({ err, spec }, 'plugin load failed')
      }
    }

    this.ensureWatchers()
    return result
  }

  /** 监听存在的目录；目录后来才创建时，由父目录事件或轮询触发 reload 后补上 */
  private ensureWatchers() {
    if (this.closed || !this.emit) return
    const dirs = new Set<string>([this.paths.cwd, this.paths.userDir, join(this.paths.userDir, 'plugins')])
    if (this.paths.projectDir) {
      dirs.add(this.paths.projectDir)
      dirs.add(join(this.paths.projectDir, 'plugins'))
    }
    for (const slot of this.slots.values()) {
      for (const base of this.dataDirs()) {
        for (const w of slot.watch) {
          const p = join(base, w)
          dirs.add(w.endsWith('/') ? p : join(p, '..'))
        }
      }
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue
      try {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
        const w = fsWatch(dir, { persistent: false }, () => this.schedule())
        w.on('error', () => {
          w.close()
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, w)
      } catch {
        // 某些文件系统不支持 watch：靠轮询兜底
      }
    }
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.poll) clearInterval(this.poll)
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}
