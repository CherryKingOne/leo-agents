# leo-agents

一个从零手写、以“一切皆插件”为核心、可直接商用的 TypeScript Agent 底座。

- **插件内核**（借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) / Cordis）：服务仓库、五种分发模式的类型化事件、可撤销副作用、依赖注入与热重载
- **通用 Agent Loop**：流式输出、并发工具执行、指数退避重试、上下文溢出自动压缩、steer / followUp、取消与超时、步数 / token / 成本预算、会话锁、只追加可回放日志
- **工具管线**：zod 参数校验、策略钩子（allow / deny / ask）、审批服务、单调守卫、超时与重试、结果后处理
- **模型接入**：OpenAI 兼容 Provider（OpenAI、DeepSeek、通义、Kimi、vLLM、SGLang、leo-inference……）+ 可测试的 MockProvider
- **开发体验**（借鉴 [pi](https://github.com/earendil-works/pi)）：一个函数就是一个插件

我们只做底层；工具、记忆、渠道、编排方式由你用插件拼装，或克隆后自行定制。

```ts
import { createLeo, defineTool, OpenAICompatibleProvider, z } from 'leo-agents'

const leo = await createLeo({
  providers: [new OpenAICompatibleProvider({ id: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' })],
})
leo.ctx.get('tools').register(
  defineTool({ name: 'add', description: '两数相加', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }),
)
const agent = leo.createAgent({ model: 'deepseek/deepseek-chat', systemPrompt: '你是一个助手' })
for await (const ev of agent.prompt('2+3 等于几？')) if (ev.type === 'text_delta') process.stdout.write(ev.text)
```

```bash
npm install && npm test && npm run build
npm run example:basic     # 无 API Key 时离线演示
npm run example:plugin    # 插件开发示例
```

📘 开发文档（插件协议、注册方式、扩展点、二次开发）：[docs/development-guide.md](docs/development-guide.md)
📄 架构规划：[docs/architecture-plan.md](docs/architecture-plan.md)
