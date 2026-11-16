//! 模型提供方与统一流式事件词汇。

use crate::errors::LeoResult;
use crate::kernel::types::TenantContext;
use crate::protocol::messages::{AgentMessage, Usage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::pin::Pin;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// 发送给模型的工具描述（JSON Schema）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Named(String),
}

/// 厂商无关的模型请求。Provider 负责转换为具体 API 格式
#[derive(Debug, Clone, Default, Serialize)]
pub struct LlmRequest {
    /// 模型 id（已去掉 provider 前缀）
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<AgentMessage>,
    pub tools: Option<Vec<ToolSchema>>,
    pub tool_choice: Option<ToolChoice>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub stop: Option<Vec<String>>,
    pub reasoning: Option<ReasoningOptions>,
    pub provider_options: Option<Value>,
}

/// 推理强度。通用档位：`none` 关闭思考；其余逐级增强。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReasoningEffort {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "minimal")]
    Minimal,
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "medium")]
    Medium,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "xhigh")]
    XHigh,
    #[serde(rename = "max")]
    Max,
}

impl ReasoningEffort {
    pub const ALL: &'static [ReasoningEffort] = &[
        Self::None,
        Self::Minimal,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::XHigh,
        Self::Max,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.to_lowercase().as_str() {
            "none" => Self::None,
            "minimal" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::XHigh,
            "max" => Self::Max,
            _ => return None,
        })
    }
}

/// 思考模式开关与推理强度。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReasoningOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Other,
}

/// 统一的流式事件词汇。所有 Provider 都必须输出这套事件。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LlmStreamEvent {
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// 工具调用增量：按 index 聚合；id/name 通常只在首个分片出现
    ToolCallDelta {
        index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments_delta: Option<String>,
    },
    Usage {
        usage: Usage,
    },
    Done {
        finish_reason: FinishReason,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelPricing {
    #[serde(rename = "inputPerMTok")]
    pub input_per_mtok: f64,
    #[serde(rename = "outputPerMTok")]
    pub output_per_mtok: f64,
    #[serde(rename = "cachedInputPerMTok", skip_serializing_if = "Option::is_none")]
    pub cached_input_per_mtok: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub context_window: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ModelReasoningInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReasoningInfo {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_disable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<ReasoningEffort>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<ReasoningEffort>,
}

#[derive(Clone)]
pub struct StreamOptions {
    pub signal: CancellationToken,
    pub tenant: Option<TenantContext>,
}

pub type LlmStream = Pin<Box<dyn futures::Stream<Item = LeoResult<LlmStreamEvent>> + Send>>;

/// 模型提供方接口。实现它并通过 `llm.registerProvider()` 注册，即可接入新厂商。
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> Option<&str> {
        None
    }
    fn default_model(&self) -> Option<&str> {
        None
    }
    fn get_model_info(&self, model: &str) -> Option<ModelInfo>;
    fn list_models(&self) -> Vec<ModelInfo> {
        Vec::new()
    }
    async fn refresh_models(&self) -> LeoResult<Vec<ModelInfo>> {
        Ok(self.list_models())
    }
    fn status(&self) -> Option<ProviderStatusInfo> {
        None
    }
    async fn count_tokens(&self, _request: &LlmRequest) -> Option<u64> {
        None
    }
    fn stream(&self, request: LlmRequest, opts: StreamOptions) -> LlmStream;
}

#[derive(Debug, Clone, Default)]
pub struct ProviderStatusInfo {
    pub ready: bool,
    pub reason: Option<String>,
    pub base_url: Option<String>,
    pub credential: Option<ProviderCredential>,
    pub via: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderCredential {
    pub configured: bool,
    pub masked: String,
    pub source: Option<String>,
}

#[derive(Clone)]
pub struct ResolvedModel {
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub info: Option<ModelInfo>,
}

#[derive(Debug, Clone, Default)]
pub struct RefreshOptions {
    pub signal: Option<CancellationToken>,
}

/// 一个 provider 及其模型
pub struct ProviderModels {
    pub provider: Arc<dyn LlmProvider>,
    pub models: Vec<ModelInfo>,
    pub error: Option<String>,
}
