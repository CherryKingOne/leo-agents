//! 把流式事件聚合成一条完整的 assistant 消息。

use crate::llm::types::{FinishReason, LlmStreamEvent};
use crate::protocol::messages::{new_id, AgentMessage, ContentBlock, Usage};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct PartialCall {
    id: Option<String>,
    name: Option<String>,
    args: String,
}

pub struct StreamAccumulator {
    pub text: String,
    pub reasoning: String,
    pub reasoning_signature: Option<String>,
    pub calls: BTreeMap<usize, PartialCall>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<FinishReason>,
    pub emitted: bool,
}

impl Default for StreamAccumulator {
    fn default() -> Self {
        Self {
            text: String::new(),
            reasoning: String::new(),
            reasoning_signature: None,
            calls: BTreeMap::new(),
            usage: None,
            finish_reason: None,
            emitted: false,
        }
    }
}

impl StreamAccumulator {
    pub fn push(&mut self, ev: LlmStreamEvent) {
        match ev {
            LlmStreamEvent::TextDelta { text } => {
                self.text.push_str(&text);
                self.emitted = true;
            }
            LlmStreamEvent::ReasoningDelta { text, signature } => {
                self.reasoning.push_str(&text);
                if signature.is_some() {
                    self.reasoning_signature = signature;
                }
                self.emitted = true;
            }
            LlmStreamEvent::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta,
            } => {
                let c = self.calls.entry(index).or_default();
                if let Some(id) = id {
                    c.id = Some(id);
                }
                if let Some(name) = name {
                    c.name = Some(match &c.name {
                        Some(existing) if name.starts_with(existing) => {
                            format!("{}{}", existing, &name[existing.len()..])
                        }
                        _ => name,
                    });
                }
                if let Some(delta) = arguments_delta {
                    c.args.push_str(&delta);
                }
                self.emitted = true;
            }
            LlmStreamEvent::Usage { usage } => {
                let mut merged = self.usage.unwrap_or_default();
                merged.input_tokens = usage.input_tokens;
                merged.output_tokens = usage.output_tokens;
                if usage.cached_input_tokens != 0 {
                    merged.cached_input_tokens = usage.cached_input_tokens;
                }
                if usage.reasoning_tokens != 0 {
                    merged.reasoning_tokens = usage.reasoning_tokens;
                }
                if usage.cost_usd != 0.0 {
                    merged.cost_usd = usage.cost_usd;
                }
                self.usage = Some(merged);
            }
            LlmStreamEvent::Done { finish_reason } => {
                self.finish_reason = Some(finish_reason);
            }
        }
    }

    pub fn to_message(&self, partial: bool) -> AgentMessage {
        let mut content = Vec::new();
        if !self.reasoning.is_empty() {
            content.push(match &self.reasoning_signature {
                Some(sig) => ContentBlock::Reasoning {
                    text: self.reasoning.clone(),
                    signature: Some(sig.clone()),
                },
                None => ContentBlock::Reasoning {
                    text: self.reasoning.clone(),
                    signature: None,
                },
            });
        }
        if !self.text.is_empty() {
            content.push(ContentBlock::Text {
                text: self.text.clone(),
            });
        }
        if !partial {
            for c in self.calls.values() {
                if let Some(name) = &c.name {
                    content.push(ContentBlock::ToolCall {
                        id: c.id.clone().unwrap_or_else(|| new_id("call")),
                        name: name.clone(),
                        arguments: parse_args(&c.args),
                        raw_arguments: c.args.clone(),
                    });
                }
            }
        }
        let mut msg = AgentMessage::new("assistant", content);
        if partial {
            msg.meta = Some(serde_json::json!({ "partial": true }));
        }
        msg
    }
}

fn parse_args(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return serde_json::json!({});
    }
    serde_json::from_str(raw).unwrap_or(Value::Null)
}
