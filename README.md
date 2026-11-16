# leo-agents (Rust)

一个从零手写、以“一切皆插件”为核心、可直接商用的 Rust Agent 底座。

- **插件内核**：服务仓库、五种分发模式的类型化事件、可撤销副作用、依赖注入与热重载
- **通用 Agent Loop**：流式输出、并发工具执行、指数退避重试、上下文溢出自动压缩、steer / followUp、取消与超时、步数 / token / 成本预算、会话锁、只追加可回放日志
- **工具管线**：JSON Schema 参数校验、策略钩子（allow / deny / ask）、审批服务、单调守卫、超时与重试、结果后处理
- **模型接入即插件**：底座不内置任何厂商，只留 `llm` 接缝；模型由供应商插件接入
- **`.leo` 配置**：`~/.leo` 与项目 `.leo/` 两级，`credentials.json` 存密钥（支持 `$ENV` / `!command`），配置非法即报错
- **开箱即用的 `leo` 命令行**：交互 / 一次性 / 管道，内置文件、搜索、bash、网页工具，写入与执行默认需确认

## 目录结构

```text
src/
  kernel/       插件运行时：服务 / 事件 / 可撤销副作用
  protocol/     厂商无关的消息协议
  llm/          模型接缝（llm 服务、LlmProvider、providerPlugin）+ Mock Provider
  session/      只追加会话日志（内存 / JSONL）
  tools/        工具注册表、受控执行管线、内置工具
  context/      上下文构建、token 预算、压缩
  commands/     插件斜杠命令
  loop/         通用 Agent Loop
  config/       .leo 配置、密钥、create_Leo_from_config、热重载
  cli/          leo 命令行
examples/       离线示例
test/           已移除（测试迁移到 tests/）
tests/          Rust 集成测试
```

## 构建与测试

```bash
cargo build
cargo test
cargo run --example basic
cargo run --example custom_plugin
```

## 使用

```rust
use leo_agents::{create_Leo, CreateLeoOptions};
use leo_agents::kernel::LogLevel;

let leo = create_Leo(CreateLeoOptions {
    log_level: Some(LogLevel::Silent),
    ..Default::default()
}).await?;
```

在代码里使用同一套配置：

```rust
use leo_agents::config::{create_Leo_from_config, CreateFromConfigOptions};

let app = create_Leo_from_config(CreateFromConfigOptions::default()).await?;
let result = app.create_agent(Default::default())?.run("总结 README.md".into(), Default::default()).await?;
```

## 命令行

```bash
cargo run --bin leo -- init
cargo run --bin leo -- auth set deepseek
cargo run --bin leo -- models
cargo run --bin leo -- doctor
cargo run --bin leo -- -p "跑测试，失败就修"
cargo run --bin leo -- serve
```

## 插件说明

Rust 版插件是**原生 Rust 插件**：实现 `leo_agents::kernel::Plugin`，在代码中通过 `plugins` 传入或通过 `.leo/config.json` 的 `plugins` 由宿主注册的 loader 构造。

`.leo/config.json` 的插件路径、`leo plugin add/remove`、插件仓库与配置文件模板逻辑均已保留；但 Node.js 的 `.js/.mjs/.ts` 插件无法在 Rust 运行时里直接执行，动态加载请使用 Rust 原生插件或自行实现 `PluginLoader`。

📘 设计文档见 `docs/`。