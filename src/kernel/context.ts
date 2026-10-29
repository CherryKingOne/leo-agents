import { LeoError } from '../errors.js'
import { EventBus } from './events.js'
import { createConsoleLogger, type Logger } from './logger.js'
import { normalizePlugin, type PluginDefinition, type PluginLike, type ServiceKey } from './plugin.js'
import type { Disposer, EventName, Handler, PayloadOf, ResultOf, Scope, Services, TenantContext } from './types.js'

type ServiceValue<K extends string> = K extends keyof Services ? Services[K] : unknown

/**
 * Context：插件看到的一切。
 *
 * - **服务仓库**：`provide(key, impl)` / `get(key)`，插件之间只通过服务键协作，不互相 import 实现。
 * - **事件**：`on` 注册监听；`emit / parallel / serial / bail / waterfall` 分发。
 * - **副作用生命周期**：通过本 Context 做的每一次注册都会压入撤销栈，
 *   插件卸载 / 热重载 / 依赖服务被替换时按 LIFO 顺序自动撤销。
 * - **插件树**：`plugin()` 加载子插件；`fork()` 派生带作用域（租户/agent/会话）的子上下文。
 */
export class Context<C = unknown> {
  readonly logger: Logger
  private readonly stack: Disposer[] = []
  private readonly controller = new AbortController()
  private disposed = false

  /** @internal 由 Kernel 创建，插件不要直接 new */
  constructor(
    private readonly kernel: Kernel,
    readonly runtime: PluginRuntime,
    readonly config: C,
    readonly scope: Scope,
    logger: Logger,
  ) {
    this.logger = logger
  }

  /** 当前作用域的租户（多租户部署时存在） */
  get tenant(): TenantContext | undefined {
    return this.scope.tenant
  }

  /** 本上下文被撤销（插件卸载）时 abort，长任务应监听它 */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  // ————————————————————————— 服务 —————————————————————————

  /**
   * 注册服务。同一个键可以被多次 provide，最后一个生效（用于替换默认实现）；
   * 撤销后自动回退到上一个提供者。依赖该键的插件会被自动重新 apply。
   */
  provide<K extends ServiceKey>(key: K, impl: ServiceValue<K>): Disposer {
    this.assertAlive()
    this.kernel.addProvider(key, impl, this.runtime)
    return this.track(() => this.kernel.removeProvider(key, impl))
  }

  /** 获取服务，缺失则抛出 service_missing。请确保已在 inject 中声明该键 */
  get<K extends ServiceKey>(key: K): ServiceValue<K> {
    const impl = this.kernel.getService(key)
    if (impl === undefined) {
      throw new LeoError('service_missing', `Service "${key}" is not available (plugin "${this.runtime.name}")`)
    }
    return impl as ServiceValue<K>
  }

  /** 获取可选服务，缺失返回 undefined */
  maybe<K extends ServiceKey>(key: K): ServiceValue<K> | undefined {
    return this.kernel.getService(key) as ServiceValue<K> | undefined
  }

  has(key: ServiceKey): boolean {
    return this.kernel.getService(key) !== undefined
  }

  // ————————————————————————— 事件 —————————————————————————

  /** 注册监听器，返回撤销函数（卸载时也会自动撤销） */
  on<E extends EventName>(event: E, handler: Handler<E>, opts: { prepend?: boolean } = {}): Disposer {
    this.assertAlive()
    return this.track(this.kernel.bus.on(event, handler, this.runtime.name, opts.prepend))
  }

  emit<E extends EventName>(event: E, payload: PayloadOf<E>): void {
    this.kernel.bus.emit(event, payload)
  }

  parallel<E extends EventName>(event: E, payload: PayloadOf<E>): Promise<void> {
    return this.kernel.bus.parallel(event, payload)
  }

  serial<E extends EventName>(event: E, payload: PayloadOf<E>): Promise<ResultOf<E>[]> {
    return this.kernel.bus.serial(event, payload)
  }

  bail<E extends EventName>(event: E, payload: PayloadOf<E>): Promise<ResultOf<E> | undefined> {
    return this.kernel.bus.bail(event, payload)
  }

  waterfall<E extends EventName>(
    event: E,
    payload: PayloadOf<E>,
    final: (payload: PayloadOf<E>) => ResultOf<E> | Promise<ResultOf<E>>,
  ): Promise<ResultOf<E>> {
    return this.kernel.bus.waterfall(event, payload, final)
  }

  // ————————————————————————— 副作用 —————————————————————————

  /**
   * 注册任意可撤销副作用（定时器、连接、文件句柄……）。
   * `setup` 返回撤销函数，插件卸载时按 LIFO 顺序调用。
   */
  async effect(setup: () => Disposer | void | Promise<Disposer | void>): Promise<Disposer> {
    this.assertAlive()
    const d = await setup()
    return this.track(d ?? (() => {}))
  }

  // ————————————————————————— 插件树 —————————————————————————

  /** 加载子插件。子插件随父插件一起卸载 */
  async plugin<T>(p: PluginLike<T>, config?: T): Promise<PluginRuntime> {
    this.assertAlive()
    const rt = await this.kernel.load(p, config, this)
    this.track(() => rt.dispose())
    return rt
  }

  /** 派生作用域子上下文（例如按租户 / agent / 会话），随本上下文一起撤销 */
  fork(scope: Partial<Scope>): Context<C> {
    this.assertAlive()
    const child = new Context<C>(this.kernel, this.runtime, this.config, { ...this.scope, ...scope }, this.logger.child(scopeBindings(scope)))
    this.track(() => child.dispose())
    return child
  }

  /** 撤销本上下文上的全部注册（LIFO）。一般由内核调用 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort(new LeoError('cancelled', `Context of plugin "${this.runtime.name}" disposed`))
    while (this.stack.length) {
      const d = this.stack.pop()!
      try {
        await d()
      } catch (err) {
        this.logger.error({ err, plugin: this.runtime.name }, 'disposer failed')
      }
    }
  }

  private track(d: Disposer): Disposer {
    let done = false
    const once: Disposer = async () => {
      if (done) return
      done = true
      const i = this.stack.indexOf(once)
      if (i >= 0) this.stack.splice(i, 1)
      await d()
    }
    this.stack.push(once)
    return once
  }

  private assertAlive() {
    if (this.disposed) throw new LeoError('internal', `Context of plugin "${this.runtime.name}" is disposed`)
  }
}

function scopeBindings(scope: Partial<Scope>): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  if (scope.tenant) b.tenantId = scope.tenant.tenantId
  if (scope.agentId) b.agentId = scope.agentId
  if (scope.sessionId) b.sessionId = scope.sessionId
  return b
}

export type PluginState = 'pending' | 'active' | 'failed' | 'disposed'

/** 一个已加载插件的运行时记录 */
export class PluginRuntime {
  state: PluginState = 'pending'
  ctx: Context<any> | undefined
  error: unknown
  /** @internal */
  constructor(
    private readonly kernel: Kernel,
    readonly def: PluginDefinition<any>,
    readonly config: unknown,
    readonly parent: Context<any> | undefined,
  ) {}

  get name(): string {
    return this.def.name
  }

  get inject(): readonly string[] {
    return this.def.inject ?? []
  }

  /** 卸载插件：撤销其全部副作用与子插件 */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return
    await this.kernel.unload(this)
  }
}

export interface KernelOptions {
  logger?: Logger
  /** 根作用域（例如单租户部署时的默认租户） */
  scope?: Scope
}

/**
 * Kernel：插件运行时本体，只做三件事——服务注册、事件分发、副作用生命周期。
 * 一般通过 `createLeo()` 使用；需要完全自定义组合时可以直接 `new Kernel()`。
 */
export class Kernel {
  readonly logger: Logger
  readonly bus: EventBus
  readonly root: Context
  private readonly providers = new Map<string, { impl: unknown; owner: PluginRuntime }[]>()
  private readonly runtimes: PluginRuntime[] = []
  private chain: Promise<void> = Promise.resolve()
  private readonly rootRuntime: PluginRuntime

  constructor(opts: KernelOptions = {}) {
    this.logger = opts.logger ?? createConsoleLogger()
    this.bus = new EventBus(this.logger)
    this.rootRuntime = new PluginRuntime(this, { name: 'root', apply() {} }, undefined, undefined)
    this.rootRuntime.state = 'active'
    this.root = new Context(this, this.rootRuntime, undefined, opts.scope ?? {}, this.logger)
    this.rootRuntime.ctx = this.root
  }

  /** 所有已加载插件（诊断用） */
  get plugins(): readonly PluginRuntime[] {
    return this.runtimes
  }

  /** @internal */
  getService(key: string): unknown {
    const list = this.providers.get(key)
    return list?.[list.length - 1]?.impl
  }

  /** @internal */
  addProvider(key: string, impl: unknown, owner: PluginRuntime) {
    if (impl === undefined || impl === null) throw new LeoError('internal', `Cannot provide empty service "${key}"`)
    const list = this.providers.get(key) ?? []
    const replacing = list.length > 0
    list.push({ impl, owner })
    this.providers.set(key, list)
    this.logger.debug({ service: key, plugin: owner.name, replacing }, 'service provided')
    this.serviceChanged(key, owner)
  }

  /** @internal */
  removeProvider(key: string, impl: unknown) {
    const list = this.providers.get(key)
    if (!list) return
    const i = list.findIndex((p) => p.impl === impl)
    if (i < 0) return
    const wasActive = i === list.length - 1
    const [removed] = list.splice(i, 1)
    if (!list.length) this.providers.delete(key)
    if (wasActive && removed) this.serviceChanged(key, removed.owner)
  }

  /** 服务变化：依赖它的活跃插件先撤销再重新 apply；pending 插件尝试启动 */
  private serviceChanged(key: string, owner: PluginRuntime) {
    const dependents = this.runtimes.filter((r) => r.state === 'active' && r !== owner && r.inject.includes(key))
    this.enqueue(async () => {
      for (const r of dependents) {
        if (r.state !== 'active') continue
        this.logger.debug({ plugin: r.name, service: key }, 'dependency changed, restarting plugin')
        await this.deactivate(r)
      }
      await this.retryPending()
    })
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(task).catch((err) => this.logger.error({ err }, 'kernel task failed'))
  }

  /** @internal 加载插件 */
  async load<T>(p: PluginLike<T>, config: T | undefined, parent: Context<any> | undefined): Promise<PluginRuntime> {
    const def = normalizePlugin(p)
    let parsed: unknown = config
    if (def.config) {
      const r = def.config.safeParse(config ?? {})
      if (!r.success) {
        throw new LeoError('plugin_config_invalid', `Invalid config for plugin "${def.name}": ${r.error.message}`, {
          details: { issues: r.error.issues },
        })
      }
      parsed = r.data
    }
    const rt = new PluginRuntime(this, def, parsed, parent)
    this.runtimes.push(rt)
    if (this.depsReady(rt)) await this.activate(rt, true)
    else this.logger.debug({ plugin: def.name, missing: this.missing(rt) }, 'plugin pending on dependencies')
    return rt
  }

  /** @internal 卸载插件 */
  async unload(rt: PluginRuntime) {
    const i = this.runtimes.indexOf(rt)
    if (i >= 0) this.runtimes.splice(i, 1)
    if (rt.ctx) await rt.ctx.dispose()
    rt.ctx = undefined
    rt.state = 'disposed'
  }

  private depsReady(rt: PluginRuntime) {
    return rt.inject.every((k) => this.getService(k) !== undefined)
  }

  private missing(rt: PluginRuntime) {
    return rt.inject.filter((k) => this.getService(k) === undefined)
  }

  private async activate(rt: PluginRuntime, rethrow: boolean) {
    const parentLogger = rt.parent?.logger ?? this.logger
    const ctx = new Context(this, rt, rt.config, rt.parent?.scope ?? this.root.scope, parentLogger.child({ plugin: rt.name }))
    rt.ctx = ctx
    rt.state = 'active'
    try {
      await rt.def.apply(ctx, rt.config)
      this.logger.debug({ plugin: rt.name }, 'plugin applied')
    } catch (err) {
      rt.state = 'failed'
      rt.error = err
      await ctx.dispose()
      rt.ctx = undefined
      this.logger.error({ err, plugin: rt.name }, 'plugin apply failed')
      if (rethrow) throw err
    }
  }

  private async deactivate(rt: PluginRuntime) {
    const ctx = rt.ctx
    rt.ctx = undefined
    rt.state = 'pending'
    if (ctx) await ctx.dispose()
  }

  private async retryPending() {
    let progress = true
    while (progress) {
      progress = false
      for (const rt of [...this.runtimes]) {
        if (rt.state === 'pending' && this.depsReady(rt)) {
          await this.activate(rt, false)
          progress = true
        }
      }
    }
  }

  /**
   * 等待内核稳定（所有服务变化引起的重启都已完成），并检查是否有插件
   * 因依赖缺失仍处于 pending 或启动失败。有则抛出 plugin_unresolved，附带诊断信息。
   */
  async ready(): Promise<void> {
    let last: Promise<void> | undefined
    while (last !== this.chain) {
      last = this.chain
      await last
    }
    const pending = this.runtimes.filter((r) => r.state === 'pending').map((r) => ({ plugin: r.name, missing: this.missing(r) }))
    const failed = this.runtimes.filter((r) => r.state === 'failed').map((r) => ({ plugin: r.name, error: String(r.error) }))
    if (pending.length || failed.length) {
      const desc = [
        ...pending.map((p) => `"${p.plugin}" is missing services: ${p.missing.join(', ')}`),
        ...failed.map((f) => `"${f.plugin}" failed: ${f.error}`),
      ].join('; ')
      throw new LeoError('plugin_unresolved', `Some plugins could not start: ${desc}`, { details: { pending, failed } })
    }
  }

  /** 卸载全部插件（逆序） */
  async dispose(): Promise<void> {
    await this.root.dispose()
    for (const rt of [...this.runtimes].reverse()) await rt.dispose()
  }

  /** 诊断：输出插件树与服务表（类似 `dsh --dump-config`） */
  describe() {
    return {
      plugins: this.runtimes.map((r) => ({ name: r.name, state: r.state, inject: r.inject, parent: r.parent?.runtime.name })),
      services: [...this.providers.entries()].map(([key, list]) => ({
        key,
        provider: list[list.length - 1]?.owner.name,
        shadowed: list.slice(0, -1).map((p) => p.owner.name),
      })),
    }
  }
}
