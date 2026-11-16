//! Agent 公共类型。

use crate::context::builder::AssembleInput;
use crate::errors::LeoError;
use crate::kernel::context::Context;
use crate::kernel::types::{Disposer, TenantContext};
use crate::llm::types::{FinishReason, ReasoningOptions, ToolChoice};
use crate::protocol::messages::{AgentMessage, ToolCallBlock, Usage, UserInput};
use crate::tools::types::{ToolFilter, ToolResult};
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct RunLimits {
    /// 单个 turn 内最多模型请求次数，默认 50
    pub max_steps: u32,
    pub max_turn_tokens: Option<u64>,
    pub max_turn_cost_usd: Option<f64>,
    pub turn_timeout_ms: Option<u64>,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            max_steps: 50,
            max_turn_tokens: None,
            max_turn_cost_usd: None,
            turn_timeout_ms: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 4,
            base_delay_ms: 1000,
            max_delay_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentOptions {
    pub id: Option<String>,
    pub session_id: Option<String>,
    pub model: String,
    pub system_prompt: Option<String>,
    /// `None` 表示全部工具；`Some` 表示筛选（deny_all=true 表示不使用工具）
    pub tools: Option<ToolFilter>,
    pub tool_choice: Option<ToolChoice>,
    pub sequential_tools: bool,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub stop: Option<Vec<String>>,
    pub reasoning: Option<ReasoningOptions>,
    pub provider_options: Option<serde_json::Value>,
    pub tenant: Option<TenantContext>,
    pub state: Option<serde_json::Value>,
    pub label: Option<String>,
    pub limits: Option<RunLimits>,
    pub retry: Option<RetryPolicy>,
}

impl AgentOptions {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            id: None,
            session_id: None,
            model: model.into(),
            system_prompt: None,
            tools: None,
            tool_choice: None,
            sequential_tools: false,
            max_output_tokens: None,
            temperature: None,
            top_p: None,
            stop: None,
            reasoning: None,
            provider_options: None,
            tenant: None,
            state: None,
            label: None,
            limits: None,
            retry: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub max_steps: Option<u32>,
    pub max_turn_tokens: Option<u64>,
    pub max_turn_cost_usd: Option<f64>,
    pub turn_timeout_ms: Option<u64>,
    pub signal: Option<tokio_util::sync::CancellationToken>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            max_steps: None,
            max_turn_tokens: None,
            max_turn_cost_usd: None,
            turn_timeout_ms: None,
            signal: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Completed,
    MaxSteps,
    BudgetExceeded,
    TerminatedByTool,
    Length,
    Rejected,
    Cancelled,
    Timeout,
    Error,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::MaxSteps => "max_steps",
            Self::BudgetExceeded => "budget_exceeded",
            Self::TerminatedByTool => "terminated_by_tool",
            Self::Length => "length",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    TurnStart {
        turn_id: String,
        session_id: String,
    },
    StepStart {
        turn_id: String,
        step_id: String,
        step: u32,
    },
    TextDelta {
        step_id: String,
        text: String,
    },
    ReasoningDelta {
        step_id: String,
        text: String,
    },
    ToolCallDelta {
        step_id: String,
        index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments_delta: Option<String>,
    },
    Retry {
        step_id: String,
        attempt: u32,
        delay_ms: u64,
        error: ErrorInfo,
    },
    Compaction {
        strategy: String,
        replaces_up_to: String,
    },
    Message {
        message: AgentMessage,
    },
    ToolStart {
        call: ToolCallBlock,
    },
    ToolUpdate {
        call_id: String,
        partial: serde_json::Value,
    },
    ToolResult {
        result: ToolResult,
        message: AgentMessage,
    },
    StepEnd {
        step_id: String,
        finish_reason: FinishReason,
        usage: Usage,
    },
    TurnEnd {
        turn_id: String,
        reason: StopReason,
        usage: Usage,
        steps: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ErrorInfo>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct TurnResult {
    pub turn_id: String,
    pub reason: StopReason,
    pub text: String,
    pub usage: Usage,
    pub steps: u32,
    pub messages: Vec<AgentMessage>,
    pub error: Option<LeoError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Idle,
    Running,
    Disposed,
}

#[derive(Clone)]
pub struct AgentLoopServiceHandle(pub Arc<dyn AgentLoopService>);

impl std::ops::Deref for AgentLoopServiceHandle {
    type Target = dyn AgentLoopService;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[async_trait::async_trait]
pub trait Agent: Send + Sync {
    fn id(&self) -> &str;
    fn session_id(&self) -> &str;
    fn options(&self) -> &AgentOptions;
    fn status(&self) -> AgentStatus;
    fn ctx(&self) -> Context;
    fn prompt(
        &self,
        input: UserInput,
        opts: RunOptions,
    ) -> crate::errors::LeoResult<
        Pin<Box<dyn futures::Stream<Item = crate::errors::LeoResult<AgentEvent>> + Send>>,
    >;
    async fn run(&self, input: UserInput, opts: RunOptions)
        -> crate::errors::LeoResult<TurnResult>;
    fn steer(&self, input: UserInput);
    fn follow_up(&self, input: UserInput);
    fn abort(&self, reason: Option<String>);
    async fn messages(&self) -> crate::errors::LeoResult<Vec<AgentMessage>>;
    async fn dispose(&self) -> crate::errors::LeoResult<()>;
}

#[async_trait::async_trait]
pub trait AgentLoopService: Send + Sync {
    fn create(&self, opts: AgentOptions) -> Arc<dyn Agent>;
    fn get(&self, id: &str) -> Option<Arc<dyn Agent>>;
    fn list(&self) -> Vec<Arc<dyn Agent>>;
}

#[allow(dead_code)]
fn _disposer(_: Disposer) {}

#[allow(dead_code)]
fn _assemble(_: AssembleInput) {}
