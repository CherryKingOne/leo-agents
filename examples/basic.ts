/**
 * 最小示例：一个带工具的 Agent，流式输出（MockProvider 离线演示）。
 *
 *   npm run build && npm run example:basic
 *
 * 底座不内置任何模型厂商。接真实模型：装模型供应商插件（leo-plugin 的 provider + provider-deepseek），
 * 或者用 createLeoFromConfig() 读取 ~/.leo 里已安装的插件；也可以自己实现 LlmProvider 再 providerPlugin(p) 挂上去。
 */
import { createLeo, defineTool, MockProvider, z } from 'leo-agents'
import type { LlmProvider } from 'leo-agents'

const provider: LlmProvider = new MockProvider({
  id: 'remote',
  script: [
    { text: '我来查一下时间。', toolCalls: [{ name: 'current_time', arguments: { timezone: 'Asia/Shanghai' } }] },
    (req) => ({ text: `现在上海时间是 ${JSON.stringify(req.messages.at(-1)?.content)}（离线演示）。` }),
  ],
})

const leo = await createLeo({ providers: [provider], logLevel: 'warn' })

leo.ctx.get('tools').register(
  defineTool({
    name: 'current_time',
    description: '获取指定时区的当前时间',
    parameters: z.object({ timezone: z.string().describe('IANA 时区，例如 Asia/Shanghai') }),
    execute: ({ timezone }) => new Date().toLocaleString('zh-CN', { timeZone: timezone }),
  }),
)

const agent = leo.createAgent({
  model: 'remote/demo',
  systemPrompt: '你是一个简洁的中文助手。需要时调用工具。',
  limits: { maxSteps: 10, turnTimeoutMs: 120_000 },
})

for await (const ev of agent.prompt('现在上海几点了？')) {
  switch (ev.type) {
    case 'text_delta':
      process.stdout.write(ev.text)
      break
    case 'tool_start':
      process.stdout.write(`\n[调用工具 ${ev.call.name} ${ev.call.rawArguments}]\n`)
      break
    case 'tool_result':
      process.stdout.write(`[工具结果] ${JSON.stringify(ev.result.content)}\n`)
      break
    case 'retry':
      process.stdout.write(`\n[重试 #${ev.attempt}，${ev.delayMs}ms 后：${ev.error.message}]\n`)
      break
    case 'turn_end':
      process.stdout.write(`\n\n结束原因=${ev.reason} 步数=${ev.steps} tokens=${ev.usage.inputTokens}/${ev.usage.outputTokens}\n`)
      break
  }
}

await leo.dispose()
