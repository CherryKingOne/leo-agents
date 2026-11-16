//! 与模型厂商无关的消息协议。Agent Loop、会话日志、上下文构建都使用这套类型，
//! 由 LLM Provider 负责与具体厂商格式互转。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        url: String,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    /// 模型的推理/思考内容（DeepSeek reasoning_content、Anthropic thinking 等）
    Reasoning {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    ToolCall {
        id: String,
        name: String,
        /// 已解析的参数；解析失败时为 `Value::Null`，原文保存在 raw_arguments
        #[serde(default)]
        arguments: Value,
        #[serde(rename = "rawArguments")]
        raw_arguments: String,
    },
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            _ => None,
        }
    }

    pub fn is_text(&self) -> bool {
        matches!(self, Self::Text { .. })
    }
}

pub type TextBlock = ContentBlock;
pub type ImageBlock = ContentBlock;
pub type ReasoningBlock = ContentBlock;
pub type ToolCallBlock = ContentBlock;

/// 消息角色。可通过自定义字符串扩展（如 'ui/notice'）。
pub type Role = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    pub id: String,
    pub role: Role,
    pub content: Vec<ContentBlock>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

impl AgentMessage {
    pub fn new(role: impl Into<String>, content: Vec<ContentBlock>) -> Self {
        Self {
            id: new_id("msg"),
            role: role.into(),
            content,
            tool_call_id: None,
            tool_name: None,
            is_error: None,
            created_at: now_ms(),
            meta: None,
        }
    }

    pub fn user(text: impl Into<String>) -> Self {
        Self::new("user", vec![ContentBlock::text(text)])
    }

    pub fn meta_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        if self.meta.is_none() {
            self.meta = Some(Value::Object(Default::default()));
        }
        self.meta.as_mut().unwrap().as_object_mut().unwrap()
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub reasoning_tokens: u64,
    #[serde(default)]
    pub cost_usd: f64,
}

pub fn empty_usage() -> Usage {
    Usage::default()
}

pub fn add_usage(a: Usage, b: Usage) -> Usage {
    Usage {
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
        reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
        cost_usd: a.cost_usd + b.cost_usd,
    }
}

/// 用户输入：字符串、内容块数组，或带 meta 的对象。
#[derive(Debug, Clone)]
pub struct UserInput {
    pub content: Vec<ContentBlock>,
    pub meta: Option<Value>,
}

impl UserInput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::text(text)],
            meta: None,
        }
    }

    pub fn blocks(content: Vec<ContentBlock>) -> Self {
        Self {
            content,
            meta: None,
        }
    }

    pub fn with_meta(content: Vec<ContentBlock>, meta: Value) -> Self {
        Self {
            content,
            meta: Some(meta),
        }
    }
}

impl From<&str> for UserInput {
    fn from(value: &str) -> Self {
        Self::text(value)
    }
}

impl From<String> for UserInput {
    fn from(value: String) -> Self {
        Self::text(value)
    }
}

impl From<Vec<ContentBlock>> for UserInput {
    fn from(value: Vec<ContentBlock>) -> Self {
        Self::blocks(value)
    }
}

impl From<ContentBlock> for UserInput {
    fn from(value: ContentBlock) -> Self {
        Self::blocks(vec![value])
    }
}

pub fn normalize_input(input: UserInput) -> (Vec<ContentBlock>, Option<Value>) {
    (input.content, input.meta)
}

pub fn text_of(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| b.as_text())
        .collect::<Vec<_>>()
        .join("")
}

pub fn tool_calls_of(msg: &AgentMessage) -> Vec<&ContentBlock> {
    msg.content
        .iter()
        .filter(|b| matches!(b, ContentBlock::ToolCall { .. }))
        .collect()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成有序且全局唯一的 id（时间戳 + 计数 + 随机）。
pub fn new_id(prefix: &str) -> String {
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed) % 1_000_000;
    let ts = now_ms();
    let rand = rand_suffix();
    format!(
        "{}_{}{}{}",
        prefix,
        to_base36(ts),
        to_base36(counter).to_lowercase(),
        rand
    )
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn rand_suffix() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u64(now_ms());
    h.write_u64(COUNTER.load(Ordering::Relaxed));
    let mut n = h.finish();
    let mut out = String::new();
    for _ in 0..6 {
        out.push(std::char::from_digit((n % 36) as u32, 36).unwrap());
        n /= 36;
    }
    out
}
