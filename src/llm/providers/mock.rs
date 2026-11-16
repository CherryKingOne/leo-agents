//! 确定性的 Mock Provider：按脚本依次返回响应，记录每次收到的请求。
//! 用于插件单测、Agent Loop 回归测试、离线开发。

use crate::errors::{LeoError, LeoErrorCode};
use crate::llm::types::{
    FinishReason, LlmProvider, LlmRequest, LlmStream, LlmStreamEvent, ModelInfo, StreamOptions,
};
use crate::protocol::messages::Usage;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct MockToolCall {
    pub id: Option<String>,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct MockResponse {
    pub text: Option<String>,
    pub reasoning: Option<String>,
    pub tool_calls: Vec<MockToolCall>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<FinishReason>,
    pub error: Option<LeoError>,
    pub error_after_text: bool,
    pub delay_ms: u64,
}

impl Default for MockResponse {
    fn default() -> Self {
        Self {
            text: None,
            reasoning: None,
            tool_calls: Vec::new(),
            usage: None,
            finish_reason: None,
            error: None,
            error_after_text: false,
            delay_ms: 0,
        }
    }
}

pub enum MockOutcome {
    Response(MockResponse),
    Events(Vec<LlmStreamEvent>),
}

pub type MockStepFn = Arc<dyn Fn(&LlmRequest, usize) -> MockOutcome + Send + Sync>;

#[derive(Clone)]
pub enum MockStep {
    Response(MockResponse),
    Events(Vec<LlmStreamEvent>),
    Fn(MockStepFn),
}

impl From<MockResponse> for MockStep {
    fn from(value: MockResponse) -> Self {
        Self::Response(value)
    }
}

impl From<Vec<LlmStreamEvent>> for MockStep {
    fn from(value: Vec<LlmStreamEvent>) -> Self {
        Self::Events(value)
    }
}

pub struct MockProvider {
    pub id: String,
    pub requests: Mutex<Vec<LlmRequest>>,
    script: Mutex<VecDeque<MockStep>>,
    models: Vec<ModelInfo>,
}

impl MockProvider {
    pub fn new(id: impl Into<String>, script: Vec<MockStep>, models: Vec<ModelInfo>) -> Self {
        Self {
            id: id.into(),
            requests: Mutex::new(Vec::new()),
            script: Mutex::new(script.into()),
            models,
        }
    }

    pub fn push(&self, step: MockStep) {
        self.script.lock().unwrap().push_back(step);
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    pub fn last_request(&self) -> Option<LlmRequest> {
        self.requests.lock().unwrap().last().cloned()
    }
}

#[async_trait::async_trait]
impl LlmProvider for MockProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn get_model_info(&self, model: &str) -> Option<ModelInfo> {
        self.models.iter().find(|m| m.id == model).cloned()
    }

    fn stream(&self, request: LlmRequest, opts: StreamOptions) -> LlmStream {
        let index = {
            let mut reqs = self.requests.lock().unwrap();
            reqs.push(request.clone());
            reqs.len() - 1
        };
        let step = self.script.lock().unwrap().pop_front();
        let signal = opts.signal.clone();
        Box::pin(async_stream::stream! {
            let Some(step) = step else {
                yield Err(LeoError::new(
                    LeoErrorCode::InvalidRequest,
                    format!("MockProvider script exhausted at call #{}", index),
                ));
                return;
            };
            let (events, error, error_after_text, delay_ms) = match step {
                MockStep::Fn(f) => match f(&request, index) {
                    MockOutcome::Response(r) => {
                        let events = to_events(&r);
                        (events, r.error, r.error_after_text, r.delay_ms)
                    }
                    MockOutcome::Events(events) => (events, None, false, 0),
                },
                MockStep::Events(events) => (events, None, false, 0),
                MockStep::Response(r) => {
                    let events = to_events(&r);
                    (events, r.error, r.error_after_text, r.delay_ms)
                }
            };
            if let Some(ref err) = error {
                if !error_after_text {
                    yield Err(err.clone());
                    return;
                }
            }
            for ev in events {
                if signal.is_cancelled() {
                    yield Err(LeoError::new(LeoErrorCode::Cancelled, "Mock stream cancelled"));
                    return;
                }
                if delay_ms > 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                        _ = signal.cancelled() => {
                            yield Err(LeoError::new(LeoErrorCode::Cancelled, "Mock stream cancelled"));
                            return;
                        }
                    }
                }
                yield Ok(ev);
            }
            if let Some(ref err) = error {
                if error_after_text {
                    yield Err(err.clone());
                    return;
                }
            }
        })
    }
}

fn to_events(r: &MockResponse) -> Vec<LlmStreamEvent> {
    let mut out = Vec::new();
    if let Some(reasoning) = &r.reasoning {
        out.push(LlmStreamEvent::ReasoningDelta {
            text: reasoning.clone(),
            signature: None,
        });
    }
    if let Some(text) = &r.text {
        let chars: Vec<char> = text.chars().collect();
        for piece in chars.chunks(8) {
            out.push(LlmStreamEvent::TextDelta {
                text: piece.iter().collect(),
            });
        }
    }
    if r.error.is_some() && r.error_after_text {
        return out;
    }
    for (index, c) in r.tool_calls.iter().enumerate() {
        let raw = match &c.arguments {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let chars: Vec<char> = raw.chars().collect();
        let half = (chars.len() + 1) / 2;
        out.push(LlmStreamEvent::ToolCallDelta {
            index,
            id: Some(c.id.clone().unwrap_or_else(|| format!("call_{}", index))),
            name: Some(c.name.clone()),
            arguments_delta: Some(chars[..half].iter().collect()),
        });
        out.push(LlmStreamEvent::ToolCallDelta {
            index,
            id: None,
            name: None,
            arguments_delta: Some(chars[half..].iter().collect()),
        });
    }
    out.push(LlmStreamEvent::Usage {
        usage: r.usage.unwrap_or(Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Usage::default()
        }),
    });
    out.push(LlmStreamEvent::Done {
        finish_reason: r.finish_reason.unwrap_or(if r.tool_calls.is_empty() {
            FinishReason::Stop
        } else {
            FinishReason::ToolCalls
        }),
    });
    out
}
