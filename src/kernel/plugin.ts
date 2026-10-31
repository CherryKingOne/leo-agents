import type { z } from 'zod'
import type { Context } from './context.js'
import type { Services } from './types.js'

/** 可被 inject 的服务键（已声明的键有自动补全，也允许任意字符串） */
export type ServiceKey = (keyof Services & string) | (string & {})

/**
 * 插件定义（写法 A，Cordis/DSH 风格）。
 *
 * ```ts
 * export default definePlugin({
 *   name: 'weather',
 *   inject: ['tools'],                       // 依赖的服务全部就绪后才会 apply
 *   config: z.object({ apiKey: z.string() }), // 可选：配置 schema，加载时校验
 *   apply(ctx, config) {
 *     ctx.get('tools').register(...)          // 所有注册都会在卸载时自动撤销
 *   },
 * })
 * ```
 */
export interface PluginDefinition<C = any> {
  /** 插件名，建议使用 `scope/name` 或 `leo-plugin-xxx` 形式，用于日志与诊断 */
  name: string
  /** 依赖的服务键。任一服务缺失时插件处于 pending；服务被替换时插件会自动重新 apply */
  inject?: readonly ServiceKey[]
  /** 配置 schema（zod）。加载时 parse，失败抛出 plugin_config_invalid */
  config?: z.ZodType<C>
  /**
   * 热重载时要关注的数据文件（相对 `.leo/` 的路径，以 `/` 结尾表示目录），如 `['mcp-servers.json']`、`['agents/']`。
   * 宿主（createLeoFromConfig）会同时监听 `~/.leo/` 与项目 `.leo/` 下的这些路径，变化时重新加载本插件。
   * 只用 createLeo 手动组装时不生效。
   */
  watch?: readonly string[]
  /** 插件入口：在这里注册服务、监听事件、注册工具等 */
  apply(ctx: Context<C>, config: C): void | Promise<void>
}

/**
 * 函数式插件（写法 B，pi 风格）：一个函数就是一个插件。
 * 可以挂 `pluginName` / `inject` 静态属性；默认 inject 为空，函数内部可用 `ctx.get()` 取服务。
 */
export type FunctionPlugin<C = any> = ((ctx: Context<C>, config: C) => void | Promise<void>) & {
  pluginName?: string
  inject?: readonly ServiceKey[]
  watch?: readonly string[]
}

export type PluginLike<C = any> = PluginDefinition<C> | FunctionPlugin<C> | { default: PluginDefinition<C> | FunctionPlugin<C> }

/** 类型辅助：定义插件（原样返回，只做类型推导） */
export function definePlugin<C = undefined>(def: PluginDefinition<C>): PluginDefinition<C> {
  return def
}

let anonymous = 0

/** 把三种写法统一规范化为 PluginDefinition */
export function normalizePlugin<C>(p: PluginLike<C>): PluginDefinition<C> {
  const target = (typeof p === 'object' && p !== null && 'default' in p ? p.default : p) as
    | PluginDefinition<C>
    | FunctionPlugin<C>
  if (typeof target === 'function') {
    const fn = target
    const def: PluginDefinition<C> = {
      name: fn.pluginName ?? (fn.name || `anonymous-plugin-${++anonymous}`),
      apply: (ctx, config) => fn(ctx, config),
    }
    if (fn.inject) def.inject = fn.inject
    if (fn.watch) def.watch = fn.watch
    return def
  }
  if (!target || typeof target.apply !== 'function' || typeof target.name !== 'string') {
    throw new TypeError('Invalid plugin: expected { name, apply } or a function')
  }
  return target
}
