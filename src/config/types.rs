//! `.leo/config.json` 的结构（项目级）与 `~/.leo/config.json`（用户级）。

use crate::kernel::logger::LogLevel;
use crate::llm::types::ReasoningOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// 插件条目：`"./.leo/plugins/x.js"`、`"leo-plugin-foo"`、`["leo-plugin-foo", { ...config }]`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginEntry {
    Spec(String),
    SpecConfig(String, Value),
}

impl PluginEntry {
    pub fn spec(&self) -> &str {
        match self {
            Self::Spec(s) => s,
            Self::SpecConfig(s, _) => s,
        }
    }

    pub fn config(&self) -> Option<&Value> {
        match self {
            Self::Spec(_) => None,
            Self::SpecConfig(_, c) => Some(c),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BuiltinSelection {
    All(Vec<String>),
    False(bool),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<BuiltinSelection>,
    #[serde(default)]
    pub approval: ApprovalMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default)]
    pub allow_outside_workspace: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bash_timeout_ms: Option<u64>,
}

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            builtin: None,
            approval: ApprovalMode::Ask,
            workspace: None,
            allow_outside_workspace: false,
            bash_timeout_ms: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    Ask,
    Auto,
    Deny,
}

impl ApprovalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::Deny => "deny",
        }
    }
}

impl Default for ApprovalMode {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turn_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turn_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default = "default_true")]
    pub persist: bool,
}

impl Default for SessionsConfig {
    fn default() -> Self {
        Self {
            dir: None,
            persist: true,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserve_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_limit_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_recent_turns: Option<usize>,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            default_context_window: None,
            reserve_output_tokens: None,
            soft_limit_ratio: None,
            keep_recent_turns: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeoConfig {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub providers: BTreeMap<String, Value>,
    #[serde(default)]
    pub plugins: Vec<PluginEntry>,
    #[serde(default)]
    pub tools: ToolsConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub sessions: SessionsConfig,
    #[serde(default)]
    pub context: ContextConfig,
    #[serde(rename = "logLevel", skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl LeoConfig {
    pub fn log_level(&self) -> Option<LogLevel> {
        self.log_level.as_deref().and_then(LogLevel::parse)
    }
}
