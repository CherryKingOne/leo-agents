# 默认提示词（prompts/）

这里是 leo-agents 内置的默认 system prompt 片段，由 `promptsPlugin`（`createLeo` 默认加载）读取。
每个文件是一个 **PromptSection**，最终按 `layer → priority` 顺序拼成 system prompt：

| 文件 | id | 层 | 内容 |
|---|---|---|---|
| `10-identity.md` | `platform.identity` | platform | 人设：身份、性格、诚实原则 |
| `20-behavior.md` | `platform.behavior` | platform | 工作方式：理解需求、何时澄清、如何完成任务 |
| `30-tool-use.md` | `platform.tool-use` | platform | 工具使用规范（仅在本次请求有工具时注入） |
| `40-safety.md` | `platform.safety` | platform | 安全底线 |
| `50-output.md` | `platform.output` | platform | 输出格式与语言 |
| `90-runtime.md` | `runtime.environment` | runtime | 运行时信息：日期、时区、模型 |

`AgentOptions.systemPrompt` 作为 `agent` 层插在 platform 与 runtime 之间，用来写业务角色。

## 文件格式

```md
---
id: platform.identity      # 必填，全局唯一；与默认片段同 id 即覆盖它
layer: platform            # platform | tenant | agent | task | runtime
priority: 10               # 同层升序，默认 100
when: tools                # 可选：tools = 仅在有工具时注入
---
正文，支持 {{变量}}。
```

没有 frontmatter `id` 的 `.md`（比如本文件）会被忽略。

## 变量

`{{name}}` 形式，取值优先级：`agent.state` > `promptsPlugin` 配置的 `vars` > 内置变量。
未定义的变量渲染为空串；渲染后为空的片段不注入。
`{{#name}}…{{/name}}` 是条件块：变量非空时才输出其中内容。

内置变量：`assistantName`（默认 Leo）、`organization`、`language`、`date`、`timezone`、`model`、
`agentId`、`sessionId`、`tenantId`。

## 怎么改

- **克隆后直接改**：编辑本目录的文件即可。
- **作为依赖使用**：不要改 node_modules，用配置覆盖：

```ts
createLeo({
  prompts: {
    vars: { assistantName: '小智', organization: 'Acme' },
    dir: './my-prompts',                 // 同 id 覆盖默认片段，新 id 追加
    overrides: { 'platform.output': false, 'platform.safety': '你自己的安全规则……' },
  },
})
```

- **完全不要默认提示词**：`createLeo({ prompts: false })`。
