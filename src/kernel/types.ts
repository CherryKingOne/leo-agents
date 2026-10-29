/**
 * 内核公共类型。
 *
 * ## 用 declaration merging 扩展服务与事件
 *
 * ```ts
 * declare module 'leo-agents' {
 *   interface Services { weather: WeatherService }
 *   interface Events { 'weather/fetched': EventDef<'emit', { city: string }> }
 * }
 * ```
 *
 * 扩展后 `ctx.get('weather')`、`ctx.on('weather/fetched', ...)` 都会获得完整类型。
 */

/** 撤销函数：撤销一次注册（服务、监听器、任意副作用） */
export type Disposer = () => void | Promise<void>

/** 服务表：键 → 服务接口。由各模块通过 declaration merging 扩展。 */
// biome-ignore lint/suspicious/noEmptyInterface: 供 declaration merging 扩展
export interface Services {}

/**
 * 事件分发模式（事件公共契约的一部分，声明后不应随意更改）：
 * - `emit`      通知：调用全部监听器，忽略返回值，监听器异常只记日志，不阻断发布方
 * - `parallel`  并发：并发执行全部监听器并等待，任一失败则抛出
 * - `serial`    串行：按注册顺序依次执行并等待，收集所有非 undefined 返回值
 * - `bail`      闸门：按顺序执行，第一个返回非 undefined 的结果即终止并返回它
 * - `waterfall` 洋葱中间件：`(payload, next) => result`，调用 `next()` 交给下一层，不调用即短路
 */
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

/** 事件定义：模式 + 载荷 + 返回值 */
export interface EventDef<M extends DispatchMode = DispatchMode, P = unknown, R = void> {
  mode: M
  payload: P
  result: R
}

/** 事件表：事件名 → EventDef。由各模块通过 declaration merging 扩展。 */
// biome-ignore lint/suspicious/noEmptyInterface: 供 declaration merging 扩展
export interface Events {}

export type EventName = keyof Events & string
export type EventsOfMode<M extends DispatchMode> = {
  [K in EventName]: Events[K] extends EventDef<M, any, any> ? K : never
}[EventName]

type Def<E extends EventName> = Events[E] extends EventDef<any, infer P, infer R> ? { p: P; r: R } : never
export type PayloadOf<E extends EventName> = Def<E>['p']
export type ResultOf<E extends EventName> = Def<E>['r']

/** waterfall 的 next：可传入改写后的 payload，不传则沿用当前 payload */
export type Next<P, R> = (payload?: P) => Promise<R>

export type Handler<E extends EventName> = Events[E] extends EventDef<'waterfall', infer P, infer R>
  ? (payload: P, next: Next<P, R>) => R | Promise<R>
  : Events[E] extends EventDef<'emit' | 'parallel', infer P, any>
    ? (payload: P) => unknown
    : Events[E] extends EventDef<'serial' | 'bail', infer P, infer R>
      ? (payload: P) => R | undefined | void | Promise<R | undefined | void>
      : never

/** 租户上下文：多租户部署时贯穿所有调用，单租户可不传 */
export interface TenantContext {
  tenantId: string
  plan?: string
  region?: string
  /** 任意策略数据，由权限/配额插件解释 */
  policies?: Record<string, unknown>
}

/** 作用域：fork 子上下文时附加的信息 */
export interface Scope {
  tenant?: TenantContext
  agentId?: string
  sessionId?: string
  [key: string]: unknown
}
