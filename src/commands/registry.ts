import { LeoError, toLeoError } from '../errors.js'
import type { Context } from '../kernel/context.js'
import { definePlugin } from '../kernel/plugin.js'
import type { EventDef } from '../kernel/types.js'
import type { CommandDefinition, CommandResult, CommandService } from './types.js'

declare module '../kernel/types.js' {
  interface Services {
    commands: CommandService
  }
  interface Events {
    /** 插件命令执行后（审计、统计） */
    'commands/executed': EventDef<'emit', { name: string; surface: string; sessionId?: string; isError: boolean }>
  }
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/

class DefaultCommandService implements CommandService {
  private readonly defs: CommandDefinition[] = []

  constructor(private readonly ctx: Context) {}

  register(def: CommandDefinition) {
    const names = [def.name, ...(def.aliases ?? [])]
    for (const n of names) {
      if (!NAME.test(n)) throw new LeoError('invalid_request', `Invalid command name "${n}"`)
      if (this.get(n)) throw new LeoError('internal', `Command "/${n}" is already registered`)
    }
    const entry = { ...def }
    this.defs.push(entry)
    return () => {
      const i = this.defs.indexOf(entry)
      if (i >= 0) this.defs.splice(i, 1)
    }
  }

  get(name: string) {
    return this.defs.find((d) => d.name === name || d.aliases?.includes(name))
  }

  list() {
    return [...this.defs]
  }

  async run(name: string, c: Parameters<CommandService['run']>[1]): Promise<CommandResult | undefined> {
    const def = this.get(name)
    if (!def) return undefined
    const args = c.args.trim()
    let result: CommandResult
    try {
      const r = await def.run({ ...c, args, argv: args ? args.split(/\s+/) : [], ctx: c.ctx ?? this.ctx })
      result = typeof r === 'string' ? { text: r } : (r ?? {})
    } catch (err) {
      result = { text: toLeoError(err).message, isError: true }
    }
    void this.ctx.emit('commands/executed', {
      name: def.name,
      surface: c.surface,
      ...(c.sessionId ? { sessionId: c.sessionId } : {}),
      isError: result.isError === true,
    })
    return result
  }
}

/** 核心插件：提供 `commands` 服务（插件注册斜杠命令，交互式 leo、网关等前端分发） */
export const commandsPlugin = definePlugin({
  name: 'leo:commands',
  apply(ctx) {
    ctx.provide('commands', new DefaultCommandService(ctx))
  },
})
