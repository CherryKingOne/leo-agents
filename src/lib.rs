//! leo-agents：一切皆插件的可商用 Agent 底座（Rust 重写）。
//!
//! - kernel   插件运行时：服务 / 事件 / 可撤销副作用
//! - protocol 厂商无关的消息协议
//! - llm      模型接缝（llm 服务、LlmProvider 接口、providerPlugin）+ Mock Provider
//! - session  只追加会话日志
//! - tools    工具注册表与受控执行管线
//! - context  上下文构建、token 预算、压缩
//! - commands 插件斜杠命令（人触发，不经过模型）
//! - loop     通用 Agent Loop
//! - config   .leo 配置、密钥、createLeoFromConfig（开箱即用）
//! - cli      leo 命令行

pub mod cli;
pub mod commands;
pub mod config;
pub mod context;
pub mod errors;
pub mod kernel;
pub mod leo;
pub mod llm;
pub mod r#loop;
pub mod protocol;
pub mod session;
pub mod tools;

pub use config::{create_Leo_from_config, CreateFromConfigOptions, LeoApp};
pub use errors::{to_leo_error, LeoError, LeoErrorCode, LeoResult};
pub use kernel::{
    create_console_logger, plugin_fn, Context, Kernel, LogLevel, Logger, Plugin, PluginRef,
};
pub use leo::{create_Leo, CreateLeoOptions, Leo};
pub use protocol::{AgentMessage, ContentBlock, DisplayBlock, Usage, UserInput};
