//! leo-agents 统一错误类型。
//!
//! 所有内核与核心模块抛出的错误都是 [`LeoError`]，带一个稳定的 `code`，
//! Agent Loop 依据 code 判断是否可重试、是否需要压缩上下文等。

use serde::{Deserialize, Serialize};
use std::fmt;

/// 稳定错误码。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LeoErrorCode {
    // —— LLM 调用 ——
    #[serde(rename = "rate_limit")]
    RateLimit,
    #[serde(rename = "overloaded")]
    Overloaded,
    #[serde(rename = "timeout")]
    Timeout,
    #[serde(rename = "network")]
    Network,
    #[serde(rename = "context_overflow")]
    ContextOverflow,
    #[serde(rename = "auth")]
    Auth,
    #[serde(rename = "invalid_request")]
    InvalidRequest,
    // —— 工具 ——
    #[serde(rename = "tool_not_found")]
    ToolNotFound,
    #[serde(rename = "tool_invalid_args")]
    ToolInvalidArgs,
    #[serde(rename = "tool_denied")]
    ToolDenied,
    #[serde(rename = "tool_timeout")]
    ToolTimeout,
    #[serde(rename = "tool_error")]
    ToolError,
    // —— 内核 / 运行时 ——
    #[serde(rename = "service_missing")]
    ServiceMissing,
    #[serde(rename = "plugin_unresolved")]
    PluginUnresolved,
    #[serde(rename = "plugin_config_invalid")]
    PluginConfigInvalid,
    #[serde(rename = "session_busy")]
    SessionBusy,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "budget_exceeded")]
    BudgetExceeded,
    #[serde(rename = "internal")]
    Internal,
}

impl LeoErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RateLimit => "rate_limit",
            Self::Overloaded => "overloaded",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::ContextOverflow => "context_overflow",
            Self::Auth => "auth",
            Self::InvalidRequest => "invalid_request",
            Self::ToolNotFound => "tool_not_found",
            Self::ToolInvalidArgs => "tool_invalid_args",
            Self::ToolDenied => "tool_denied",
            Self::ToolTimeout => "tool_timeout",
            Self::ToolError => "tool_error",
            Self::ServiceMissing => "service_missing",
            Self::PluginUnresolved => "plugin_unresolved",
            Self::PluginConfigInvalid => "plugin_config_invalid",
            Self::SessionBusy => "session_busy",
            Self::Cancelled => "cancelled",
            Self::BudgetExceeded => "budget_exceeded",
            Self::Internal => "internal",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "rate_limit" => Self::RateLimit,
            "overloaded" => Self::Overloaded,
            "timeout" => Self::Timeout,
            "network" => Self::Network,
            "context_overflow" => Self::ContextOverflow,
            "auth" => Self::Auth,
            "invalid_request" => Self::InvalidRequest,
            "tool_not_found" => Self::ToolNotFound,
            "tool_invalid_args" => Self::ToolInvalidArgs,
            "tool_denied" => Self::ToolDenied,
            "tool_timeout" => Self::ToolTimeout,
            "tool_error" => Self::ToolError,
            "service_missing" => Self::ServiceMissing,
            "plugin_unresolved" => Self::PluginUnresolved,
            "plugin_config_invalid" => Self::PluginConfigInvalid,
            "session_busy" => Self::SessionBusy,
            "cancelled" => Self::Cancelled,
            "budget_exceeded" => Self::BudgetExceeded,
            "internal" => Self::Internal,
            _ => return None,
        })
    }

    /// 是否属于可自动重试的错误
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimit | Self::Overloaded | Self::Timeout | Self::Network
        )
    }
}

impl fmt::Display for LeoErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 统一错误。
#[derive(Debug, Clone)]
pub struct LeoError {
    pub code: LeoErrorCode,
    pub message: String,
    pub retry_after_ms: Option<u64>,
    pub status: Option<u16>,
    pub details: Option<serde_json::Value>,
}

impl LeoError {
    pub fn new(code: LeoErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_ms: None,
            status: None,
            details: None,
        }
    }

    pub fn with_retry_after(mut self, ms: u64) -> Self {
        self.retry_after_ms = Some(ms);
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn retryable(&self) -> bool {
        self.code.retryable()
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        map.insert("name".into(), "LeoError".into());
        map.insert("code".into(), self.code.as_str().into());
        map.insert("message".into(), self.message.clone().into());
        if let Some(status) = self.status {
            map.insert("status".into(), status.into());
        }
        if let Some(details) = &self.details {
            map.insert("details".into(), details.clone());
        }
        serde_json::Value::Object(map)
    }
}

impl fmt::Display for LeoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for LeoError {}

pub type LeoResult<T> = Result<T, LeoError>;

/// 把任意错误规范化为 [`LeoError`]。
pub fn to_leo_error(err: &(dyn std::error::Error + 'static), fallback: LeoErrorCode) -> LeoError {
    if let Some(e) = err.downcast_ref::<LeoError>() {
        return e.clone();
    }
    LeoError::new(fallback, err.to_string())
}

/// 把任意 `Box<dyn Error>` 规范化。
pub fn to_leo_error_boxed(
    err: Box<dyn std::error::Error + Send + Sync>,
    fallback: LeoErrorCode,
) -> LeoError {
    to_leo_error(err.as_ref(), fallback)
}

/// 便于 `?` 在返回 `LeoError` 的函数里自动转换普通错误。
pub trait IntoLeoError<T> {
    fn leo(self, fallback: LeoErrorCode) -> LeoResult<T>;
}

impl<T, E: std::error::Error + Send + Sync + 'static> IntoLeoError<T> for Result<T, E> {
    fn leo(self, fallback: LeoErrorCode) -> LeoResult<T> {
        self.map_err(|e| LeoError::new(fallback, e.to_string()))
    }
}

pub fn is_abort_error(err: &(dyn std::error::Error + 'static)) -> bool {
    err.downcast_ref::<LeoError>()
        .is_some_and(|e| e.code == LeoErrorCode::Cancelled)
}
