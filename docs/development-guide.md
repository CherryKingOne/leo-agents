# leo-agents 开发文档

> 适用版本：v0.1 · 运行环境：Node.js ≥ 22 · 语言：TypeScript（ESM）

leo-agents 只做**底座**：一个插件内核 + 一个可直接商用的通用 Agent Loop。
具体业务（工具、记忆、渠道、编排方式……）由你通过插件拼装，或者克隆仓库后直接改源码定制。

---

## 目录

1. [快速开始](#1-快速开始)
2. [整体架构](#2-整体架构)
3. [插件协议](#3-插件协议)
4. [服务：注册、获取、替换](#4-服务注册获取替换)
5. [事件与钩子](#5-事件与钩子)
6. [开发工具（Tool）](#6-开发工具tool)
7. [接入模型（Provider）](#7-接入模型provider)
8. [上下文与提示词](#8-上下文与提示词)
9. [Agent Loop 详解](#9-agent-loop-详解)
10. [会话日志与存储](#10-会话日志与存储)
11. [替换核心模块](#11-替换核心模块)
12. [克隆后二次开发](#12-克隆后二次开发)
13. [测试](#13-测试)
14. [生产部署清单](#14-生产部署清单)
15. [错误码](#15-错误码)
16. [事件目录](#16-事件目录)

---

## 1. 快速开始

```bash
git clone https://github.com/CherryKingOne/leo-agents.git
cd leo-agents
npm install
npm test              # 36 个用例，覆盖内核、loop、工具管线、OpenAI 适配器、会话存储
npm run build
npm run example:basic # 未设置 API Key 时用 MockProvider 离线演示
DEEPSEEK_API_KEY=sk-xxx npm run example:basic
```

最小代码：

```ts
import { createLeo, defineTool, OpenAICompatibleProvider, z } from 'leo-agents'

const leo = await createLeo({
  providers: [
    new OpenAICompatibleProvider({
      id: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat', contextWindow: 128_000, pricing: { inputPerMTok: 0.27, outputPerMTok: 1.1 } }],
    }),
  ],
})

leo.ctx.get('tools').register(
  defineTool({
    name: 'add',
    description: '两数相加',
    parameters: z.object({ a: z.number(), b: z.number() }),
    execute: ({ a, b }) => String(a + b),
  }),
)

const agent = leo.createAgent({ model: 'deepseek/deepseek-chat', systemPrompt: '你是一个助手' })

// 流式
for await (const ev of agent.prompt('2+3 等于几？')) {
  if (ev.type === 'text_delta') process.stdout.write(ev.text)
}

// 非流式
const r = await agent.run('再加 10 呢？')   // 同一个 agent = 同一个会话，自动带上历史
console.log(r.text, r.reason, r.usage)
```

> 价格数字仅为示例，请按厂商官网填写。

---

## 2. 整体架构

```
┌──────────────────────── 你的应用（CLI / HTTP 服务 / Bot） ────────────────────────┐
│  createLeo({ providers, plugins })  →  leo.createAgent()  →  agent.prompt()          │
└───────────────────────────────────────────────────────────────────────────────────────┘
┌────────────── 核心插件（全部可替换） ──────────────┐   ┌──────── 你的插件 ────────┐
│ leo:sessions   → ctx.get('sessions')  会话日志      │   │ 工具 / Provider / 记忆   │
│ leo:llm        → ctx.get('llm')       模型接缝      │   │ 策略 / 审批 / 计量       │
│ leo:tools      → ctx.get('tools')     工具管线      │   │ Prompt 片段 / 压缩策略   │
│ leo:context    → ctx.get('context')   上下文构建    │   │ 替换任何核心服务         │
│ leo:agent-loop → ctx.get('agentLoop') 通用 Loop     │   └──────────────────────────┘
└─────────────────────────────────────────────────────┘
┌────────────────────────────── Kernel（src/kernel） ──────────────────────────────┐
│  服务仓库 provide/get · 类型化事件（5 种分发模式）· 可撤销副作用 · 插件树/依赖注入 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

源码目录：

| 目录 | 内容 |
|---|---|
| `src/kernel/` | 插件运行时：`Kernel`、`Context`、`EventBus`、`definePlugin` |
| `src/protocol/` | 厂商无关的消息类型 `AgentMessage`、`ContentBlock`、`Usage` |
| `src/llm/` | `LlmService`、`LlmProvider` 接口、`OpenAICompatibleProvider`、`MockProvider` |
| `src/session/` | 只追加会话日志：`InMemorySessionStore`、`FileSessionStore`、`deriveMessages` |
| `src/tools/` | `defineTool`、工具注册表、执行管线（预检 → 审批 → 守卫 → 执行 → 后处理） |
| `src/context/` | system prompt 分层组装、token 预算、压缩策略、消息修复 |
| `src/loop/` | `DefaultAgent`：通用 Agent Loop |
| `src/leo.ts` | `createLeo()`：把内核和核心插件组装起来 |

设计原则（来自 `docs/architecture-plan.md`）：**一切皆插件**；**插件之间只通过服务键协作**；**模型可见即已记录**；**默认安全（失败即关闭）**；**租户上下文贯穿全链路**。

---

## 3. 插件协议

### 3.1 两种写法

**写法 A：`definePlugin`（推荐用于正式插件）**

```ts
import { definePlugin, defineTool, z } from 'leo-agents'

export default definePlugin({
  name: 'acme/weather',                 // 唯一名称，用于日志与诊断
  inject: ['tools'],                    // 依赖的服务；全部就绪后才会调用 apply
  config: z.object({                    // 可选：配置 schema，加载时校验
    apiKey: z.string(),
    units: z.enum(['metric', 'imperial']).default('metric'),
  }),
  async apply(ctx, config) {            // 插件入口
    await ctx.effect(() =>
      ctx.get('tools').register(defineTool({ /* ... */ })),
    )
    ctx.on('usage/recorded', (u) => { /* ... */ })
  },
})
```

**写法 B：函数式（pi 风格，适合小扩展/本地脚本）**

```ts
import type { Context } from 'leo-agents'

export default function myExtension(ctx: Context) {
  ctx.on('tools/pre-execute', (p, next) => {
    if (p.call.name === 'shell' && /rm\s+-rf/.test(JSON.stringify(p.args))) {
      return { action: 'deny', reason: '危险命令已拦截' }
    }
    return next()
  })
}
myExtension.pluginName = 'acme/guard'   // 可选
myExtension.inject = ['tools']          // 可选
```

两种写法由同一个运行时加载：函数式插件会被规范化为 `{ name, inject, apply }`。

### 3.2 插件字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 插件名。建议 `scope/name` 或 `leo-plugin-xxx` |
| `inject` | 否 | 依赖的服务键数组。缺任何一个，插件处于 `pending`；服务被替换时插件会**自动撤销并重新 apply** |
| `config` | 否 | zod schema。加载时 `safeParse`，失败抛 `plugin_config_invalid` |
| `apply(ctx, config)` | 是 | 入口。可以是 async。抛异常时插件进入 `failed`，已做的注册会被撤销 |

### 3.3 生命周期

```
load ─▶ 校验 config ─▶ 依赖就绪？──否──▶ pending（等待服务出现）
                          │是
                          ▼
                  创建 Context ─▶ apply(ctx, config) ─▶ active
                                         │抛异常
                                         ▼
                                   failed（撤销已注册内容）

active ─▶ 依赖服务被替换/移除 ─▶ 撤销全部副作用 ─▶ pending ─▶（依赖再次可用）重新 apply
active ─▶ dispose() ─▶ ctx.signal abort ─▶ LIFO 撤销所有注册与子插件 ─▶ disposed
```

**关键规则：凡是通过 `ctx` 做的注册（`provide`、`on`、`effect`、`plugin`、`fork`）都会记入撤销栈。**
所以插件不需要写清理代码——卸载、热重载、依赖替换时内核会按注册的逆序自动撤销。

服务自身的注册方法（如 `tools.register()`、`llm.registerProvider()`、`context.registerSection()`）返回一个撤销函数，
**请包在 `ctx.effect()` 里**，这样它们也会被自动撤销：

```ts
await ctx.effect(() => ctx.get('tools').register(myTool))
```

### 3.4 加载插件

```ts
// 启动时
const leo = await createLeo({
  providers: [...],
  plugins: [
    weatherPlugin,                              // 无配置
    [weatherPlugin, { apiKey: process.env.W }], // 带配置
    myExtension,                                // 函数式
  ],
})

// 运行时（热加载）
const runtime = await leo.plugin(anotherPlugin, { foo: 1 })
await runtime.dispose()                         // 热卸载，自动撤销全部注册

// 插件内加载子插件（随父插件一起卸载）
apply(ctx) { await ctx.plugin(childPlugin) }

// 诊断：插件状态与服务提供者（谁覆盖了谁）
console.log(leo.describe())
```

`createLeo` 结束前会调用 `kernel.ready()`：如果有插件因为依赖缺失仍是 `pending`，或启动失败，会抛出
`plugin_unresolved` 并列出缺失的服务，避免“静默不生效”。

### 3.5 Context API 一览

| 方法 | 说明 |
|---|---|
| `ctx.provide(key, impl)` | 注册服务。同键后注册者生效，撤销后回退到上一个 |
| `ctx.get(key)` | 获取服务，缺失抛 `service_missing` |
| `ctx.maybe(key)` / `ctx.has(key)` | 获取可选服务 / 判断是否存在 |
| `ctx.on(event, handler, { prepend })` | 注册事件监听 |
| `ctx.emit / parallel / serial / bail / waterfall` | 分发事件（见第 5 节） |
| `ctx.effect(setup)` | 注册任意副作用，`setup` 返回撤销函数 |
| `ctx.plugin(p, config)` | 加载子插件 |
| `ctx.fork({ tenant, agentId, sessionId })` | 派生作用域子上下文 |
| `ctx.tenant` / `ctx.scope` | 当前租户 / 作用域 |
| `ctx.signal` | 插件卸载时 abort，长任务要监听 |
| `ctx.logger` | 带插件名的结构化日志 |

### 3.6 发布插件包

插件包就是一个普通 npm 包，默认导出插件：

```jsonc
{
  "name": "@acme/leo-plugin-weather",
  "type": "module",
  "keywords": ["leo-plugin"],
  "exports": "./dist/index.js",
  "peerDependencies": { "leo-agents": "^0.1.0" }   // 宿主包必须写在 peerDependencies，避免出现两份内核
}
```

使用方：`import weather from '@acme/leo-plugin-weather'`，然后放进 `plugins`。
（`leo install` 命令、manifest 中的权限声明、签名校验属于规划中的 M2/M4，见架构文档。）

---

## 4. 服务：注册、获取、替换

### 4.1 声明服务类型（declaration merging）

```ts
// my-plugin/types.ts
export interface KvStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

declare module 'leo-agents' {
  interface Services {
    kv: KvStore
  }
}
```

声明后，`ctx.get('kv')`、`ctx.provide('kv', ...)`、`inject: ['kv']` 都有类型检查与补全。
未声明的键也能用（类型为 `unknown`），但强烈建议声明。

### 4.2 提供与消费

```ts
const kvPlugin = definePlugin({
  name: 'acme/kv-redis',
  config: z.object({ url: z.string() }),
  async apply(ctx, { url }) {
    const client = await connect(url)
    await ctx.effect(() => () => client.quit())  // 卸载时关闭连接
    ctx.provide('kv', { get: (k) => client.get(k), set: (k, v) => client.set(k, v) })
  },
})

const consumer = definePlugin({
  name: 'acme/uses-kv',
  inject: ['kv'],                // kv 就绪前不会 apply；kv 被替换时自动重启
  apply(ctx) {
    const kv = ctx.get('kv')
  },
})
```

> **原则**：插件之间只通过服务键协作，**不要 import 另一个插件的实现**。需要共享的只有类型。

### 4.3 核心服务

| 键 | 接口 | 默认实现 |
|---|---|---|
| `sessions` | `SessionStore` | `InMemorySessionStore`（`createLeo({ sessions: { dir } })` 用 `FileSessionStore`） |
| `llm` | `LlmService` | 多 Provider 注册表 + `llm/stream` 中间件 |
| `tools` | `ToolRegistry` | `DefaultToolRegistry` |
| `context` | `ContextService` | 分层 prompt + token 预算 + 压缩 |
| `agentLoop` | `AgentLoopService` | `DefaultAgent` |
| `approval`（可选） | `ApprovalService` | 无（未提供时 `ask` 决策一律拒绝） |

---

## 5. 事件与钩子

### 5.1 五种分发模式

分发模式是事件契约的一部分，写在事件声明里：

| 模式 | 监听器签名 | 语义 | 典型用途 |
|---|---|---|---|
| `emit` | `(payload) => void` | 通知，不等待；异常只记日志 | 审计、日志、推送 |
| `parallel` | `(payload) => Promise` | 并发执行并等待，任一失败则抛出 | 并行预热 |
| `serial` | `(payload) => R \| undefined` | 依次执行，收集非 undefined 结果 | 收集投票 |
| `bail` | `(payload) => R \| undefined` | 第一个非 undefined 结果即返回 | 守卫、拦截 |
| `waterfall` | `(payload, next) => R` | 洋葱中间件：调 `next(p?)` 进入下一层，不调即短路 | 策略、改写、包裹 |

waterfall 示例（计时中间件）：

```ts
ctx.on('tools/execute', async (p, next) => {
  const t = Date.now()
  try { return await next() }               // 也可以 next({ ...p, args: newArgs }) 改写入参
  finally { metrics.observe(p.tool.name, Date.now() - t) }
})
```

### 5.2 声明自定义事件

```ts
import type { EventDef } from 'leo-agents'

declare module 'leo-agents' {
  interface Events {
    'kv/changed': EventDef<'emit', { key: string; value: string }>
    'order/validate': EventDef<'waterfall', Order, ValidationResult>
  }
}

ctx.emit('kv/changed', { key: 'a', value: 'b' })
const result = await ctx.waterfall('order/validate', order, (o) => defaultValidate(o))
```

完整的内置事件列表见[第 16 节](#16-事件目录)。

---

## 6. 开发工具（Tool）

### 6.1 定义

```ts
import { defineTool, toolOutput, z } from 'leo-agents'

export const readFile = defineTool({
  name: 'fs_read',                                   // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
  description: '读取工作区内的文本文件。路径相对于工作区根目录。',
  parameters: z.object({
    path: z.string().describe('相对路径'),
    maxBytes: z.number().int().positive().default(100_000),
  }),
  permissions: [{ kind: 'fs.read', paths: ['${workspace}/**'] }], // 供权限插件裁决
  executionMode: 'parallel',     // 'sequential'：本批有它则整批串行
  timeoutMs: 30_000,             // 默认 120s
  idempotent: true,              // 幂等工具可自动重试
  maxRetries: 2,
  tags: ['fs'],                  // 按场景筛选工具集
  async execute({ path, maxBytes }, exec) {
    exec.onUpdate({ status: 'reading' })            // 流式进度 → AgentEvent tool_update
    const text = await fs.readFile(resolve(path), { encoding: 'utf8', signal: exec.signal })  // 必须遵守 signal
    if (!text) return toolOutput({ content: '文件为空', isError: true })
    return text.slice(0, maxBytes)
  },
})
```

- `parameters` 用 zod 时：自动生成 JSON Schema 给模型，执行前自动校验，校验失败把**可读的错误**回给模型让它自我修正。
  也可以直接给 JSON Schema 对象（此时不做校验）。
- 返回值：字符串原样；对象自动 `JSON.stringify`；需要 `isError` / `terminate` / `details` 时用 `toolOutput()`。
- **业务失败**（文件不存在）→ `toolOutput({ isError: true })` 或直接 `throw`；两者都会变成模型可见的错误结果，不会让 loop 崩溃。
- `terminate: true`：本批所有工具都 terminate 时，loop 不再请求模型，直接以 `terminated_by_tool` 结束（适合“提交答案”类工具）。
- `render(value, args)`：自定义给模型看的内容（例如只给摘要，完整数据放 `details`）。
- 超长输出会按 `maxOutputChars`（默认 50k 字符）截断。

### 6.2 注册

```ts
// 在插件里（推荐，卸载自动撤销）
definePlugin({
  name: 'acme/fs-tools',
  inject: ['tools'],
  async apply(ctx) {
    await ctx.effect(() => ctx.get('tools').register(readFile))
  },
})

// 或者直接在应用里
leo.ctx.get('tools').register(readFile)
```

### 6.3 控制暴露给模型的工具

```ts
leo.createAgent({ model, tools: { tags: ['fs'] } })      // 只暴露带 fs 标签的
leo.createAgent({ model, tools: { names: ['fs_read'] } })
leo.createAgent({ model, tools: false })                 // 不使用工具
leo.createAgent({ model, sequentialTools: true })        // 强制串行
```

### 6.4 执行管线

```
assistant 产出 tool calls
  └─ 阶段一（串行，保证审批顺序）：
       查找工具（不存在 → tool_not_found）
       解析 JSON + zod 校验（失败 → tool_invalid_args）
       tools/pre-execute  waterfall → allow（可改写 args）/ deny / ask
       ask → approval 服务（未配置 → 拒绝，fail closed）
       tools/guard        bail      → 任一 { deny } 即拒绝（不可被后续撤销的安全底线）
  └─ 阶段二（默认并发，上限 8）：
       tools/execute      waterfall → 包裹实际执行（超时 / 重试 / 限流 / 指标 / 沙箱代理）
       tool.execute(args, exec)     （超时或取消时即使工具不理睬 signal 也会及时返回）
       tools/post-execute waterfall → 脱敏 / 截断 / 替换结果
  └─ 结果按 assistant 原始顺序写回会话
```

权限插件示例：

```ts
definePlugin({
  name: 'acme/policy',
  apply(ctx) {
    ctx.on('tools/pre-execute', (p, next) => {
      const needsWrite = p.tool.permissions?.some((x) => x.kind === 'fs.write')
      if (needsWrite && p.tenant?.plan === 'free') return { action: 'deny', reason: '免费版不允许写文件' }
      if (needsWrite) return { action: 'ask', reason: '写文件需要确认' }
      return next()
    })
    ctx.provide('approval', {
      async request(req, signal) {
        const ok = await askHumanInSlack(req, signal)   // 你的审批实现
        return { approved: ok }
      },
    })
  },
})
```

---

## 7. 接入模型（Provider）

### 7.1 OpenAI 兼容端点（开箱即用）

```ts
new OpenAICompatibleProvider({
  id: 'deepseek',                         // 模型前缀：'deepseek/deepseek-chat'
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',          // 或 apiKey（不推荐明文）
  models: [{ id: 'deepseek-chat', contextWindow: 128_000, maxOutputTokens: 8192, pricing: { inputPerMTok: 0.27, outputPerMTok: 1.1, cachedInputPerMTok: 0.07 } }],
  connectTimeoutMs: 60_000,               // 等待响应头
  idleTimeoutMs: 120_000,                 // 两个流分片间最大间隔
  maxTokensField: 'max_tokens',           // OpenAI 新模型可改为 'max_completion_tokens'
  sendReasoning: false,                   // 是否把历史 reasoning 以 reasoning_content 回传
  headers: { /* 额外请求头 */ },
})
```

适用：OpenAI、DeepSeek、通义千问、Kimi、智谱、OpenRouter、vLLM、SGLang、leo-inference 等。
已处理：SSE 跨块解析、`reasoning_content`、流式 tool call 拼接、usage（含缓存命中）、`Retry-After`、
`insufficient_quota` 不重试、上下文超长识别为 `context_overflow`、连接/空闲超时。

多个 Provider 同时注册，按前缀路由；`providers` 数组中第一个为默认（不带前缀的模型名走默认）。

### 7.2 自定义 Provider

实现 `LlmProvider`：

```ts
import { LeoError, providerPlugin, type LlmProvider } from 'leo-agents'

class MyProvider implements LlmProvider {
  readonly id = 'my'
  async *stream(req, { signal }) {
    const res = await callMyApi(req, signal)          // 必须遵守 signal
    if (res.status === 429) throw new LeoError('rate_limit', 'slow down', { retryAfterMs: 1000 })
    for await (const chunk of res) {
      yield { type: 'text_delta', text: chunk.text }
      // 工具调用：yield { type: 'tool_call_delta', index, id, name, argumentsDelta }
    }
    yield { type: 'usage', usage: { inputTokens, outputTokens } }   // 以最后一次为准
    yield { type: 'done', finishReason: 'stop' }                      // 必须
  }
  countTokens(req) { /* 可选：精确计数 */ }
  getModelInfo(model) { return { id: model, contextWindow: 200_000 } }  // 可选
}

// 作为插件分发
export default providerPlugin(new MyProvider())
```

**错误码很重要**：loop 依据 `LeoError.code` 决定是否重试（`rate_limit` / `overloaded` / `timeout` / `network`）、
是否压缩后重试（`context_overflow`）、还是直接失败（`auth` / `invalid_request`）。

### 7.3 模型调用中间件

所有模型调用都经过 `llm/stream` waterfall，可用来做路由、降级、缓存、审计、脱敏：

```ts
ctx.on('llm/stream', async (p, next) => {
  const redacted = { ...p, request: redact(p.request) }
  return next(redacted)
})
```

---

## 8. 上下文与提示词

### 8.1 构建流程

每个 step 都会重新构建上下文：

```
会话日志 ─▶ deriveMessages（应用压缩）
        ─▶ context/transform waterfall（注入记忆召回 / RAG / 裁剪）
        ─▶ context/convert   waterfall（自定义角色 → 标准消息；默认丢弃非标准角色与 meta.hidden）
        ─▶ sanitizeMessages（补齐缺失的工具结果、丢弃孤立工具消息，保证厂商不报错）
        ─▶ token 预算：超过 (窗口 - 输出预留) × 0.85 → 压缩策略
        ─▶ 仍超硬上限 → 从最旧的轮次丢弃（只在用户消息边界切，不拆工具调用对）
        ─▶ 组装 system + messages + tools，计算 fingerprint
```

### 8.2 Prompt 分层片段

```ts
await ctx.effect(() =>
  ctx.get('context').registerSection({
    id: 'platform.safety',
    layer: 'platform',            // platform → tenant → agent → task → runtime
    priority: 10,                 // 同层升序
    render: (input) => '安全底线：……',   // 返回 undefined 表示本次不注入
  }),
)
```

稳定内容放前面的层（platform / tenant），易变内容放 runtime 层，有利于厂商 prompt cache 命中。
`AgentOptions.systemPrompt` 自动作为 `agent` 层片段。`render` 可读取 `input.tenant`、`input.state`、`input.model` 等。

### 8.3 记忆 / RAG 注入

```ts
ctx.on('context/transform', async ({ messages, input }, next) => {
  const last = messages.at(-1)
  const memories = await ctx.get('memory').recall(input.sessionId, textOf(last?.content ?? []))
  const note = { id: 'mem', role: 'user', content: [{ type: 'text', text: `相关记忆：\n${memories}` }], createdAt: Date.now(), meta: { injected: true } }
  return next({ messages: [...messages.slice(0, -1), note, last!], input })
})
```

### 8.4 压缩策略

默认 `truncate`：丢弃较早消息并放一条说明（零额外成本）。可换成摘要式：

```ts
import { createSummarizingStrategy } from 'leo-agents'

definePlugin({
  name: 'acme/summarize',
  inject: ['context', 'llm'],
  async apply(ctx) {
    await ctx.effect(() =>
      ctx.get('context').setCompactionStrategy(createSummarizingStrategy(ctx, { model: 'deepseek/deepseek-chat' })),
    )
  },
})
```

或实现 `CompactionStrategy { name, compact({ messages, sessionId, model, signal }) → AgentMessage }`。
压缩结果写入会话日志的 `compaction` 事件，**原始消息不删除**（审计可查），只是在投影中被摘要替代。

预算参数：`createLeo({ context: { defaultContextWindow, reserveOutputTokens, softLimitRatio, keepRecentTurns } })`。

### 8.5 默认提示词（人设）

`createLeo` 默认加载 `promptsPlugin`，把仓库根目录 `prompts/*.md` 注册成 platform / runtime 层片段：

| 文件 | id | 层 | 内容 |
|---|---|---|---|
| `10-identity.md` | `platform.identity` | platform | 人设：身份、性格、诚实原则 |
| `20-behavior.md` | `platform.behavior` | platform | 工作方式：理解需求、何时澄清、如何汇报 |
| `30-tool-use.md` | `platform.tool-use` | platform | 工具使用规范（`when: tools`，无工具时不注入） |
| `40-safety.md` | `platform.safety` | platform | 安全底线（含提示词注入防护） |
| `50-output.md` | `platform.output` | platform | 输出格式与语言 |
| `90-runtime.md` | `runtime.environment` | runtime | 当前日期、时区、模型 |

最终 system prompt 顺序：**内置 platform 片段 → 你的 tenant 片段 → `AgentOptions.systemPrompt`（agent 层，写业务角色）→ task → runtime**。

文件格式是 frontmatter + 正文，正文支持 `{{var}}` 与条件块 `{{#var}}…{{/var}}`：

```md
---
id: platform.identity     # 与内置同 id 即覆盖
layer: platform
priority: 10
when: tools               # 可选
---
你是 {{assistantName}}……
```

变量优先级：`agent.state` > `prompts.vars` > 内置（`assistantName`=Leo、`organization`、`language`、`date`、`timezone`、`model`、`agentId`、`sessionId`、`tenantId`）。

定制方式（任选）：

```ts
// 1) 改变量：品牌名、公司、默认语言
createLeo({ prompts: { vars: { assistantName: '小智', organization: 'Acme', language: '简体中文' }, timezone: 'Asia/Shanghai' } })

// 2) 用自己的目录覆盖/追加（同 id 覆盖，新 id 追加）
createLeo({ prompts: { dir: './prompts.acme' } })

// 3) 按 id 改正文或禁用
createLeo({ prompts: { overrides: { 'platform.output': false, 'platform.safety': '……' } } })

// 4) 每个 agent 不同人设：通过 state 覆盖变量
leo.createAgent({ model, state: { assistantName: '售后小助手' }, systemPrompt: '你负责处理退换货……' })

// 5) 完全不要内置提示词
createLeo({ prompts: false })
```

克隆后二次开发可以直接编辑 `prompts/` 下的文件。`resolvePromptTemplates()` / `loadPromptDir()` / `renderTemplate()` 也已导出，可在自定义插件中复用。

---

## 9. Agent Loop 详解

### 9.1 一个 turn 的流程

```
prompt(input)
 ├─ 会话锁（同一 session 同时只允许一个 turn，否则抛 session_busy）
 ├─ 记录 turn/start、用户消息（以及空闲时 steer 进来的消息）
 └─ 循环：
     ├─ 检查：取消 / 超时 / maxSteps / token 预算 / 成本预算
     ├─ 注入 steer 队列中的消息
     ├─ agent/pre-step waterfall（配额、限流、人工暂停 → 可返回 stop）
     ├─ 构建上下文（可能触发压缩并记录 compaction）
     ├─ 记录 llm/request（模型可见即已记录）
     ├─ 流式调用模型
     │    ├─ 可重试错误：指数退避 + 抖动（尊重 Retry-After），发 retry 事件，不重复构建上下文
     │    ├─ context_overflow：强制压缩后重试本 step 一次
     │    └─ 其它错误：结束 turn（reason = error）
     ├─ 记录 assistant 消息、llm/response、usage/recorded（含成本）
     ├─ 有工具调用 → 执行管线 → 记录结果 → 全部 terminate 则结束，否则继续
     ├─ finish_reason = length 且无工具调用 → 结束（reason = length）
     └─ 无工具调用 → agent/turn-stopping（可要求继续）→ followUp 队列 → 结束
 └─ 记录 turn/end，发 turn_end 事件，释放会话锁
```

### 9.2 AgentOptions

| 字段 | 说明 |
|---|---|
| `model` | `'provider/model'` 或纯模型名 |
| `id` / `sessionId` | 不传自动生成；传入已有 `sessionId` 即续聊 |
| `systemPrompt` | agent 层提示词 |
| `tools` | `ToolFilter` 或 `false` |
| `toolChoice` | `'auto' \| 'none' \| 'required' \| { name }` |
| `sequentialTools` | 强制工具串行 |
| `maxOutputTokens` / `temperature` / `topP` / `stop` / `providerOptions` | 模型参数 |
| `tenant` | 租户上下文，贯穿工具、计量、prompt 片段 |
| `state` | 任意状态，供 prompt 片段和插件读取 |
| `limits` | `{ maxSteps=50, maxTurnTokens, maxTurnCostUsd, turnTimeoutMs }` |
| `retry` | `{ maxAttempts=4, baseDelayMs=1000, maxDelayMs=30000 }` |

`prompt()` / `run()` 的第二个参数可覆盖 limits，并传入外部 `signal`。

### 9.3 事件流（AgentEvent）

| 事件 | 说明 |
|---|---|
| `turn_start` | turn 开始 |
| `step_start` | 一次模型请求开始 |
| `text_delta` / `reasoning_delta` | 文本 / 推理增量 |
| `tool_call_delta` | 工具调用参数增量（可用于 UI 预览） |
| `retry` | 模型请求失败即将重试，**UI 应丢弃本 step 已显示的增量** |
| `compaction` | 发生了上下文压缩 |
| `message` | 本 step 完整的 assistant 消息 |
| `tool_start` / `tool_update` / `tool_result` | 工具执行开始 / 进度 / 结果 |
| `step_end` | 本 step 结束（finishReason、usage） |
| `turn_end` | turn 结束（reason、usage、steps、error） |

所有事件可直接 `JSON.stringify` 推给前端（SSE / WebSocket）。同时会在总线上以 `agent/event` 广播。

### 9.4 结束原因（StopReason）

`completed` · `max_steps` · `budget_exceeded` · `terminated_by_tool` · `length` · `rejected` · `cancelled` · `timeout` · `error`

### 9.5 中途控制

```ts
const agent = leo.createAgent({ model })

agent.steer('改成用 Python 写')     // 运行中插话：下一个 step 前注入
agent.followUp('然后写单元测试')    // turn 本应结束时继续执行
agent.abort('用户点击停止')         // 取消：正在执行的工具会收到 abort，并补记 cancelled 结果

for await (const ev of agent.prompt('...')) {
  if (shouldStop) break            // 提前 break 迭代 = 取消本 turn
}
```

取消时：正在流式输出的部分文本会以 `meta.partial = true` 记录；未完成的工具调用会补记 `cancelled` 结果，
保证会话日志可以回放、下一轮请求不会因为工具调用不配对而被厂商拒绝。

### 9.6 Loop 的扩展点

| 需求 | 做法 |
|---|---|
| 配额 / 限流 / 欠费拦截 | `agent/pre-step` 返回 `{ action: 'stop', reason: 'budget_exceeded' }` |
| 自检 / 反思后再继续 | `agent/turn-stopping` 返回 `{ continue: true, message: '请检查答案' }` |
| 计费 | 监听 `usage/recorded` |
| 实时推送 / 审计 | 监听 `agent/event`、`session/appended` |
| 改写模型请求 | `llm/stream` |
| 换一种 loop（plan-and-execute、多 agent） | 替换 `agentLoop` 服务（见第 11 节） |

---

## 10. 会话日志与存储

会话是**只追加的事件日志**（`SessionEvent`），事件类型：

| 类型 | 内容 |
|---|---|
| `turn/start` / `turn/end` | turn 边界、结束原因、用量、错误 |
| `message` | 用户 / assistant / 工具消息 |
| `llm/request` | 本次请求的 system 文本、按顺序参与的 message id、工具名、参数、fingerprint、估算 token |
| `llm/response` | 响应消息 id、finishReason、用量（含成本）、尝试次数 |
| `llm/attempt-failed` | 每次失败的尝试 |
| `compaction` | 压缩摘要与切分点 |
| `custom` | 插件自定义数据：`sessions.append(id, 'custom', { kind, data })` |

**模型可见即已记录**：任何一次模型请求都可以由 `llm/request` + `message` + `compaction` 事件完整重建，
这同时是审计、计费对账、会话回放和评测的数据源。

存储实现：

- `InMemorySessionStore`：默认，进程内。
- `FileSessionStore`：`createLeo({ sessions: { dir: './data/sessions' } })`，每会话一个 JSONL 文件，进程内串行追加。
- 生产多实例：实现 `SessionStore` 接口（`append` / `events` / `messages` / `delete`）接 Postgres 等，
  通过插件 `ctx.provide('sessions', new PgSessionStore(...))` 覆盖即可。实现需保证同会话 `seq` 单调、`append` 原子。

> 会话锁目前是进程内的。多实例部署时，请在网关层按 sessionId 做粘性路由，或在你的 `SessionStore` 中实现分布式锁。

---

## 11. 替换核心模块

任何核心服务都可以被插件覆盖，依赖它的插件会自动重启并使用新实现：

```ts
// 换会话存储
definePlugin({ name: 'acme/pg-sessions', apply: (ctx) => void ctx.provide('sessions', new PgSessionStore(pool)) })

// 换整个 loop
definePlugin({
  name: 'acme/plan-execute-loop',
  inject: ['sessions', 'llm', 'tools', 'context'],
  apply(ctx) {
    ctx.provide('agentLoop', { create: (opts) => new PlanExecuteAgent(ctx, opts), get, list })
  },
})
```

> 注意：核心服务被替换会重启 `agentLoop`，替换前创建的 Agent 会失效。请在启动阶段完成替换，之后再创建 Agent。

完全自定义组合（不加载任何默认核心插件）：

```ts
const leo = await createLeo({ core: false, plugins: [mySessions, myLlm, myTools, myContext, myLoop] })
// 或者直接用内核
const kernel = new Kernel()
await kernel.root.plugin(...)
await kernel.ready()
```

---

## 12. 克隆后二次开发

leo-agents 的定位是“底座”：可以作为 npm 依赖使用，也可以**克隆后直接改源码**。建议：

1. **优先写插件，其次改源码**。插件可以覆盖几乎所有行为，升级上游时冲突最少。
2. 需要改 loop 行为时，推荐**继承** `DefaultAgent` 或参照它写新的 Agent，再用插件替换 `agentLoop`：
   ```ts
   import { DefaultAgent } from 'leo-agents'
   class MyAgent extends DefaultAgent { /* 覆盖公开方法，或复制 runTurn 的结构改造 */ }
   ```
   直接修改 `src/loop/agent.ts` 也可以——每个阶段都有注释说明。
3. 新增模块的推荐结构（与现有模块一致）：
   ```
   src/<module>/
     types.ts     # 接口 + declaration merging（Services / Events）
     xxx.ts       # 默认实现 + definePlugin 导出的核心插件
     index.ts     # 导出
   ```
   然后在 `src/index.ts` 导出，在 `src/leo.ts` 的 `createLeo` 中按需加载。
   人设与通用规则在 `prompts/*.md`，直接编辑即可（见 8.5）。
4. 修改后运行 `npm run typecheck && npm test`；新增行为请补测试（见第 13 节）。
5. 保留 `docs/architecture-plan.md` 中的原则：插件间只通过服务键协作、模型可见即已记录、失败即关闭。

---

## 13. 测试

`MockProvider` 是确定性的脚本化模型，适合测试插件与 loop：

```ts
import { createLeo, MockProvider, defineTool, z } from 'leo-agents'

const mock = new MockProvider({
  script: [
    { toolCalls: [{ name: 'add', arguments: { a: 1, b: 2 } }] },  // 第 1 次请求：调用工具
    (req) => ({ text: `结果：${JSON.stringify(req.messages.at(-1)?.content)}` }), // 第 2 次：可根据请求动态生成
  ],
})
const leo = await createLeo({ providers: [mock], logLevel: 'silent', plugins: [myPlugin] })
const r = await leo.createAgent({ model: 'mock' }).run('1+2')

expect(r.reason).toBe('completed')
expect(mock.requests[1].messages.at(-1).role).toBe('tool')  // 断言模型收到的请求
```

脚本项支持：`text`、`reasoning`、`toolCalls`、`usage`、`finishReason`、`error`（`errorAfterText` 模拟流中断）、`delayMs`（测试取消/超时），
也可以直接给 `LlmStreamEvent[]`。

仓库自带测试：`test/kernel.test.ts`（内核语义）、`test/loop.test.ts`（loop 全部行为）、
`test/openai.test.ts`（SSE 解析、错误映射、端到端）、`test/session.test.ts`（存储与消息修复）。

---

## 14. 生产部署清单

- [ ] Provider 配置 `models`（上下文窗口、价格），否则预算按 128k 默认值、成本为 0
- [ ] 设置 `limits`：`maxSteps`、`turnTimeoutMs`，按需 `maxTurnTokens` / `maxTurnCostUsd`
- [ ] 会话存储换成持久化实现；多实例时处理会话锁（粘性路由或分布式锁）
- [ ] 危险工具声明 `permissions`，用 `tools/pre-execute` + `approval` 做审批，用 `tools/guard` 做不可绕过的底线
- [ ] 监听 `usage/recorded` 接计费；`agent/pre-step` 做配额检查
- [ ] `createLeo({ logger })` 接入 pino 等日志；监听 `agent/event` 接 tracing
- [ ] 多租户：创建 Agent 时传 `tenant`，在策略、prompt 片段、计量中使用
- [ ] API Key 用 `apiKeyEnv` 或密钥管理服务注入，不要写进代码
- [ ] 工具实现必须遵守 `exec.signal`；有副作用的工具不要标 `idempotent`

---

## 15. 错误码

| code | 含义 | loop 行为 |
|---|---|---|
| `rate_limit` | 429 | 退避重试（尊重 Retry-After） |
| `overloaded` | 5xx / 529 | 退避重试 |
| `timeout` | 请求超时 | 退避重试 |
| `network` | 网络错误 | 退避重试 |
| `context_overflow` | 超出上下文 | 强制压缩后重试一次 |
| `auth` | 401/403/402、余额不足 | 结束 turn |
| `invalid_request` | 其它 4xx | 结束 turn |
| `tool_not_found` / `tool_invalid_args` / `tool_denied` / `tool_timeout` / `tool_error` | 工具错误 | 作为错误结果回给模型 |
| `cancelled` | 取消 | turn 结束（reason = cancelled） |
| `session_busy` | 会话已有进行中的 turn | `prompt()` 同步抛出 |
| `service_missing` / `plugin_unresolved` / `plugin_config_invalid` | 内核错误 | 启动时抛出 |

---

## 16. 事件目录

| 事件 | 模式 | 载荷 → 返回 | 说明 |
|---|---|---|---|
| `llm/stream` | waterfall | `{ provider, request, opts }` → `AsyncIterable<LlmStreamEvent>` | 每次模型调用 |
| `tools/pre-execute` | waterfall | `PreExecutePayload` → `ToolDecision` | 策略：allow / deny / ask |
| `tools/guard` | bail | `PreExecutePayload` → `{ deny }` | 单调守卫 |
| `tools/execute` | waterfall | `{ tool, args, exec }` → 原始返回值 | 包裹执行 |
| `tools/post-execute` | waterfall | `{ tool, args, call, result }` → `ToolResult` | 结果后处理 |
| `context/transform` | waterfall | `{ messages, input }` → `AgentMessage[]` | 改写上下文 |
| `context/convert` | waterfall | `{ messages, input }` → `AgentMessage[]` | 自定义角色转换 |
| `agent/pre-step` | waterfall | `{ agent, turnId, step, usage }` → `{ action }` | 每个 step 前 |
| `agent/turn-stopping` | serial | `{ agent, turnId, message, usage, steps }` → `{ continue, message? }` | turn 结束前 |
| `agent/event` | emit | `{ agent, event }` | AgentEvent 旁路广播 |
| `usage/recorded` | emit | `{ agentId, sessionId, turnId, stepId, model, usage, tenant }` | 计量 |
| `session/appended` | emit | `SessionEvent` | 会话事件写入后 |
