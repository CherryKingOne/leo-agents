import type { Context } from '../kernel/context.js'
import type { Disposer } from '../kernel/types.js'
import type { DisplayBlock } from '../protocol/display.js'
import type { UserInput } from '../protocol/messages.js'

/** 命令执行时的上下文 */
export interface CommandContext {
  /** 命令名之后的原始参数（已去掉首尾空白） */
  args: string
  /** 按空白切分的参数 */
  argv: string[]
  /** 当前会话（交互式 leo、网关的聊天会话），没有时为 undefined */
  sessionId?: string
  /** 调用来源：'cli' | 'gateway' | 其他前端自定义 */
  surface: string
  /** 来源方的用户标识（网关里是平台用户 id） */
  userId?: string
  signal?: AbortSignal
  ctx: Context
}

/** 命令结果。返回字符串等价于 `{ text }` */
export interface CommandResult {
  /** 给用户看的文字 */
  text?: string
  /** 给用户看的展示块（表情、图片、字符画） */
  display?: DisplayBlock[]
  isError?: boolean
  /** 作为用户消息发给当前 Agent，开始一轮对话（例如用户发了一个表情，让模型接话） */
  prompt?: UserInput
}

/** 插件注册的斜杠命令：人触发、不经过模型 */
export interface CommandDefinition {
  /** 不含斜杠，`^[a-z][a-z0-9_-]{0,31}$` */
  name: string
  aliases?: string[]
  description?: string
  /** 参数提示，例如 `<id> [black]` */
  usage?: string
  /** 注册它的插件名（展示用，注册时自动填写） */
  plugin?: string
  run(c: CommandContext): CommandResult | string | void | Promise<CommandResult | string | void>
}

export interface CommandService {
  register(def: CommandDefinition): Disposer
  /** 按名字或别名查找 */
  get(name: string): CommandDefinition | undefined
  list(): CommandDefinition[]
  /** 执行命令；没有这个命令时返回 undefined，命令抛错时返回 isError 结果 */
  run(name: string, c: Omit<CommandContext, 'argv' | 'ctx'> & { ctx?: Context }): Promise<CommandResult | undefined>
}
