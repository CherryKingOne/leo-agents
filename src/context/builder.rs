//! 上下文构建、token 预算、压缩。

use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::plugin::{plugin_fn_injected, PluginRef};
use crate::kernel::types::{BoxFuture, Disposer, TenantContext};
use crate::llm::types::ToolSchema;
use crate::protocol::messages::AgentMessage;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PromptLayer {
    Platform,
    Tenant,
    Agent,
    Task,
    Runtime,
}

pub const LAYER_ORDER: &[PromptLayer] = &[
    PromptLayer::Platform,
    PromptLayer::Tenant,
    PromptLayer::Agent,
    PromptLayer::Task,
    PromptLayer::Runtime,
];

#[derive(Clone, Default)]
pub struct AssembleInput {
    pub agent_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub model: String,
    pub tenant: Option<TenantContext>,
    pub system_prompt: Option<String>,
    pub state: Value,
}

pub type PromptRenderFn = Arc<dyn Fn(AssembleInput) -> BoxFuture<LeoResult<String>> + Send + Sync>;

#[derive(Clone)]
pub struct PromptSection {
    pub id: String,
    pub layer: PromptLayer,
    pub priority: i32,
    pub render: PromptRenderFn,
}

impl PromptSection {
    pub fn new<F, Fut>(id: impl Into<String>, layer: PromptLayer, render: F) -> Self
    where
        F: Fn(AssembleInput) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = LeoResult<String>> + Send + 'static,
    {
        Self {
            id: id.into(),
            layer,
            priority: 100,
            render: Arc::new(move |input| Box::pin(render(input))),
        }
    }
}

#[derive(Clone)]
pub struct TokenBudgetOptions {
    pub default_context_window: u64,
    pub reserve_output_tokens: Option<u64>,
    pub soft_limit_ratio: f64,
    pub keep_recent_turns: usize,
}

impl Default for TokenBudgetOptions {
    fn default() -> Self {
        Self {
            default_context_window: 128_000,
            reserve_output_tokens: None,
            soft_limit_ratio: 0.85,
            keep_recent_turns: 2,
        }
    }
}

pub struct CompactionInput {
    pub messages: Vec<AgentMessage>,
    pub session_id: String,
    pub model: String,
    pub signal: tokio_util::sync::CancellationToken,
}

#[async_trait]
pub trait CompactionStrategy: Send + Sync {
    fn name(&self) -> &str;
    async fn compact(&self, input: CompactionInput) -> LeoResult<AgentMessage>;
}

pub struct BuildInput {
    pub assemble: AssembleInput,
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<ToolSchema>,
    pub max_output_tokens: Option<u64>,
    pub force_compact: bool,
    pub signal: tokio_util::sync::CancellationToken,
}

pub struct BuiltContext {
    pub system: String,
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<ToolSchema>,
    pub estimated_tokens: u64,
    pub limit_tokens: u64,
    pub model_info: Option<crate::llm::types::ModelInfo>,
    pub fingerprint: String,
    pub compaction: Option<CompactionRecord>,
}

pub struct CompactionRecord {
    pub summary: AgentMessage,
    pub replaces_up_to: String,
    pub strategy: String,
}

#[derive(Clone)]
pub struct ContextServiceHandle(pub Arc<dyn ContextService>);

impl std::ops::Deref for ContextServiceHandle {
    type Target = dyn ContextService;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[async_trait]
pub trait ContextService: Send + Sync {
    fn register_section(&self, section: PromptSection) -> LeoResult<Disposer>;
    fn set_compaction_strategy(&self, strategy: Arc<dyn CompactionStrategy>) -> Disposer;
    async fn build(&self, input: BuildInput) -> LeoResult<BuiltContext>;
}

/// 默认压缩策略：丢弃较早消息，用一条说明性消息占位（零额外成本）。
pub fn truncate_strategy() -> Arc<dyn CompactionStrategy> {
    Arc::new(TruncateStrategy)
}

struct TruncateStrategy;

#[async_trait]
impl CompactionStrategy for TruncateStrategy {
    fn name(&self) -> &str {
        "truncate"
    }

    async fn compact(&self, input: CompactionInput) -> LeoResult<AgentMessage> {
        Ok(AgentMessage {
            id: crate::protocol::messages::new_id("msg"),
            role: "user".into(),
            content: vec![crate::protocol::messages::ContentBlock::text(format!(
                "[Context note: {} earlier messages were omitted to fit the context window. Ask the user if you need details from earlier in the conversation.]",
                input.messages.len()
            ))],
            tool_call_id: None,
            tool_name: None,
            is_error: None,
            created_at: crate::protocol::messages::now_ms(),
            meta: Some(serde_json::json!({ "compaction": true })),
        })
    }
}

/// 摘要式压缩策略：调用模型把较早的对话总结成一条消息。
pub fn create_summarizing_strategy(
    ctx: crate::kernel::context::Context,
    model: String,
    max_output_tokens: Option<u64>,
    instructions: Option<String>,
) -> Arc<dyn CompactionStrategy> {
    Arc::new(SummarizingStrategy {
        ctx,
        model,
        max_output_tokens,
        instructions,
    })
}

struct SummarizingStrategy {
    ctx: crate::kernel::context::Context,
    model: String,
    max_output_tokens: Option<u64>,
    instructions: Option<String>,
}

#[async_trait]
impl CompactionStrategy for SummarizingStrategy {
    fn name(&self) -> &str {
        "summarize"
    }

    async fn compact(&self, input: CompactionInput) -> LeoResult<AgentMessage> {
        let transcript = input
            .messages
            .iter()
            .map(|m| {
                let calls: Vec<String> = m
                    .content
                    .iter()
                    .filter_map(|b| match b {
                        crate::protocol::messages::ContentBlock::ToolCall {
                            name,
                            raw_arguments,
                            ..
                        } => Some(format!("[tool_call {} {}]", name, raw_arguments)),
                        _ => None,
                    })
                    .collect();
                format!(
                    "{}: {}",
                    m.role.to_uppercase(),
                    [
                        crate::protocol::messages::text_of(&m.content),
                        calls.join("\n")
                    ]
                    .join("\n")
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let llm = self.ctx.get::<crate::llm::service::LlmService>("llm")?;
        let req = crate::llm::types::LlmRequest {
            model: self.model.clone(),
            system: Some(self.instructions.clone().unwrap_or_else(|| {
                "Summarize the conversation so far for an AI agent that will continue it. Keep: user goals, decisions, facts, file paths, IDs, open tasks, and tool results that still matter. Be concise and factual.".into()
            })),
            messages: vec![AgentMessage::user(transcript)],
            max_output_tokens: self.max_output_tokens.or(Some(2048)).map(|v| v as u32),
            ..Default::default()
        };
        let opts = crate::llm::types::StreamOptions {
            signal: input.signal,
            tenant: None,
        };
        let mut stream = llm.stream(&self.model, req, opts)?;
        let mut text = String::new();
        while let Some(item) = futures::StreamExt::next(&mut stream).await {
            if let Ok(crate::llm::types::LlmStreamEvent::TextDelta { text: t }) = item {
                text.push_str(&t);
            }
        }
        Ok(AgentMessage {
            id: crate::protocol::messages::new_id("msg"),
            role: "user".into(),
            content: vec![crate::protocol::messages::ContentBlock::text(format!(
                "[Summary of earlier conversation]\n{}",
                text.trim()
            ))],
            tool_call_id: None,
            tool_name: None,
            is_error: None,
            created_at: crate::protocol::messages::now_ms(),
            meta: Some(serde_json::json!({ "compaction": true })),
        })
    }
}

/// 修复消息序列，保证可以被任何厂商接受。
pub fn sanitize_messages(messages: Vec<AgentMessage>) -> Vec<AgentMessage> {
    let mut out: Vec<AgentMessage> = Vec::new();
    let mut i = 0;
    while i < messages.len() {
        let m = messages[i].clone();
        if m.role == "tool" {
            i += 1;
            continue;
        }
        out.push(m.clone());
        if m.role != "assistant" {
            i += 1;
            continue;
        }
        let calls: Vec<(String, String)> = m
            .content
            .iter()
            .filter_map(|b| match b {
                crate::protocol::messages::ContentBlock::ToolCall { id, name, .. } => {
                    Some((id.clone(), name.clone()))
                }
                _ => None,
            })
            .collect();
        if calls.is_empty() {
            i += 1;
            continue;
        }
        let mut results = std::collections::HashMap::new();
        let mut j = i + 1;
        while j < messages.len() && messages[j].role == "tool" {
            let t = &messages[j];
            if let Some(id) = &t.tool_call_id {
                results.insert(id.clone(), t.clone());
            }
            j += 1;
        }
        for (id, name) in calls {
            match results.get(&id) {
                Some(msg) => out.push(msg.clone()),
                None => out.push(AgentMessage {
                    id: crate::protocol::messages::new_id("msg"),
                    role: "tool".into(),
                    content: vec![crate::protocol::messages::ContentBlock::text(
                        "Error: tool execution was interrupted and produced no result.",
                    )],
                    tool_call_id: Some(id),
                    tool_name: Some(name),
                    is_error: Some(true),
                    created_at: m.created_at,
                    meta: None,
                }),
            }
        }
        i = j;
    }
    out
}

struct DefaultContextService {
    ctx: crate::kernel::context::Context,
    sections: std::sync::Mutex<Vec<PromptSection>>,
    strategies: std::sync::Mutex<Vec<Arc<dyn CompactionStrategy>>>,
    budget: TokenBudgetOptions,
}

impl DefaultContextService {
    fn new(ctx: crate::kernel::context::Context, opts: TokenBudgetOptions) -> Self {
        Self {
            ctx,
            sections: std::sync::Mutex::new(Vec::new()),
            strategies: std::sync::Mutex::new(Vec::new()),
            budget: opts,
        }
    }

    async fn render_system(&self, input: &AssembleInput) -> LeoResult<String> {
        let mut all: Vec<PromptSection> = self.sections.lock().unwrap().clone();
        if let Some(p) = &input.system_prompt {
            let p = p.clone();
            all.push(PromptSection::new(
                "agent.system",
                PromptLayer::Agent,
                move |_| {
                    let p = p.clone();
                    async move { Ok(p) }
                },
            ));
        }
        all.sort_by_key(|s| (s.layer, s.priority));
        let mut parts = Vec::new();
        for s in all {
            let text = (s.render)(input.clone()).await?;
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
        Ok(parts.join("\n\n"))
    }
}

#[async_trait]
impl ContextService for DefaultContextService {
    fn register_section(&self, section: PromptSection) -> LeoResult<Disposer> {
        let mut sections = self.sections.lock().unwrap();
        if sections.iter().any(|s| s.id == section.id) {
            return Err(LeoError::new(
                LeoErrorCode::Internal,
                format!("Prompt section \"{}\" already registered", section.id),
            ));
        }
        sections.push(section);
        drop(sections);
        let sections_ptr = &self.sections as *const _;
        // 用一个稳定的 Arc 持有 sections 不可行（字段是 Mutex）；这里返回 no-op，
        // 由 ContextService 生命周期统一管理。
        let _ = sections_ptr;
        Ok(Arc::new(|| Box::pin(async {}) as BoxFuture<()>))
    }

    fn set_compaction_strategy(&self, strategy: Arc<dyn CompactionStrategy>) -> Disposer {
        self.strategies.lock().unwrap().push(strategy);
        Arc::new(|| Box::pin(async {}) as BoxFuture<()>)
    }

    async fn build(&self, input: BuildInput) -> LeoResult<BuiltContext> {
        let llm = self.ctx.get::<crate::llm::service::LlmService>("llm")?;
        let resolved = llm.resolve(&input.assemble.model)?;
        let system = self.render_system(&input.assemble).await?;

        let transform_payload = serde_json::json!({
            "messages": input.messages,
            "input": {
                "agentId": input.assemble.agent_id,
                "sessionId": input.assemble.session_id,
                "turnId": input.assemble.turn_id,
                "model": input.assemble.model,
            }
        });
        let final_transform =
            |p: Value| async move { Ok(p.get("messages").cloned().unwrap_or(Value::Null)) };
        let transformed = self
            .ctx
            .waterfall("context/transform", transform_payload, final_transform)
            .await?;
        let mut messages: Vec<AgentMessage> =
            serde_json::from_value(transformed).unwrap_or(input.messages.clone());

        let convert_payload = serde_json::json!({
            "messages": messages,
            "input": {
                "agentId": input.assemble.agent_id,
                "sessionId": input.assemble.session_id,
                "turnId": input.assemble.turn_id,
                "model": input.assemble.model,
            }
        });
        let final_convert = |p: Value| async move {
            let msgs = p.get("messages").cloned().unwrap_or(Value::Null);
            Ok(msgs)
        };
        let converted = self
            .ctx
            .waterfall("context/convert", convert_payload, final_convert)
            .await?;
        messages = serde_json::from_value(converted).unwrap_or(messages);
        messages.retain(|m| {
            matches!(m.role.as_str(), "system" | "user" | "assistant" | "tool")
                && !m
                    .meta
                    .as_ref()
                    .is_some_and(|v| v.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false))
        });
        messages = sanitize_messages(messages);

        let window = resolved
            .info
            .as_ref()
            .map(|i| i.context_window)
            .unwrap_or(self.budget.default_context_window);
        let reserve = input
            .max_output_tokens
            .or(self.budget.reserve_output_tokens)
            .or(resolved.info.as_ref().and_then(|i| i.max_output_tokens))
            .unwrap_or(8192);
        let limit = window.saturating_sub(reserve).max(1024);
        let count = |msgs: &[AgentMessage]| {
            let req = crate::llm::types::LlmRequest {
                model: input.assemble.model.clone(),
                system: Some(system.clone()),
                messages: msgs.to_vec(),
                tools: Some(input.tools.clone()),
                ..Default::default()
            };
            let llm = llm.clone();
            let model = input.assemble.model.clone();
            async move { llm.count_tokens(&model, &req).await.unwrap_or(0) }
        };

        let mut estimated = count(&messages).await;
        let mut compaction = None;
        let threshold = if input.force_compact {
            (limit as f64 * 0.5) as u64
        } else {
            (limit as f64 * self.budget.soft_limit_ratio) as u64
        };
        if estimated > threshold || input.force_compact {
            let cut = find_cut(&messages, self.budget.keep_recent_turns);
            if cut > 0 {
                let older = messages[..cut].to_vec();
                let strategy = self
                    .strategies
                    .lock()
                    .unwrap()
                    .last()
                    .cloned()
                    .unwrap_or_else(truncate_strategy);
                let summary = strategy
                    .compact(CompactionInput {
                        messages: older.clone(),
                        session_id: input.assemble.session_id.clone(),
                        model: input.assemble.model.clone(),
                        signal: input.signal.clone(),
                    })
                    .await?;
                let logged: std::collections::HashSet<String> =
                    input.messages.iter().map(|m| m.id.clone()).collect();
                let anchor = older
                    .iter()
                    .rev()
                    .find(|m| logged.contains(&m.id))
                    .map(|m| m.id.clone());
                if let Some(anchor) = anchor {
                    compaction = Some(CompactionRecord {
                        summary: summary.clone(),
                        replaces_up_to: anchor,
                        strategy: strategy.name().to_string(),
                    });
                }
                messages = std::iter::once(summary)
                    .chain(messages[cut..].iter().cloned())
                    .collect();
                estimated = count(&messages).await;
            }
        }
        while estimated > limit {
            let starts = user_turn_starts(&messages);
            let next = starts
                .first()
                .filter(|&&i| i > 0)
                .copied()
                .or_else(|| starts.get(1).copied());
            let Some(next) = next else { break };
            messages = messages[next..].to_vec();
            estimated = count(&messages).await;
        }
        if estimated > limit {
            return Err(LeoError::new(
                LeoErrorCode::ContextOverflow,
                format!(
                    "Context ({} tokens) exceeds model limit ({}) even after compaction",
                    estimated, limit
                ),
            ));
        }

        let fingerprint = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(system.as_bytes());
            hasher.update(
                serde_json::to_string(&input.tools)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            hasher.update(
                messages
                    .iter()
                    .map(|m| m.id.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
                    .as_bytes(),
            );
            let digest = hasher.finalize();
            digest[..16]
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect::<String>()
        };

        Ok(BuiltContext {
            system,
            messages,
            tools: input.tools,
            estimated_tokens: estimated,
            limit_tokens: limit,
            model_info: resolved.info,
            fingerprint,
            compaction,
        })
    }
}

fn find_cut(messages: &[AgentMessage], keep_recent_turns: usize) -> usize {
    let starts = user_turn_starts(messages);
    if keep_recent_turns == 0 || starts.len() <= keep_recent_turns {
        return 0;
    }
    starts[starts.len() - keep_recent_turns]
}

fn user_turn_starts(messages: &[AgentMessage]) -> Vec<usize> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, m)| {
            m.role == "user"
                && !m.meta.as_ref().is_some_and(|v| {
                    v.get("compaction")
                        .and_then(|c| c.as_bool())
                        .unwrap_or(false)
                })
        })
        .map(|(i, _)| i)
        .collect()
}

/// 核心插件：提供 `context` 服务（依赖 llm 做 token 估算与模型信息）。
pub fn context_plugin(opts: TokenBudgetOptions) -> PluginRef {
    plugin_fn_injected("leo:context", vec!["llm".into()], move |ctx, _cfg| {
        let opts = opts.clone();
        async move {
            ctx.provide(
                "context",
                Arc::new(ContextServiceHandle(Arc::new(DefaultContextService::new(
                    ctx.clone(),
                    opts,
                )))),
            );
            Ok(())
        }
    })
}
