/**
 * 最小示例：一个带工具的 Agent，流式输出。
 *
 *   npm run build
 *   DEEPSEEK_API_KEY=sk-xxx npm run example:basic      # 真实模型（任意 OpenAI 兼容端点）
 *   npm run example:basic                              # 未设置 key 时使用 MockProvider 离线演示
 *
 * 可用环境变量：LEO_BASE_URL（默认 https://api.deepseek.com/v1）、LEO_MODEL（默认 deepseek-chat）
 */
import { createLeo, defineTool, MockProvider, OpenAICompatibleProvider, z } from 'leo-agents'
import type { LlmProvider } from 'leo-agents'

const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LEO_API_KEY
const provider: LlmProvider = apiKey
  ? new OpenAICompatibleProvider({
      id: 'remote',
      baseURL: process.env.LEO_BASE_URL ?? 'https://api.deepseek.com/v1',
      apiKey,
      models: [{ id: process.env.LEO_MODEL ?? 'deepseek-chat', contextWindow: 128_000 }],
    })
  : new MockProvider({
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
  model: `remote/${process.env.LEO_MODEL ?? 'deepseek-chat'}`,
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
