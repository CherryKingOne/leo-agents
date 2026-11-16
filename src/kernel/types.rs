//! 内核公共类型。
//!
//! Rust 没有 declaration merging：服务键统一用字符串，事件名统一用字符串；
//! 各模块通过 ` Services ` / ` Events ` 常量与文档约定键名。

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

/// 撤销函数：撤销一次注册（服务、监听器、任意副作用）。
pub type Disposer = std::sync::Arc<dyn Fn() -> BoxFuture<()> + Send + Sync>;

/// 便于返回装箱 future。
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// 租户上下文：多租户部署时贯穿所有调用，单租户可不传。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TenantContext {
    #[serde(rename = "tenantId")]
    pub tenant_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policies: Option<serde_json::Value>,
}

/// 作用域：fork 子上下文时附加的信息。
#[derive(Debug, Clone, Default)]
pub struct Scope {
    pub tenant: Option<TenantContext>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
}

/// 事件分发模式（事件公共契约的一部分，声明后不应随意更改）：
/// - `emit`      通知：调用全部监听器，忽略返回值，监听器异常只记日志，不阻断发布方
/// - `parallel`  并发：并发执行全部监听器并等待，任一失败则抛出
/// - `serial`    串行：按注册顺序依次执行并等待，收集所有非空返回值
/// - `bail`      闸门：按顺序执行，第一个返回非空的结果即终止并返回它
/// - `waterfall` 洋葱中间件：`(payload, next) => result`，调用 `next()` 交给下一层，不调用即短路
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchMode {
    Emit,
    Parallel,
    Serial,
    Bail,
    Waterfall,
}

/// 事件定义：模式 + 载荷 + 返回值（仅用于文档与内置事件表）。
#[derive(Debug, Clone, Copy)]
pub struct EventDef<M, P, R> {
    pub mode: M,
    pub _payload: std::marker::PhantomData<P>,
    pub _result: std::marker::PhantomData<R>,
}

impl<M, P, R> EventDef<M, P, R> {
    pub const fn new(mode: M) -> Self {
        Self {
            mode,
            _payload: std::marker::PhantomData,
            _result: std::marker::PhantomData,
        }
    }
}

/// 常用事件名常量。
pub mod events {
    pub const SESSION_APPENDED: &str = "session/appended";
    pub const TOOLS_PRE_EXECUTE: &str = "tools/pre-execute";
    pub const TOOLS_GUARD: &str = "tools/guard";
    pub const TOOLS_EXECUTE: &str = "tools/execute";
    pub const TOOLS_POST_EXECUTE: &str = "tools/post-execute";
    pub const CONTEXT_TRANSFORM: &str = "context/transform";
    pub const CONTEXT_CONVERT: &str = "context/convert";
    pub const LLM_STREAM: &str = "llm/stream";
    pub const AGENT_PRE_STEP: &str = "agent/pre-step";
    pub const AGENT_TURNING_STOPPING: &str = "agent/turn-stopping";
    pub const AGENT_EVENT: &str = "agent/event";
    pub const USAGE_RECORDED: &str = "usage/recorded";
    pub const COMMANDS_EXECUTED: &str = "commands/executed";
    pub const PLUGIN_NOTICE: &str = "plugin/notice";
    pub const PLUGIN_DATA_WRITTEN: &str = "plugin/data-written";
    pub const LLM_SELECTED: &str = "llm/selected";
    pub const PLUGIN_LOADED: &str = "plugin/loaded";
    pub const PLUGIN_UNLOADED: &str = "plugin/unloaded";
    pub const PLUGIN_FAILED: &str = "plugin/failed";
}

/// 服务键常量（字符串字面量，避免拼写错误）。
pub mod services {
    pub const SESSIONS: &str = "sessions";
    pub const LLM: &str = "llm";
    pub const TOOLS: &str = "tools";
    pub const APPROVAL: &str = "approval";
    pub const CONTEXT: &str = "context";
    pub const COMMANDS: &str = "commands";
    pub const AGENT_LOOP: &str = "agentLoop";
    pub const LEO_PATHS: &str = "leoPaths";
    pub const AGENT_FACTORY: &str = "agentFactory";
    pub const LEO_CONFIG: &str = "leoConfig";
    pub const CREDENTIALS: &str = "credentials";
}

/// 便于事件处理器读取/写回 JSON 载荷。
pub type Payload = serde_json::Value;
