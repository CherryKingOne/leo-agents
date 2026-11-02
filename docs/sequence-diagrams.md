# 时序流程图

本文按当前代码（`src/`）梳理 leo-agents 的主要运行时序，方便阅读源码、开发插件和排查问题。图中的事件名、服务名与代码一致；`waterfall` / `serial` / `bail` / `emit` 是内核的四种事件分发方式（见 `src/kernel/events.ts`）。

| 图 | 场景 | 主要源码 |
| --- | --- | --- |
| 1 | 启动：`leo` → `createLeoFromConfig` → 内核就绪 | `cli/main.ts`、`config/create.ts`、`leo.ts` |
| 2 | 一次对话（turn）的完整循环 | `loop/agent.ts` |
| 3 | 一个 step：构建上下文与调用模型（含重试） | `loop/agent.ts`、`context/builder.ts`、`llm/service.ts` |
| 4 | 工具批量执行：预检、审批、并发执行 | `tools/registry.ts` |
| 5 | 插件热加载与 provider.json 写回 | `config/hot-reload.ts`、`kernel/context.ts` |
| 6 | `leo serve` 常驻：插件按宿主默认值创建 Agent（以网关为例） | `cli/main.ts`、`config/create.ts` |

---

## 1. 启动

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant CLI as leo CLI (cli/main.ts)
  participant CF as createLeoFromConfig
  participant LC as loadConfig
  participant CR as CredentialService
  participant HR as PluginHotReloader
  participant K as Kernel / 根 Context
  participant P as 用户插件

  U->>CLI: leo [-m provider/model] [-p 提示]
  CLI->>CF: createLeoFromConfig({ cwd, overrides, onNotice })
  CF->>LC: 读取 ~/.leo 与 项目 .leo（config.json、plugins）
  LC-->>CF: config + paths + 插件列表
  CF->>CR: 合并 overrides / 项目 / 用户 credentials.json / 环境变量
  CF->>HR: new PluginHotReloader(paths)
  CF->>K: createLeo({ sessions, context, plugins })
  Note over K: 核心插件按顺序加载
  K->>K: sessions → llm → tools → context → agentLoop
  Note over K: 宿主插件
  K->>K: notice / data-written / leoPaths / credentials / leoConfig / agentFactory
  K->>HR: leo:user-plugins.apply → loadInitial(refs)
  loop 每个用户插件（provider、provider-*、gateway、mcp …）
    HR->>P: importPlugin（解析包、import 单文件 bundle）
    HR->>K: ctx.plugin(P, 选项)
    P->>K: provide / on / registerTool / registerProvider（记为可撤销 effect）
  end
  K->>K: 内置工具（read / write / edit / bash …）与审批策略 approvalPolicy
  K->>K: kernel.ready()（等待 inject 依赖就绪）
  CF->>HR: 开始监听配置、插件目录与 watch 文件
  CF-->>CLI: LeoApp（model、providers、createAgent、dispose）
  CLI->>K: app.createAgent({ model, reasoning, sessionId? })
  K-->>CLI: DefaultAgent（fork 出带 agentId / sessionId 的子 Context）
```

要点：

- 底座不内置模型厂商。`app.model` 每次读取时计算：配置里的 `model` 优先，否则取默认 provider（不可用时取第一个可用的）的 `defaultModel`。没有任何可用模型时，`createAgent` 抛出 `auth` 错误，并提示安装 `provider` + `provider-*`。
- 插件注册的一切（服务、工具、监听器）都是 effect，卸载时按 LIFO 顺序撤销。

---

## 2. 一次对话（turn）

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant CLI as CLI / 调用方
  participant A as DefaultAgent
  participant S as SessionStore (JSONL)
  participant EV as 事件总线
  participant ST as step()（见图 3）
  participant T as ToolRegistry（见图 4）

  U->>CLI: 输入一句话
  CLI->>A: agent.prompt(input) / run(input)
  A->>A: 检查会话锁（同一会话已有 turn 时抛 session_busy）
  A->>A: 加锁，status = running，建立 AbortSignal（调用方 / 超时）
  A-->>CLI: turn_start
  A->>S: append turn/start
  A->>S: append message（先写 steer 队列，再写用户消息）

  loop 直到停止
    A->>A: 检查取消、maxSteps、token / 成本预算
    A->>S: 写入期间收到的 steer 消息
    A->>EV: waterfall agent/pre-step（插件可返回 stop：配额、限流、人工暂停）
    A-->>CLI: step_start
    A->>ST: step(turnId, stepId, forceCompact)
    ST-->>CLI: text_delta / reasoning_delta / tool_call_delta（流式）
    alt 抛出 context_overflow 且本步还没强制压缩过
      A->>A: forceCompact = true，本 step 重来一次
    end
    ST-->>A: assistant 消息 + usage + finishReason
    A->>S: append message（assistant）
    A-->>CLI: message、step_end

    alt 有工具调用
      A->>T: executeBatch(calls)
      T-->>CLI: tool_start / tool_update
      T-->>A: 按原顺序的 ToolResult[]
      A->>S: append message（role = tool）× N
      A-->>CLI: tool_result × N
      opt 所有结果都带 terminate
        A->>A: reason = terminated_by_tool，结束
      end
    else finishReason = length
      A->>A: reason = length，结束
    else 无工具调用（本应结束）
      A->>EV: serial agent/turn-stopping
      alt 有监听器返回 continue
        A->>S: 追加它给的用户消息，继续循环
      else followUp 队列非空
        A->>S: 写入下一条 followUp，继续循环
      else
        A->>A: reason = completed，结束
      end
    end
  end

  A->>S: append turn/end（reason、usage、steps、error）
  A-->>CLI: turn_end
  A->>A: 释放会话锁，status = idle，关闭事件通道
  CLI-->>U: 输出文本、思考 token 数与用量统计
```

停止原因（`StopReason`）：`completed`、`max_steps`、`budget_exceeded`、`rejected`（pre-step 拒绝）、`length`、`terminated_by_tool`、`timeout`、`cancelled`、`error`。每个 AgentEvent 同时以 `agent/event` 旁路广播，供日志与实时推送使用。

---

## 3. 一个 step：构建上下文与调用模型

```mermaid
sequenceDiagram
  autonumber
  participant A as DefaultAgent.step
  participant TR as tools
  participant CB as ContextBuilder
  participant S as SessionStore
  participant L as llm 服务
  participant MW as llm/stream 中间件
  participant PR as LlmProvider（provider 插件）
  participant API as 模型厂商 API

  A->>TR: schemas(options.tools)（每步重新读取，热加载的工具下一步可用）
  A->>S: messages(sessionId)
  A->>CB: build({ model, systemPrompt, messages, tools, forceCompact })
  CB->>L: resolve(model) → provider + ModelInfo（上下文窗口、最大输出、价格）
  CB->>CB: 按 layer / priority 渲染系统提示词片段
  CB->>CB: waterfall context/transform → context/convert → sanitize
  CB->>L: countTokens（provider 不提供时按字节估算）
  alt 超过软上限或 forceCompact
    CB->>CB: 压缩策略：保留最近 N 个用户轮，其余生成摘要
  end
  CB->>CB: 仍超硬上限时从最旧的用户轮丢弃，再超就抛 context_overflow
  CB-->>A: system、messages、tools、fingerprint、compaction?
  opt 发生压缩
    A->>S: append compaction
  end
  A->>S: append llm/request（先记日志再发请求，可回放）

  loop attempt = 1 … retry.maxAttempts（默认 4）
    A->>L: stream(model, request, signal)
    L->>MW: waterfall llm/stream（插件可改写请求或包裹事件流）
    MW->>PR: provider.stream(request)
    PR->>API: HTTP 请求（SSE）
    API-->>PR: 增量数据
    PR-->>A: text_delta / reasoning_delta / tool_call_delta / usage / finish
    A->>A: StreamAccumulator 累积为 assistant 消息
    alt 成功
      A->>S: append llm/response（finishReason、usage、attempts）
      A->>A: emit usage/recorded（计费、配额）
      A-->>A: 返回 message + usage
    else 取消
      A->>S: 保存已生成的部分消息
      A-->>A: 抛 cancelled
    else 失败
      A->>S: append llm/attempt-failed
      alt context_overflow / 不可重试 / 次数用完
        A-->>A: 抛出错误（溢出交给图 2 强制压缩后重试）
      else 可重试（network、rate_limit、overloaded …）
        A-->>A: emit retry，指数退避或 Retry-After 后重试
      end
    end
  end
```

插件抛出的错误由 `toLeoError` 识别：带 `Symbol.for('leo.error')` 标记或 `name === 'LeoError'` 的错误会保留 `code`、`status`、`retryAfterMs`，以此决定是否重试。

---

## 4. 工具批量执行

```mermaid
sequenceDiagram
  autonumber
  participant A as DefaultAgent
  participant R as ToolRegistry.executeBatch
  participant EV as 事件总线（策略插件）
  participant AP as approval 服务
  participant TL as 工具实现

  A->>R: executeBatch(calls, { signal, filter, sequential })
  Note over R: 阶段一：串行预检，审批顺序可预测
  loop 每个 tool call
    R->>R: 查找工具与 filter，未知工具返回 tool_not_found 和可用列表
    R->>R: 解析 JSON 参数，zod 校验，失败返回 tool_invalid_args 让模型自我修正
    R->>EV: waterfall tools/pre-execute → allow / deny / ask（策略异常一律拒绝）
    alt ask
      R->>AP: approval.request(…)（CLI 询问用户，网关转发给管理员）
      AP-->>R: approved / rejected
    end
    R->>EV: bail tools/guard（任一守卫可拦截）
  end
  Note over R: 阶段二：执行（默认并发，有 sequential 工具则整批串行）
  par 并发 worker（上限 concurrency）
    R-->>A: onStart → tool_start
    R->>EV: waterfall tools/execute
    EV->>TL: tool.execute(args, exec)（带超时 signal）
    TL-->>A: onUpdate → tool_update
    TL-->>R: 结果或异常（幂等工具失败时按 maxRetries 重试）
    R->>EV: waterfall tools/post-execute（脱敏、截断、审计）
  end
  R-->>A: 按 assistant 原始顺序返回 ToolResult[]
```

---

## 5. 插件热加载与 provider.json 写回

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant FS as 文件系统
  participant HR as PluginHotReloader
  participant K as Kernel
  participant Old as 旧插件实例
  participant New as 新插件实例
  participant PV as provider 插件
  participant CLI as 交互式 leo

  U->>FS: leo plugin add / remove，或修改 config.json、mcp-servers.json 等
  FS-->>HR: fs.watch 通知（低频轮询兜底），去抖
  HR->>HR: 重新解析插件列表，比较指纹（模块文件 + 选项 + watch 文件）
  alt 插件消失
    HR->>Old: dispose()：abort signal，LIFO 撤销服务、工具、监听器
    HR->>K: emit plugin/unloaded（removed）
  else 插件变化
    HR->>Old: dispose()（先卸载，避免同名工具冲突）
    HR->>K: ctx.plugin(New)
    alt 新实例加载成功
      HR->>K: emit plugin/loaded（changed）
    else 加载失败
      HR->>K: 恢复旧实例，emit plugin/failed
    end
  else 新增插件
    HR->>K: ctx.plugin(New)，emit plugin/loaded（added）
  end
  Note over K: Agent 每一步重新读取工具列表，变化从下一步起生效

  U->>CLI: /model、/think、/effort
  CLI->>K: emit llm/selected（model、reasoning、changed）
  K->>PV: 监听器收到 llm/selected
  PV->>FS: 写回 provider.json（保留 JSONC 注释）
  PV->>K: emit plugin/data-written（plugin）
  K->>HR: acknowledge(plugin)：只更新指纹，不重新加载该插件
```

不热更新的部分：模型、内置工具、审批等宿主配置，修改后仍需重启。

---

## 6. `leo serve` 常驻（以网关插件为例）

```mermaid
sequenceDiagram
  autonumber
  actor Op as 运维 / 用户
  participant SV as leo serve
  participant CF as createLeoFromConfig
  participant GW as gateway 插件
  participant AF as agentFactory 服务
  participant A as Agent
  actor IM as 聊天平台用户

  Op->>SV: leo serve
  SV->>CF: createLeoFromConfig({ onNotice })
  CF->>GW: 加载插件（见图 1）
  GW->>CF: emit plugin/notice（控制面地址、渠道连接状态）
  CF-->>SV: onNotice → 终端打印“[gateway] …”
  SV->>SV: 保持在线，等待 Ctrl+C / SIGTERM
  IM->>GW: 发来消息
  GW->>AF: create({ sessionId: 该聊天对应的会话 })
  AF->>AF: 宿主默认值（默认模型、系统提示词、步数 / 预算 / 超时）+ 覆盖项
  AF-->>GW: Agent
  GW->>A: prompt(消息)（流程见图 2）
  A-->>GW: 事件流 / 最终文本
  GW-->>IM: 回复
  Op->>SV: Ctrl+C / SIGTERM
  SV->>CF: app.dispose()：按 LIFO 卸载全部插件
```
