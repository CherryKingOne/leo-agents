# leo-agents

一个从零手写、以“一切皆插件”为核心、可直接商用的 TypeScript Agent 底座。

- **插件内核**（借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) / Cordis）：服务仓库、五种分发模式的类型化事件、可撤销副作用、依赖注入与热重载
- **通用 Agent Loop**：流式输出、并发工具执行、指数退避重试、上下文溢出自动压缩、steer / followUp、取消与超时、步数 / token / 成本预算、会话锁、只追加可回放日志
- **工具管线**：zod 参数校验、策略钩子（allow / deny / ask）、审批服务、单调守卫、超时与重试、结果后处理
- **模型接入即插件**：内置 DeepSeek / OpenAI / 通义 / Kimi / 智谱 / SiliconFlow / OpenRouter / Ollama 预设，任意 OpenAI 兼容端点写个 baseURL 即可；其他协议由插件注册提供方类型
- **`.leo` 配置**：`~/.leo` 与项目 `.leo/` 两级，`credentials.json` 存密钥（支持 `$ENV` / `!command`），配置非法即报错
- **开箱即用的 `leo` 命令行**：交互 / 一次性 / 管道，内置文件、搜索、bash、网页工具，写入与执行默认需确认
- **开发体验**（借鉴 [pi](https://github.com/earendil-works/pi)）：一个函数就是一个插件

我们只做底层；工具、记忆、渠道、编排方式由你用插件拼装，或克隆后自行定制。不过底座本身开箱就能跑、能干活：

```bash
npm install && npm link          # install 时自动构建，link 后得到 leo 命令
chmod +x dist/cli/main.js        # 命令授权
leo auth set deepseek            # 保存密钥到 ~/.leo/credentials.json（或 export DEEPSEEK_API_KEY=...）
cd your-project && leo           # 交互式 Agent：读写文件、搜索、执行命令、抓网页（写入/执行前会询问）
leo -p -y "跑测试，失败就修"       # 一次性执行
leo init                         # 在项目里创建 .leo/config.json，配置模型、插件、工具、预算
leo plugin add sub-agents        # 从官方插件仓库安装插件（leo plugin list 查看全部）
```

在代码里使用同一套配置：

```ts
import { createLeoFromConfig } from 'leo-agents'
const app = await createLeoFromConfig()                 // 读取 ~/.leo 与 ./.leo
console.log((await app.createAgent().run('总结 README.md')).text)
```

完全手动组装（模型接入也是插件）：

```ts
import { createLeo, deepseek, defineTool, z } from 'leo-agents'

const leo = await createLeo({ plugins: [deepseek()] })   // 读取 DEEPSEEK_API_KEY
leo.ctx.get('tools').register(
  defineTool({ name: 'add', description: '两数相加', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }),
)
const agent = leo.createAgent({ model: 'deepseek/deepseek-chat', systemPrompt: '你是一个助手' })
for await (const ev of agent.prompt('2+3 等于几？')) if (ev.type === 'text_delta') process.stdout.write(ev.text)
```

```bash
npm test                  # 45 个用例
npm run example:basic     # 无 API Key 时离线演示
npm run example:plugin    # 插件开发示例
```

📘 开发文档（插件协议、注册方式、扩展点、二次开发）：[docs/development-guide.md](docs/development-guide.md)
📄 架构规划：[docs/architecture-plan.md](docs/architecture-plan.md)
🔎 配置方案调研（DeepSeek Harness / pi）：[docs/config-research.md](docs/config-research.md)
