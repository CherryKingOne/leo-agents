# leo-agents 开发文档

> 适用版本：v0.1 · 运行环境：Node.js ≥ 22 · 语言：TypeScript（ESM）

leo-agents 只做**底座**：一个插件内核 + 一个可直接商用的通用 Agent Loop。
具体业务（工具、记忆、渠道、编排方式……）由你通过插件拼装，或者克隆仓库后直接改源码定制。

---

## 目录

1. [快速开始](#1-快速开始)
2. [.leo 配置](#2-leo-配置)
3. [整体架构](#3-整体架构)
4. [插件协议](#4-插件协议)
5. [服务：注册、获取、替换](#5-服务注册获取替换)
6. [事件与钩子](#6-事件与钩子)
7. [开发工具（Tool）](#7-开发工具tool)
8. [接入模型（Provider）](#8-接入模型provider)
9. [上下文与提示词](#9-上下文与提示词)
10. [Agent Loop 详解](#10-agent-loop-详解)
11. [会话日志与存储](#11-会话日志与存储)
12. [替换核心模块](#12-替换核心模块)
13. [克隆后二次开发](#13-克隆后二次开发)
14. [测试](#14-测试)
15. [生产部署清单](#15-生产部署清单)
16. [错误码](#16-错误码)
17. [事件目录](#17-事件目录)

---

## 1. 快速开始

### 1.1 不写代码，直接用（leo 命令行）

```bash
git clone https://github.com/CherryKingOne/leo-agents.git
cd leo-agents && npm install        # install 时自动 build
npm link                            # 得到全局命令 leo（或用 node dist/cli/main.js 代替）

leo auth set deepseek               # 输入密钥（隐藏输入），存到 ~/.leo/credentials.json，权限 600
# 或者：export DEEPSEEK_API_KEY=sk-...

cd ~/my-project
leo                                 # 交互式：在当前目录读写文件、搜索、执行命令、抓网页
leo "把 README 翻译成英文，存为 README.en.md"
leo -p -y "跑一下测试，失败就修"     # 一次性执行，-y 自动批准写文件/执行命令
git diff | leo -p "帮我写 commit message"
leo -c                              # 继续上次会话
```

| 命令 | 作用 |
|---|---|
| `leo init` | 在当前目录创建 `.leo/`（配置模板、plugins 目录），把 `credentials.json`、`sessions/` 加进 `.gitignore`，可顺便保存密钥 |
| `leo auth set <provider> [key] [--project]` | 保存密钥；默认用户级 `~/.leo`，`--project` 存到 `./.leo` |
| `leo auth list` / `leo auth remove <provider>` | 查看（掩码）/ 删除密钥 |
| `leo models` | 可用的提供方、默认模型、密钥来源 |
| `leo doctor` | 诊断：读到了哪些配置文件、密钥从哪来、加载了哪些插件和工具 |
| `leo serve [-y]` | 后台常驻：不进入对话，只加载配置与插件并保持在线（热加载照常），Ctrl+C 停止。给网关、渠道机器人这类“自己接活”的插件用，例如 `leo plugin add gateway && leo serve` |

内置工具：`read_file`、`write_file`、`edit_file`、`list_dir`、`grep`、`bash`、`web_fetch`。
写文件和执行命令默认需要确认（`[y]是 / [n]否 / [a]本次会话都允许`）；非交互模式下没有人能确认，默认拒绝，加 `-y` 放行。
**这不是沙箱**：生产或不受信任的任务请在容器 / 虚拟机里运行。

### 1.2 在代码里用（同样读取 .leo 配置）

```ts
import { createLeoFromConfig } from 'leo-agents'

const app = await createLeoFromConfig()        // 读取 ~/.leo 与 ./.leo，自动探测密钥
const agent = app.createAgent()                 // 默认模型、system prompt、内置工具、预算都来自配置
for await (const ev of agent.prompt('总结 docs/ 目录下的文档')) {
  if (ev.type === 'text_delta') process.stdout.write(ev.text)
}
```

### 1.3 完全手动组装（底座用法）

```ts
import { createLeo, deepseek, defineTool, z } from 'leo-agents'

const leo = await createLeo({ plugins: [deepseek()] })     // 模型接入也是插件，读取 DEEPSEEK_API_KEY
leo.ctx.get('tools').register(
  defineTool({ name: 'add', description: '两数相加', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }),
)
const agent = leo.createAgent({ model: 'deepseek/deepseek-chat', systemPrompt: '你是一个助手' })
const r = await agent.run('2+3 等于几？')
console.log(r.text, r.reason, r.usage)
```

开发与测试：

```bash
npm test              # 45 个用例：内核、loop、工具管线、OpenAI 适配器、会话、配置/密钥/内置工具/第三方插件
npm run build
npm run example:basic # 未设置 API Key 时用 MockProvider 离线演示
```

---

## 2. .leo 配置

参考了 pi（`~/.pi/agent` + 项目 `.pi/`，settings / models / auth 分文件）和 DeepSeek Harness（凭据只按名字引用、存储与配置分离、配置错误加载即失败）的做法，调研笔记见 [config-research.md](config-research.md)。

### 2.1 目录

```
~/.leo/                      用户级（LEO_HOME 可改位置）
  config.json                默认配置
  credentials.json           密钥（0600）
  plugins/                   用户插件，自动加载 *.js / *.mjs / *.ts
  sessions/                  不在项目里运行时的会话
<项目>/.leo/                  项目级：从当前目录向上找第一个 .leo/
  config.json                项目配置，覆盖用户配置（可以提交）
  credentials.json           项目密钥（不要提交，leo init 已加入 .gitignore）
  plugins/                   项目插件
  sessions/                  会话日志 JSONL（不要提交）
```

合并：对象深合并（项目覆盖用户，CLI 参数最高）；`plugins` 拼接；同一插件模块只加载一次。

### 2.2 config.json

JSON，允许 `//` 整行注释。所有字段可选。

```jsonc
{
  "model": "deepseek/deepseek-chat",            // 默认模型 <provider>/<model>；不写则取第一个可用提供方的默认模型
  "providers": {
    "deepseek": {},                              // 内置预设只写要改的字段
    "openai":   { "baseURL": "https://my-gateway.example.com/v1" },
    "vllm":     { "baseURL": "http://gpu01:8000/v1", "models": ["Qwen/Qwen3-32B"] },          // 任意 OpenAI 兼容端点
    "acme":     { "baseURL": "https://api.acme.ai/v1", "apiKey": "$ACME_API_KEY",
                  "headers": { "X-Org": "!cat ~/.acme/org" },
                  "models": [{ "id": "acme-large", "contextWindow": 200000, "pricing": { "inputPerMTok": 1, "outputPerMTok": 3 } }] },
    "claude":   { "type": "anthropic" },         // 非 OpenAI 协议：由插件注册的提供方类型处理（见 8.2）
    "ollama":   { "enabled": false }
  },
  "plugins": ["leo-plugin-memory", ["./tools/my-plugin.mjs", { "foo": 1 }]],
  "tools": {
    "builtin": ["read_file", "grep", "bash"],    // false 关闭全部内置工具
    "approval": "ask",                           // ask | auto | deny（作用于写文件、执行命令）
    "workspace": ".",                            // 文件工具根目录，默认当前目录
    "allowOutsideWorkspace": false,
    "bashTimeoutMs": 120000
  },
  "agent": {
    "systemPrompt": "…",                         // 覆盖默认 system prompt
    "appendSystemPrompt": "本项目使用 pnpm，提交信息用中文",
    "maxSteps": 50, "maxTurnTokens": 200000, "maxTurnCostUsd": 1, "turnTimeoutMs": 600000,
    "maxOutputTokens": 8192, "temperature": 0.2
  },
  "sessions": { "persist": true, "dir": ".leo/sessions" },
  "context": { "defaultContextWindow": 128000, "softLimitRatio": 0.85, "keepRecentTurns": 2 },
  "logLevel": "warn"
}
```

配置不合法（字段类型、枚举值）会在启动时直接报错，不会静默忽略。

### 2.3 密钥

| 写法 | 含义 |
|---|---|
| `credentials.json`：`{ "deepseek": "sk-..." }` | 推荐，`leo auth set` 写入，权限 600 |
| `"apiKey": "$NAME"` / `"${NAME}"` | 读取环境变量 |
| `"apiKey": "!op read op://dev/deepseek/key"` | 执行命令取输出（1Password、Keychain、vault），进程内缓存 |
| `"apiKey": "sk-..."` | 字面值，不推荐提交到仓库 |
| `DEEPSEEK_API_KEY` 等 | 内置预设的环境变量回退 |

优先级：`--api-key` > 项目 `credentials.json` > 用户 `credentials.json` > 配置里的 `apiKey` > 环境变量。
密钥在每次请求时解析，换密钥不用重启。所有提供方插件（含第三方）通过 `ctx.get('credentials')` 统一取密钥，这些来源对它们同样生效。

内置预设：

| id | baseURL | 环境变量 | 默认模型 |
|---|---|---|---|
| `deepseek` | https://api.deepseek.com/v1 | `DEEPSEEK_API_KEY` | deepseek-chat |
| `openai` | https://api.openai.com/v1 | `OPENAI_API_KEY` | gpt-4o-mini |
| `qwen` | https://dashscope.aliyuncs.com/compatible-mode/v1 | `DASHSCOPE_API_KEY` | qwen-plus |
| `moonshot` | https://api.moonshot.cn/v1 | `MOONSHOT_API_KEY` | 需指定 |
| `zhipu` | https://open.bigmodel.cn/api/paas/v4 | `ZHIPUAI_API_KEY` | 需指定 |
| `siliconflow` | https://api.siliconflow.cn/v1 | `SILICONFLOW_API_KEY` | 需指定 |
| `openrouter` | https://openrouter.ai/api/v1 | `OPENROUTER_API_KEY` | 需指定 |
| `ollama` | http://localhost:11434/v1 | 无需密钥 | 需指定（需在配置中声明才加载） |

检测到密钥的预设会自动启用，不需要写配置。默认模型会随厂商更新变化，以厂商文档为准，可以用 `model` 指定。

### 2.4 安全提示

项目 `.leo/` 里的插件和 `!command` 会以当前用户权限执行代码。克隆不受信任的仓库后，先检查 `.leo/` 再运行 `leo`。

---

## 3. 整体架构

```
┌──────────────────────── 你的应用（CLI / HTTP 服务 / Bot） ────────────────────────┐
│  leo CLI / createLeoFromConfig()  →  createLeo({ plugins })  →  agent.prompt()       │
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
| `src/providers/` | 模型接入插件：`openaiCompatible()`、内置预设 `deepseek()` 等、提供方类型注册表 `providerKinds` |
| `src/config/` | `.leo` 配置发现与合并、密钥解析与凭据服务、`createLeoFromConfig()` |
| `src/tools/builtin.ts` | 内置工具（文件 / 搜索 / bash / 网页）与审批策略插件 |
| `src/cli/` | `leo` 命令行（只用公开 API 实现，也是接入示例） |
| `src/leo.ts` | `createLeo()`：把内核和核心插件组装起来 |

设计原则（来自 `docs/architecture-plan.md`）：**一切皆插件**；**插件之间只通过服务键协作**；**模型可见即已记录**；**默认安全（失败即关闭）**；**租户上下文贯穿全链路**。

---

## 4. 插件协议

### 4.1 两种写法

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

### 4.2 插件字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 插件名。建议 `scope/name` 或 `leo-plugin-xxx` |
| `inject` | 否 | 依赖的服务键数组。缺任何一个，插件处于 `pending`；服务被替换时插件会**自动撤销并重新 apply** |
| `config` | 否 | zod schema。加载时 `safeParse`，失败抛 `plugin_config_invalid` |
| `watch` | 否 | 热加载时要关注的数据文件，相对 `.leo/` 的路径，`/` 结尾表示目录，如 `['mcp-servers.json']`、`['agents/']`。宿主同时监听 `~/.leo/` 和项目 `.leo/` 下的这些路径，变化时重新加载本插件（见 4.9） |
| `apply(ctx, config)` | 是 | 入口。可以是 async。抛异常时插件进入 `failed`，已做的注册会被撤销 |

### 4.3 生命周期

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

### 4.4 加载插件

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

### 4.5 Context API 一览

| 方法 | 说明 |
|---|---|
| `ctx.provide(key, impl)` | 注册服务。同键后注册者生效，撤销后回退到上一个 |
| `ctx.get(key)` | 获取服务，缺失抛 `service_missing` |
| `ctx.maybe(key)` / `ctx.has(key)` | 获取可选服务 / 判断是否存在 |
| `ctx.on(event, handler, { prepend })` | 注册事件监听 |
| `ctx.emit / parallel / serial / bail / waterfall` | 分发事件（见第 6 节） |
| `ctx.effect(setup)` | 注册任意副作用，`setup` 返回撤销函数 |
| `ctx.plugin(p, config)` | 加载子插件 |
| `ctx.fork({ tenant, agentId, sessionId })` | 派生作用域子上下文 |
| `ctx.tenant` / `ctx.scope` | 当前租户 / 作用域 |
| `ctx.signal` | 插件卸载时 abort，长任务要监听 |
| `ctx.logger` | 带插件名的结构化日志 |

### 4.6 发布插件包

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

### 4.7 用 `leo plugin` 安装插件

```bash
leo plugin list                            # 已安装的插件（标注 全局 / 项目）+ 官方插件仓库
leo plugin add mcp                         # 默认全局：~/.leo/plugins/mcp.bundle.js（校验 sha256），并自动生成 ~/.leo/mcp-servers.json
leo plugin add mcp --project               # 只装到当前项目：.leo/plugins/ 与 .leo/mcp-servers.json（--local / -l 同义）
leo plugin add mcp --no-init               # 只装插件，不生成配置文件
leo plugin add mcp --init-from ./tpl       # 用你自己的模板目录（按相对路径复制进 .leo/）或单个文件
leo plugin init mcp [--project] [--force]  # 重新生成配置文件；已存在的文件默认保留，--force 覆盖
leo plugin add sub-agents --npm            # npm install --prefix ~/.leo，并把包名写进 ~/.leo/config.json 的 plugins
leo plugin add @acme/x --npm --project     # 仓库外的任意 npm 包，装到项目
leo plugin remove mcp                      # 卸载全局安装（默认）；别名 rm / uninstall
leo plugin remove mcp --project            # 只卸载当前项目里的（--local / -l 同义）
leo plugin remove mcp --all                # 全局和项目都卸载
leo plugin remove mcp --purge              # 连同安装时生成的配置文件一起删除（默认保留）
```

- **默认全局安装**到 `~/.leo/`（`LEO_HOME` 可改位置），在任何项目里运行 `leo` 都会加载；`--project` 才装进当前项目的 `.leo/`
  （当前目录及上级都没有 `.leo/` 时会在当前目录创建）。`-g` 仍可写，等同默认。
- **加载规则**：全局 `~/.leo/plugins/`、`~/.leo/config.json` 与项目 `.leo/plugins/`、`.leo/config.json` 里的插件都会加载。
  同一插件两处都装（`plugins/` 里同名文件，或 config 里同一包名）时只加载一次，**项目的那份生效**；
  项目没写插件选项时沿用全局 config 里写的。
- **自动初始化配置文件**：插件在清单 `leo-plugin.json` 的 `init.files` 里声明配置文件模板（目标路径相对 `.leo/`），
  发布时模板随 bundle 一起上传，registry 条目带上 `init.files[].url` 与 `sha256`。`leo plugin add` 安装后自动把模板写进
  `~/.leo/` 或项目 `.leo/`（校验 sha256，路径不能越出 `.leo/`，已存在的文件不覆盖）；插件没有模板就跳过。
  npm 安装的包读取包内 `leo-plugin.json` 的 `init.files[].template`。`--init` 仍可写，等同默认。
- **卸载**：默认卸载全局，`--project` 卸载项目，`--all` 两处都卸。只卸一处时，如果另一处还装着会提示：卸掉全局后项目里的那份仍在该项目生效；卸掉项目那份后该项目改用全局的。
  会删除 `plugins/` 里的单文件、`config.json` 里的包名，并 `npm uninstall` 包。配置文件默认保留，`--purge` 才删除插件声明的 `init.files`。
- **不用重启**：正在运行的 `leo`会自动感知安装、移除和更新并热加载（通常不到一秒，最多约 3 秒），见 4.9。
- 插件仓库默认是官方仓库 `https://raw.githubusercontent.com/CherryKingOne/leo-plugin/main/registry.json`，
  可用 `--registry <url|路径>` 或环境变量 `LEO_PLUGIN_REGISTRY` 指向镜像或私有仓库。
- 仓库条目格式见 leo-plugin 仓库的 `schemas/registry.schema.json`；`bundle.url`、`init.files[].url` 可写相对地址（相对仓库文件）。
- npm 包按顺序在 **项目 `.leo/` → 项目根 → `~/.leo/`** 的 `node_modules` 中解析（用户级配置里的包先查 `~/.leo/`），
  支持只有 `import` 条件的纯 ESM 包。
- 写配置时只改 `plugins` 数组，保留文件里的注释与格式。

### 4.8 宿主信息 `leoPaths`

通过 `createLeoFromConfig`（含 CLI）启动时，最先提供 `leoPaths` 服务：`{ cwd, projectRoot?, projectDir?, userDir, ... }`。
插件用 `ctx.maybe('leoPaths')` 读取（用 `createLeo` 手动组装时没有这个服务，插件应能在缺失时正常工作）。

同时提供 `agentFactory` 服务：按 `.leo/config.json` 的默认值（模型、系统提示词、步数 / 预算 / 超时）创建 Agent。
需要自己起 Agent 的插件（网关、定时任务、Webhook 机器人）用它，而不是自己拼模型与提示词：

```ts
const factory = ctx.maybe('agentFactory')          // 手动 createLeo 组装时没有，插件要能降级
factory?.defaultModel                              // 'deepseek/deepseek-chat' | undefined
const agent = factory?.create({ sessionId: 'chat-123', label: 'gateway:telegram', limits: { maxSteps: 20 } })
// 传入的选项覆盖默认值，limits 逐项合并；systemPrompt() 返回宿主默认提示词，插件可在其后追加自己的说明
```

`leo serve` 不提供审批服务：需要人工审批的插件自己提供（网关在聊天里请求 /approve），否则 `ask` 一律拒绝（fail closed）。

---

### 4.9 插件热加载

通过 `createLeoFromConfig` 启动（含 `leo` 对话）时，插件是**热加载**的：运行中安装、移除、更新插件，或修改插件的数据文件，不需要重启。

**监听什么**（`fs.watch` + 每 3 秒一次轮询兜底，都不会让进程常驻）：

- `~/.leo/config.json`、`~/.leo/plugins/`、项目 `.leo/config.json`、项目 `.leo/plugins/`（当前目录后来才创建 `.leo/` 也能感知）
- 已加载插件在定义里声明的 `watch` 路径，全局和项目各一份

**怎么应用**（变化后合并约 300ms 再处理，串行执行）：

| 变化 | 处理 | 事件 |
|---|---|---|
| 新出现的插件 | 加载 | `plugin/loaded`（reason: `added`） |
| 插件被删除或从配置移除 | 卸载：撤销它通过 `ctx` 做的全部注册（服务、工具、监听器、effect） | `plugin/unloaded`（reason: `removed`） |
| 模块文件、插件选项或 `watch` 文件变化 | 先卸载旧实例，再加载新实例 | `plugin/unloaded` + `plugin/loaded`（reason: `changed`） |
| 新实例加载失败 | 恢复旧实例；同一个坏版本不会反复重试 | `plugin/failed` |
| 项目里装了同一插件 | 卸载全局那份，加载项目那份 | removed + added |

- 先卸载、再加载，所以新旧两份不会同时注册同名工具。Agent **每一步**都重新读取工具列表，热加载的工具从下一步起可用，卸载的工具从下一步起不再暴露。
- 依赖热加载插件服务的其他插件，会因为服务出现、替换或消失而自动重新 apply 或进入 pending（4.3 的依赖机制）。
- 模块用带版本号的 URL 重新 `import`，绕过 ESM 缓存；npm 包只会重新加载入口文件。
- **不热更新**：模型、提供方、内置工具、审批模式等宿主配置，改了仍需重启。
- 代码中：`app.reloadPlugins()` 立即扫描并返回 `{ added, removed, changed, failed }`；`app.loadedPlugins()` 列出当前插件；
  `createLeoFromConfig({ watchPlugins: false })` 关闭自动监听，`pluginPollMs` 调整轮询间隔（0 关闭）。
- 交互模式：`/plugins` 查看已加载的插件，`/plugins reload` 立即重新扫描；加载、卸载时会提示一行。

**插件要满足的条件**（否则热加载会留下残余）：

1. 所有注册都通过 `ctx` 完成：`ctx.provide`、`ctx.on`、`await ctx.effect(() => tools.register(def))`。直接调用 `tools.register` 不放进 `ctx.effect` 的，卸载时撤不掉，重新加载会报“工具已注册”。
2. 自己开的资源（子进程、连接、定时器、文件监听）用 `ctx.effect(() => () => close())` 交给宿主关闭，或监听 `ctx.signal` 的 abort。
3. 不在模块顶层做有副作用的事（启动进程、写全局变量）：热加载会重新执行模块，顶层代码每次都会再跑一遍。
4. 运行时读取的数据文件写进 `watch`，用户改完文件就会生效；不需要自己写文件监听。

## 5. 服务：注册、获取、替换

### 5.1 声明服务类型（declaration merging）

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

### 5.2 提供与消费

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

### 5.3 核心服务

| 键 | 接口 | 默认实现 |
|---|---|---|
| `sessions` | `SessionStore` | `InMemorySessionStore`（`createLeo({ sessions: { dir } })` 用 `FileSessionStore`） |
| `llm` | `LlmService` | 多 Provider 注册表 + `llm/stream` 中间件 |
| `tools` | `ToolRegistry` | `DefaultToolRegistry` |
| `context` | `ContextService` | 分层 prompt + token 预算 + 压缩 |
| `agentLoop` | `AgentLoopService` | `DefaultAgent` |
| `approval`（可选） | `ApprovalService` | 无（未提供时 `ask` 决策一律拒绝） |
| `leoPaths`（可选） | `LeoPaths` | `createLeoFromConfig` 提供：当前目录、项目根、`.leo`、`~/.leo` |

---

## 6. 事件与钩子

### 6.1 五种分发模式

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

### 6.2 声明自定义事件

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

完整的内置事件列表见[第 17 节](#17-事件目录)。

---

## 7. 开发工具（Tool）

### 7.1 定义

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

### 7.2 注册

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

### 7.3 控制暴露给模型的工具

```ts
leo.createAgent({ model, tools: { tags: ['fs'] } })      // 只暴露带 fs 标签的
leo.createAgent({ model, tools: { names: ['fs_read'] } })
leo.createAgent({ model, tools: false })                 // 不使用工具
leo.createAgent({ model, sequentialTools: true })        // 强制串行
```

筛选不仅决定发给模型的 schema，也在执行时强制生效：模型调用筛选之外的工具（哪怕“猜”中了名字）会得到
`tool_not_found` 错误结果，工具不会执行，也不会弹出审批。

工具通过 `exec.onUpdate(partial)` 上报进度（Agent 转为 `tool_update` 事件）。约定格式
`{ type: 'progress', message: string, ... }`（`ToolProgress`）：CLI 会显示 `message`，其他字段供程序化消费；
其他格式（如 bash 的原始输出片段）CLI 不显示。

### 7.4 执行管线

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

## 8. 接入模型（Provider）

模型接入全部是插件：加载即注册到 `llm` 服务，卸载即撤销。三种方式，按需选最简单的：

| 需求 | 做法 |
|---|---|
| 内置预设（DeepSeek、OpenAI、通义、Kimi、智谱、SiliconFlow、OpenRouter、Ollama） | 有密钥即自动启用；代码里 `plugins: [deepseek()]` |
| 任意 OpenAI 兼容端点（vLLM、SGLang、网关、leo-inference） | `.leo/config.json` 写 `baseURL`；代码里 `openaiCompatible({...})` |
| 其他协议 / 自定义认证 / 动态模型列表 | 写插件：注册提供方类型或直接注册 `LlmProvider` |

### 8.1 内置预设与 OpenAI 兼容插件

```ts
import { createLeo, deepseek, openaiCompatible, qwen } from 'leo-agents'

const leo = await createLeo({
  plugins: [
    deepseek(),                                             // DEEPSEEK_API_KEY 或 credentials 服务
    qwen({ apiKey: '$MY_DASHSCOPE_KEY' }),                  // apiKey 支持 $ENV / !command / 字面值
    openaiCompatible({
      id: 'vllm',                                           // 模型前缀：'vllm/Qwen3-32B'
      baseURL: 'http://gpu01:8000/v1',
      models: [{ id: 'Qwen3-32B', contextWindow: 128_000, pricing: { inputPerMTok: 0, outputPerMTok: 0 } }],
      connectTimeoutMs: 60_000,                             // 等待响应头
      idleTimeoutMs: 120_000,                               // 两个流分片间最大间隔
      maxTokensField: 'max_tokens',                         // OpenAI 新模型用 'max_completion_tokens'
      sendReasoning: false,                                 // 是否把历史 reasoning 以 reasoning_content 回传
      headers: { 'X-Org': '$ORG_ID' },                      // 请求头值也支持 $ENV / !command
      default: true,                                        // 不带前缀的模型名走它
    }),
  ],
})
```

已处理：SSE 跨块解析、`reasoning_content`、流式 tool call 拼接、usage（含缓存命中）、`Retry-After`、
`insufficient_quota` 不重试、上下文超长识别为 `context_overflow`、连接/空闲超时、缺少密钥时给出 `leo auth set` 提示。

已经有 `LlmProvider` 实例时用 `providerPlugin(instance)` 包装；`createLeo({ providers: [...] })` 仍然可用，等价于逐个包装。

### 8.2 提供方类型：让配置文件能用你的协议

`.leo/config.json` 里每个提供方有 `type`（默认 `openai-compatible`）。插件可以注册新类型，
之后用户只写配置就能用，不需要碰代码：

```ts
// leo-provider-anthropic/index.ts
import { definePlugin } from 'leo-agents'
import { AnthropicProvider } from './provider.js'   // 实现 LlmProvider（见 8.3）

export default definePlugin({
  name: 'leo-provider-anthropic',
  inject: ['providerKinds'],
  async apply(ctx) {
    await ctx.effect(() =>
      ctx.get('providerKinds').register('anthropic', ({ id, config, apiKey }) =>
        new AnthropicProvider({ id, baseURL: config.baseURL ?? 'https://api.anthropic.com', apiKey }),   // apiKey() 每次请求时取值
      ),
    )
  },
})
```

```jsonc
// .leo/config.json
{
  "plugins": ["leo-provider-anthropic"],
  "providers": { "claude": { "type": "anthropic", "apiKey": "$ANTHROPIC_API_KEY", "models": ["claude-sonnet-4-5"] } },
  "model": "claude/claude-sonnet-4-5"
}
```

工厂收到的 `apiKey()` 已经接好凭据服务（`--api-key`、`credentials.json`、`$ENV`、`!command`）。
加载顺序是：核心插件 → 凭据服务 → `providerKinds` → 配置里的插件 → 配置声明的提供方，所以插件注册的类型一定在提供方创建前就绪。
不想走配置的插件，也可以直接 `ctx.get('llm').registerProvider(provider)`，密钥用 `ctx.maybe('credentials')?.get({ id, envKeys })` 获取。

### 8.3 自定义 Provider

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

export default providerPlugin(new MyProvider())
```

**错误码很重要**：loop 依据 `LeoError.code` 决定是否重试（`rate_limit` / `overloaded` / `timeout` / `network`）、
是否压缩后重试（`context_overflow`）、还是直接失败（`auth` / `invalid_request`）。

### 8.4 模型调用中间件


所有模型调用都经过 `llm/stream` waterfall，可用来做路由、降级、缓存、审计、脱敏：

```ts
ctx.on('llm/stream', async (p, next) => {
  const redacted = { ...p, request: redact(p.request) }
  return next(redacted)
})
```

---

## 9. 上下文与提示词

### 9.1 构建流程

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

### 9.2 Prompt 分层片段

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

### 9.3 记忆 / RAG 注入

```ts
ctx.on('context/transform', async ({ messages, input }, next) => {
  const last = messages.at(-1)
  const memories = await ctx.get('memory').recall(input.sessionId, textOf(last?.content ?? []))
  const note = { id: 'mem', role: 'user', content: [{ type: 'text', text: `相关记忆：\n${memories}` }], createdAt: Date.now(), meta: { injected: true } }
  return next({ messages: [...messages.slice(0, -1), note, last!], input })
})
```

### 9.4 压缩策略

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

---

## 10. Agent Loop 详解

### 10.1 一个 turn 的流程

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

### 10.2 AgentOptions

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
| `label` | 给人看的名字（如 `sub-agent:explorer`）。CLI 审批提示会显示它，用来区分是哪个 Agent 发起的 |
| `limits` | `{ maxSteps=50, maxTurnTokens, maxTurnCostUsd, turnTimeoutMs }` |
| `retry` | `{ maxAttempts=4, baseDelayMs=1000, maxDelayMs=30000 }` |

`prompt()` / `run()` 的第二个参数可覆盖 limits，并传入外部 `signal`。

### 10.3 事件流（AgentEvent）

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

### 10.4 结束原因（StopReason）

`completed` · `max_steps` · `budget_exceeded` · `terminated_by_tool` · `length` · `rejected` · `cancelled` · `timeout` · `error`

### 10.5 中途控制

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

### 10.6 Loop 的扩展点

| 需求 | 做法 |
|---|---|
| 配额 / 限流 / 欠费拦截 | `agent/pre-step` 返回 `{ action: 'stop', reason: 'budget_exceeded' }` |
| 自检 / 反思后再继续 | `agent/turn-stopping` 返回 `{ continue: true, message: '请检查答案' }` |
| 计费 | 监听 `usage/recorded` |
| 实时推送 / 审计 | 监听 `agent/event`、`session/appended` |
| 改写模型请求 | `llm/stream` |
| 换一种 loop（plan-and-execute、多 agent） | 替换 `agentLoop` 服务（见第 12 节） |

---

## 11. 会话日志与存储

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

## 12. 替换核心模块

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

## 13. 克隆后二次开发

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
4. 修改后运行 `npm run typecheck && npm test`；新增行为请补测试（见第 14 节）。
5. 保留 `docs/architecture-plan.md` 中的原则：插件间只通过服务键协作、模型可见即已记录、失败即关闭。

---

## 14. 测试

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

## 15. 生产部署清单

- [ ] Provider 配置 `models`（上下文窗口、价格），否则预算按 128k 默认值、成本为 0
- [ ] 设置 `limits`：`maxSteps`、`turnTimeoutMs`，按需 `maxTurnTokens` / `maxTurnCostUsd`
- [ ] 会话存储换成持久化实现；多实例时处理会话锁（粘性路由或分布式锁）
- [ ] 危险工具声明 `permissions`，用 `tools/pre-execute` + `approval` 做审批，用 `tools/guard` 做不可绕过的底线
- [ ] 监听 `usage/recorded` 接计费；`agent/pre-step` 做配额检查
- [ ] `createLeo({ logger })` 接入 pino 等日志；监听 `agent/event` 接 tracing
- [ ] 多租户：创建 Agent 时传 `tenant`，在策略、prompt 片段、计量中使用
- [ ] API Key 用 `credentials.json`（0600）、`$ENV` 或 `!command` 接密钥管理服务，不要写进代码或提交到仓库
- [ ] 需要多租户密钥时，替换 `credentials` 服务（按 `tenant` 查找）
- [ ] 内置 `bash` / 文件工具不是沙箱：在容器 / 微 VM 中运行，或用插件替换为沙箱实现；`tools.approval` 按场景设为 ask / deny
- [ ] 工具实现必须遵守 `exec.signal`；有副作用的工具不要标 `idempotent`

---

## 16. 错误码

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

## 17. 事件目录

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
| `plugin/loaded` | emit | `{ spec, name, reason: 'added' \| 'changed' }` | 热加载了插件（启动时的加载不发） |
| `plugin/unloaded` | emit | `{ spec, name, reason: 'removed' \| 'changed' }` | 热卸载了插件 |
| `plugin/failed` | emit | `{ spec, error }` | 热加载失败（changed 时已恢复旧版本） |

可选服务（由 `createLeoFromConfig` / CLI 提供）：`credentials`（密钥查找）、`providerKinds`（提供方类型注册表）、`approval`（人工审批）。
