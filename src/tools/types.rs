//! 工具类型。

use crate::errors::LeoResult;
use crate::kernel::context::Context;
use crate::kernel::logger::Logger;
use crate::kernel::types::{BoxFuture, TenantContext};
use crate::protocol::display::DisplayBlock;
use crate::protocol::messages::{AgentMessage, ContentBlock, ToolCallBlock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// 能力型权限声明。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Permission {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_effect: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone)]
pub struct ToolExecContext {
    pub call_id: String,
    pub tool_name: String,
    pub agent_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub tenant: Option<TenantContext>,
    pub signal: CancellationToken,
    pub on_update: Arc<dyn Fn(Value) + Send + Sync>,
    pub ctx: Context,
    pub logger: Logger,
}

impl ToolExecContext {
    pub fn update(&self, partial: Value) {
        (self.on_update)(partial);
    }
}

/// 工具返回内容：字符串或结构化内容块。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl ToolContent {
    pub fn into_blocks(self) -> Vec<ContentBlock> {
        match self {
            Self::Text(s) => vec![ContentBlock::text(s)],
            Self::Blocks(b) => b,
        }
    }
}

impl From<&str> for ToolContent {
    fn from(value: &str) -> Self {
        Self::Text(value.to_string())
    }
}

impl From<String> for ToolContent {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<Vec<ContentBlock>> for ToolContent {
    fn from(value: Vec<ContentBlock>) -> Self {
        Self::Blocks(value)
    }
}

/// 工具的结构化返回。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    pub content: ToolContent,
    pub is_error: Option<bool>,
    pub terminate: Option<bool>,
    pub details: Option<Value>,
    pub display: Option<Vec<DisplayBlock>>,
}

impl ToolOutput {
    pub fn text(content: impl Into<String>) -> Self {
        Self {
            content: ToolContent::Text(content.into()),
            is_error: None,
            terminate: None,
            details: None,
            display: None,
        }
    }

    pub fn error(content: impl Into<String>) -> Self {
        Self {
            content: ToolContent::Text(content.into()),
            is_error: Some(true),
            terminate: None,
            details: None,
            display: None,
        }
    }
}

impl From<&str> for ToolOutput {
    fn from(value: &str) -> Self {
        Self::text(value)
    }
}

impl From<String> for ToolOutput {
    fn from(value: String) -> Self {
        Self::text(value)
    }
}

pub fn define_tool<F, Fut>(
    name: impl Into<String>,
    description: impl Into<String>,
    parameters: Value,
    execute: F,
) -> Arc<ToolDefinition>
where
    F: Fn(Value, ToolExecContext) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = LeoResult<ToolOutput>> + Send + 'static,
{
    Arc::new(ToolDefinition::new(
        name,
        description,
        parameters,
        Arc::new(move |args, exec| Box::pin(execute(args, exec))),
    ))
}

pub fn tool_output(output: ToolOutput) -> ToolOutput {
    output
}

pub type ExecuteFn =
    Arc<dyn Fn(Value, ToolExecContext) -> BoxFuture<LeoResult<ToolOutput>> + Send + Sync>;
pub type RenderFn = Arc<dyn Fn(Value, Value) -> BoxFuture<LeoResult<ToolOutput>> + Send + Sync>;

pub struct ToolDefinition {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    /// JSON Schema（与 zod 生成的格式一致）
    pub parameters: Value,
    pub permissions: Vec<Permission>,
    /// 'sequential'：只要本批有它，整批串行执行
    pub sequential: bool,
    pub timeout_ms: Option<u64>,
    pub idempotent: bool,
    pub max_retries: Option<u32>,
    pub tags: Vec<String>,
    pub execute: ExecuteFn,
    pub render: Option<RenderFn>,
}

impl ToolDefinition {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
        execute: ExecuteFn,
    ) -> Self {
        Self {
            name: name.into(),
            title: None,
            description: description.into(),
            parameters,
            permissions: Vec::new(),
            sequential: false,
            timeout_ms: None,
            idempotent: false,
            max_retries: None,
            tags: Vec::new(),
            execute,
            render: None,
        }
    }

    pub fn permissions(mut self, permissions: Vec<Permission>) -> Self {
        self.permissions = permissions;
        self
    }

    pub fn sequential(mut self) -> Self {
        self.sequential = true;
        self
    }

    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = Some(ms);
        self
    }

    pub fn idempotent(mut self, retries: Option<u32>) -> Self {
        self.idempotent = true;
        self.max_retries = retries;
        self
    }

    pub fn render(mut self, render: RenderFn) -> Self {
        self.render = Some(render);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub content: Vec<ContentBlock>,
    pub is_error: bool,
    pub terminate: bool,
    pub details: Option<Value>,
    pub display: Option<Vec<DisplayBlock>>,
    pub error_code: Option<String>,
    pub duration_ms: u64,
}

impl ToolResult {
    pub fn message(&self) -> AgentMessage {
        let mut m = AgentMessage {
            id: crate::protocol::messages::new_id("msg"),
            role: "tool".into(),
            content: self.content.clone(),
            tool_call_id: Some(self.call_id.clone()),
            tool_name: Some(self.name.clone()),
            is_error: Some(self.is_error),
            created_at: crate::protocol::messages::now_ms(),
            meta: Some(serde_json::json!({ "durationMs": self.duration_ms })),
        };
        if let Some(code) = &self.error_code {
            m.meta_mut().insert("errorCode".into(), code.clone().into());
        }
        if let Some(details) = &self.details {
            m.meta_mut().insert("details".into(), details.clone());
        }
        if let Some(display) = &self.display {
            m.meta_mut().insert(
                "display".into(),
                serde_json::to_value(display).unwrap_or(Value::Null),
            );
        }
        m
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ToolDecision {
    Allow {
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<Value>,
    },
    Deny {
        reason: String,
    },
    Ask {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreExecutePayload {
    pub call: Value,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub permissions: Vec<Permission>,
    pub args: Value,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant: Option<TenantContext>,
}

#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub payload: PreExecutePayload,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ApprovalResponse {
    pub approved: bool,
    pub reason: Option<String>,
}

#[async_trait::async_trait]
pub trait ApprovalService: Send + Sync {
    async fn request(
        &self,
        req: ApprovalRequest,
        signal: CancellationToken,
    ) -> LeoResult<ApprovalResponse>;
}

/// 服务句柄：因为 `dyn Trait` 不能做 `Any` 向下转型。
#[derive(Clone)]
pub struct ApprovalServiceHandle(pub Arc<dyn ApprovalService>);

impl std::ops::Deref for ApprovalServiceHandle {
    type Target = dyn ApprovalService;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[derive(Debug, Clone, Default)]
pub struct ToolFilter {
    pub names: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub deny_all: bool,
}

impl ToolFilter {
    pub fn matches(&self, tool: &ToolDefinition) -> bool {
        if self.deny_all {
            return false;
        }
        if let Some(names) = &self.names {
            if !names.iter().any(|n| n == &tool.name) {
                return false;
            }
        }
        if let Some(tags) = &self.tags {
            if !tags.is_empty() && !tool.tags.iter().any(|t| tags.contains(t)) {
                return false;
            }
        }
        true
    }
}

pub struct BatchContext {
    pub agent_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub tenant: Option<TenantContext>,
    pub signal: CancellationToken,
    pub ctx: Context,
    pub sequential: bool,
    pub filter: Option<ToolFilter>,
    pub on_update: Option<Arc<dyn Fn(String, Value) + Send + Sync>>,
    pub on_start: Option<Arc<dyn Fn(ToolCallBlock) + Send + Sync>>,
}

impl BatchContext {
    pub fn new(
        agent_id: String,
        session_id: String,
        turn_id: String,
        signal: CancellationToken,
        ctx: Context,
    ) -> Self {
        Self {
            agent_id,
            session_id,
            turn_id,
            tenant: None,
            signal,
            ctx,
            sequential: false,
            filter: None,
            on_update: None,
            on_start: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    Parallel,
    Sequential,
}

/// 服务句柄。
#[derive(Clone)]
pub struct ToolRegistryHandle(pub Arc<dyn ToolRegistry>);

impl std::ops::Deref for ToolRegistryHandle {
    type Target = dyn ToolRegistry;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[async_trait::async_trait]
pub trait ToolRegistry: Send + Sync {
    fn register(&self, def: Arc<ToolDefinition>) -> crate::kernel::types::Disposer;
    fn get(&self, name: &str) -> Option<Arc<ToolDefinition>>;
    fn list(&self, filter: Option<&ToolFilter>) -> Vec<Arc<ToolDefinition>>;
    fn schemas(&self, filter: Option<&ToolFilter>) -> Vec<crate::llm::types::ToolSchema>;
    async fn execute_batch(
        &self,
        calls: Vec<ToolCallBlock>,
        batch: BatchContext,
    ) -> Vec<ToolResult>;
}
