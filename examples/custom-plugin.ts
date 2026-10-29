/**
 * 插件开发示例：自定义服务 + 工具 + 策略钩子 + prompt 片段 + 计量。
 *
 *   npm run build && npm run example:plugin
 */
import { createLeo, definePlugin, defineTool, MockProvider, z } from 'leo-agents'
import type { Context, EventDef } from 'leo-agents'

// ① 用 declaration merging 声明新服务与新事件，获得完整类型提示
interface KvStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}
declare module 'leo-agents' {
  interface Services {
    kv: KvStore
  }
  interface Events {
    'kv/changed': EventDef<'emit', { key: string; value: string }>
  }
}

// ② 服务提供方插件：provide 的服务在卸载时自动撤销
const kvPlugin = definePlugin({
  name: 'example/kv',
  apply(ctx) {
    const map = new Map<string, string>()
    ctx.provide('kv', {
      get: (k) => map.get(k),
      set: (k, v) => {
        map.set(k, v)
        ctx.emit('kv/changed', { key: k, value: v })
      },
    })
  },
})

// ③ 工具插件：inject 声明依赖，依赖就绪后才 apply
const memoryToolsPlugin = definePlugin({
  name: 'example/memory-tools',
  inject: ['tools', 'kv'],
  config: z.object({ prefix: z.string().default('mem') }),
  apply(ctx, config) {
    const kv = ctx.get('kv')
    void ctx.effect(() =>
      ctx.get('tools').register(
        defineTool({
          name: `${config.prefix}_save`,
          description: '保存一条记忆',
          parameters: z.object({ key: z.string(), value: z.string() }),
          execute: ({ key, value }) => {
            kv.set(key, value)
            return `已保存 ${key}`
          },
        }),
      ),
    )
  },
})

// ④ 函数式（pi 风格）插件：策略、审计、计量
function auditPlugin(ctx: Context) {
  ctx.on('tools/pre-execute', (p, next) => {
    if (JSON.stringify(p.args).includes('password')) return { action: 'deny', reason: '不允许保存密码' }
    return next()
  })
  ctx.on('usage/recorded', (u) => console.log(`[计量] tenant=${u.tenant?.tenantId} in=${u.usage.inputTokens} out=${u.usage.outputTokens}`))
  ctx.on('kv/changed', (e) => console.log(`[审计] kv ${e.key}=${e.value}`))
}
auditPlugin.pluginName = 'example/audit'

// ⑤ prompt 片段插件
const promptPlugin = definePlugin({
  name: 'example/prompt',
  inject: ['context'],
  apply(ctx) {
    void ctx.effect(() =>
      ctx.get('context').registerSection({
        id: 'tenant.brand',
        layer: 'tenant',
        render: (input) => `你代表 ${input.tenant?.tenantId ?? '默认租户'} 为用户服务。`,
      }),
    )
  },
})

const mock = new MockProvider({
  script: [
    { toolCalls: [{ name: 'mem_save', arguments: { key: 'favorite_color', value: 'blue' } }] },
    { text: '记住了，你喜欢蓝色。' },
  ],
})

const leo = await createLeo({
  providers: [mock],
  plugins: [kvPlugin, [memoryToolsPlugin, { prefix: 'mem' }], auditPlugin, promptPlugin],
})

console.log('插件树：', JSON.stringify(leo.describe(), null, 2))

const agent = leo.createAgent({ model: 'mock', systemPrompt: '你是记忆助手。', tenant: { tenantId: 'acme' } })
const result = await agent.run('记住我喜欢蓝色')
console.log('回复：', result.text, '| 结束原因：', result.reason)
console.log('第一次请求的 system prompt：\n', mock.requests[0]?.system)

await leo.dispose()
