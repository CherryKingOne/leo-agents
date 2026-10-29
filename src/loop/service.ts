import { definePlugin } from '../kernel/plugin.js'
import { DefaultAgent } from './agent.js'
import type { Agent, AgentLoopService, AgentOptions } from './types.js'

/**
 * 核心插件：提供 `agentLoop` 服务。
 * 依赖 sessions / llm / tools / context 四个服务——任何一个被替换，loop 会自动重启并使用新实现。
 * 想要完全不同的循环（如 plan-and-execute、多 agent 编排）：写一个插件 `ctx.provide('agentLoop', myLoop)` 即可覆盖。
 */
export const agentLoopPlugin = definePlugin({
  name: 'leo:agent-loop',
  inject: ['sessions', 'llm', 'tools', 'context'],
  apply(ctx) {
    const agents = new Map<string, DefaultAgent>()
    const locks = new Set<string>()
    const service: AgentLoopService = {
      create(opts: AgentOptions): Agent {
        const agent = new DefaultAgent(ctx, opts, locks, (a) => agents.delete(a.id))
        agents.set(agent.id, agent)
        return agent
      },
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    }
    ctx.provide('agentLoop', service)
    // 插件卸载（或依赖被替换）时，取消所有进行中的 turn
    void ctx.effect(() => () => {
      for (const a of agents.values()) a.abort('agent loop plugin disposed')
    })
  },
})
