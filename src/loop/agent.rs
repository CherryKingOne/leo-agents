//! 默认 Agent 实现：一个可直接用于生产的通用 ReAct 式循环。

use crate::context::builder::BuildInput;
use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::context::Context;
use crate::kernel::types::{BoxFuture, Scope, TenantContext};
use crate::llm::service::LlmService;
use crate::llm::types::{FinishReason, LlmRequest, LlmStreamEvent, StreamOptions};
use crate::protocol::messages::{
    add_usage, empty_usage, new_id, text_of, tool_calls_of, AgentMessage, ContentBlock, Usage,
    UserInput,
};
use crate::r#loop::accumulator::StreamAccumulator;
use crate::r#loop::types::{
    Agent, AgentEvent, AgentOptions, AgentStatus, ErrorInfo, RetryPolicy, RunLimits, RunOptions,
    StopReason, TurnResult,
};
use crate::session::types::SessionStoreHandle;
use crate::tools::types::{BatchContext, ToolFilter, ToolRegistryHandle, ToolResult};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const STATUS_IDLE: u8 = 0;
const STATUS_RUNNING: u8 = 1;
const STATUS_DISPOSED: u8 = 2;

struct AgentInner {
    id: String,
    session_id: String,
    options: AgentOptions,
    ctx: Context,
    status: AtomicU8,
    controller: Mutex<Option<CancellationToken>>,
    steer_queue: Mutex<VecDeque<AgentMessage>>,
    follow_up_queue: Mutex<VecDeque<AgentMessage>>,
    locks: Arc<Mutex<HashSet<String>>>,
    on_dispose: Arc<dyn Fn(&str) + Send + Sync>,
}

#[derive(Clone)]
pub struct DefaultAgent {
    inner: Arc<AgentInner>,
}

impl DefaultAgent {
    pub fn new(
        loop_ctx: Context,
        options: AgentOptions,
        locks: Arc<Mutex<HashSet<String>>>,
        on_dispose: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        let id = options.id.clone().unwrap_or_else(|| new_id("agent"));
        let session_id = options.session_id.clone().unwrap_or_else(|| new_id("ses"));
        let mut scope = Scope::default();
        scope.agent_id = Some(id.clone());
        scope.session_id = Some(session_id.clone());
        scope.tenant = options.tenant.clone();
        let ctx = loop_ctx.fork(scope);
        Self {
            inner: Arc::new(AgentInner {
                id,
                session_id,
                options,
                ctx,
                status: AtomicU8::new(STATUS_IDLE),
                controller: Mutex::new(None),
                steer_queue: Mutex::new(VecDeque::new()),
                follow_up_queue: Mutex::new(VecDeque::new()),
                locks,
                on_dispose,
            }),
        }
    }

    fn stream(
        &self,
        input: UserInput,
        opts: RunOptions,
        _on_result: Option<Arc<Mutex<Option<TurnResult>>>>,
    ) -> LeoResult<Pin<Box<dyn futures::Stream<Item = LeoResult<AgentEvent>> + Send>>> {
        if self.inner.status.load(Ordering::SeqCst) == STATUS_DISPOSED {
            return Err(LeoError::new(
                LeoErrorCode::Internal,
                format!("Agent {} is disposed", self.inner.id),
            ));
        }
        {
            let mut locks = self.inner.locks.lock().unwrap();
            if self.inner.status.load(Ordering::SeqCst) == STATUS_RUNNING
                || locks.contains(&self.inner.session_id)
            {
                return Err(LeoError::new(
                    LeoErrorCode::SessionBusy,
                    format!(
                        "Session {} already has an active turn; use steer() or followUp()",
                        self.inner.session_id
                    ),
                ));
            }
            locks.insert(self.inner.session_id.clone());
        }
        self.inner.status.store(STATUS_RUNNING, Ordering::SeqCst);
        let controller = CancellationToken::new();
        *self.inner.controller.lock().unwrap() = Some(controller.clone());
        let (tx, rx) = mpsc::unbounded_channel();
        let inner = self.inner.clone();
        let inner_for_emit = inner.clone();
        let emit: Arc<dyn Fn(AgentEvent) + Send + Sync> = Arc::new(move |event: AgentEvent| {
            let _ = tx.send(Ok(event.clone()));
            let ctx = inner_for_emit.ctx.clone();
            let event_json = serde_json::to_value(&event).unwrap_or(Value::Null);
            tokio::spawn(async move {
                let _ = ctx
                    .emit("agent/event", serde_json::json!({ "event": event_json }))
                    .await;
            });
        });
        let controller_for_task = controller.clone();
        tokio::spawn(async move {
            let _ = run_turn(
                inner.clone(),
                input,
                opts,
                controller_for_task,
                emit.clone(),
            )
            .await;
        });
        Ok(Box::pin(EventStream {
            rx,
            cancel: controller,
        }))
    }
}

// 用一个单独的函数执行 turn，并在结束时复位状态。
async fn run_turn(
    agent: Arc<AgentInner>,
    input: UserInput,
    opts: RunOptions,
    controller: CancellationToken,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync>,
) -> LeoResult<TurnResult> {
    let result = run_turn_inner(agent.clone(), input, opts, controller, emit).await;
    agent.locks.lock().unwrap().remove(&agent.session_id);
    agent.status.store(STATUS_IDLE, Ordering::SeqCst);
    *agent.controller.lock().unwrap() = None;
    result
}

async fn run_turn_inner(
    agent: Arc<AgentInner>,
    input: UserInput,
    opts: RunOptions,
    controller: CancellationToken,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync>,
) -> LeoResult<TurnResult> {
    let sessions = agent.ctx.get::<SessionStoreHandle>("sessions")?;
    let base_limits = agent.options.limits.clone().unwrap_or_default();
    let limits = RunLimits {
        max_steps: opts.max_steps.unwrap_or(base_limits.max_steps),
        max_turn_tokens: opts.max_turn_tokens.or(base_limits.max_turn_tokens),
        max_turn_cost_usd: opts.max_turn_cost_usd.or(base_limits.max_turn_cost_usd),
        turn_timeout_ms: opts.turn_timeout_ms.or(base_limits.turn_timeout_ms),
    };
    let timed_out = Arc::new(AtomicBool::new(false));
    if let Some(timeout) = limits.turn_timeout_ms {
        let cancel = controller.clone();
        let flag = timed_out.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
            flag.store(true, Ordering::SeqCst);
            cancel.cancel();
        });
    }
    if let Some(signal) = &opts.signal {
        let cancel = controller.clone();
        let signal = signal.clone();
        tokio::spawn(async move {
            signal.cancelled().await;
            cancel.cancel();
        });
    }

    let turn_id = new_id("turn");
    let mut added: Vec<AgentMessage> = Vec::new();
    let mut usage = empty_usage();
    let mut steps = 0u32;
    let _reason = StopReason::Completed;
    let _error: Option<LeoError> = None;

    emit(AgentEvent::TurnStart {
        turn_id: turn_id.clone(),
        session_id: agent.session_id.clone(),
    });
    let mut turn_error: Option<LeoError> = None;
    let mut cancelled_by_user = false;
    let mut result: LeoResult<()> = Ok(());
    let mut turn_reason = StopReason::Completed;

    let append_res = sessions
        .append(
            &agent.session_id,
            "turn/start",
            serde_json::json!({ "turnId": turn_id }),
        )
        .await;
    if let Err(e) = append_res {
        result = Err(e);
    }

    if result.is_ok() {
        // 空闲时 steer 的消息排在本次输入之前
        let pending: Vec<AgentMessage> = agent.steer_queue.lock().unwrap().drain(..).collect();
        for m in pending {
            if let Err(e) = sessions
                .append(
                    &agent.session_id,
                    "message",
                    serde_json::json!({ "message": m }),
                )
                .await
            {
                result = Err(e);
                break;
            }
            added.push(m);
        }
        if result.is_ok() {
            let user = user_message(input);
            match sessions
                .append(
                    &agent.session_id,
                    "message",
                    serde_json::json!({ "message": user }),
                )
                .await
            {
                Ok(_) => added.push(user),
                Err(e) => result = Err(e),
            }
        }
    }

    let mut force_compact = false;
    while result.is_ok() {
        if controller.is_cancelled() {
            turn_reason = if timed_out.load(Ordering::SeqCst) {
                StopReason::Timeout
            } else {
                StopReason::Cancelled
            };
            cancelled_by_user = !timed_out.load(Ordering::SeqCst);
            if turn_reason == StopReason::Timeout {
                turn_error = Some(LeoError::new(
                    LeoErrorCode::Timeout,
                    format!("Turn exceeded {}ms", limits.turn_timeout_ms.unwrap_or(0)),
                ));
            }
            break;
        }
        if steps >= limits.max_steps {
            turn_reason = StopReason::MaxSteps;
            break;
        }
        if over_budget(&usage, &limits) {
            turn_reason = StopReason::BudgetExceeded;
            break;
        }
        let pending: Vec<AgentMessage> = agent.steer_queue.lock().unwrap().drain(..).collect();
        for m in pending {
            if let Err(e) = sessions
                .append(
                    &agent.session_id,
                    "message",
                    serde_json::json!({ "message": m }),
                )
                .await
            {
                result = Err(e);
                break;
            }
            added.push(m);
        }
        if !result.is_ok() {
            break;
        }

        let pre_payload = serde_json::json!({
            "agentId": agent.id,
            "turnId": turn_id,
            "step": steps,
            "usage": usage,
        });
        let final_pre: crate::kernel::events::FinalFn = Arc::new(|_| {
            Box::pin(async { Ok(serde_json::json!({ "action": "continue" })) })
                as BoxFuture<LeoResult<Value>>
        });
        let pre = match agent
            .ctx
            .waterfall("agent/pre-step", pre_payload, move |p| final_pre(p))
            .await
        {
            Ok(v) => v,
            Err(e) => {
                result = Err(e);
                break;
            }
        };
        if pre.get("action").and_then(|a| a.as_str()) == Some("stop") {
            turn_reason = pre
                .get("reason")
                .and_then(|r| r.as_str())
                .and_then(stop_reason_from_str)
                .unwrap_or(StopReason::Rejected);
            break;
        }

        steps += 1;
        let step_id = new_id("step");
        emit(AgentEvent::StepStart {
            turn_id: turn_id.clone(),
            step_id: step_id.clone(),
            step: steps,
        });

        let step = match step_once(
            &agent,
            &turn_id,
            &step_id,
            force_compact,
            &controller,
            &emit,
        )
        .await
        {
            Ok(s) => {
                force_compact = false;
                s
            }
            Err(e) => {
                if e.code == LeoErrorCode::ContextOverflow && !force_compact {
                    force_compact = true;
                    steps = steps.saturating_sub(1);
                    continue;
                }
                result = Err(e);
                break;
            }
        };
        usage = add_usage(usage, step.usage);
        if let Err(e) = sessions
            .append(
                &agent.session_id,
                "message",
                serde_json::json!({ "message": step.message }),
            )
            .await
        {
            result = Err(e);
            break;
        }
        added.push(step.message.clone());
        emit(AgentEvent::Message {
            message: step.message.clone(),
        });
        emit(AgentEvent::StepEnd {
            step_id: step_id.clone(),
            finish_reason: step.finish_reason,
            usage: step.usage,
        });

        let calls = tool_calls_of(&step.message);
        if !calls.is_empty() {
            let tools = agent.ctx.get::<ToolRegistryHandle>("tools")?;
            let mut batch = BatchContext::new(
                agent.id.clone(),
                agent.session_id.clone(),
                turn_id.clone(),
                controller.clone(),
                agent.ctx.clone(),
            );
            batch.tenant = agent.options.tenant.clone();
            batch.sequential = agent.options.sequential_tools;
            batch.filter = agent.options.tools.clone();
            {
                let emit = emit.clone();
                batch.on_start = Some(Arc::new(move |call| emit(AgentEvent::ToolStart { call })));
            }
            {
                let emit = emit.clone();
                batch.on_update = Some(Arc::new(move |call_id, partial| {
                    emit(AgentEvent::ToolUpdate { call_id, partial });
                }));
            }
            let call_blocks: Vec<ContentBlock> = calls.into_iter().cloned().collect();
            let results = tools.execute_batch(call_blocks, batch).await;
            let had_results = !results.is_empty();
            let all_terminate = results.iter().all(|r| r.terminate);
            for r in results {
                let m = r.message();
                if let Err(e) = sessions
                    .append(
                        &agent.session_id,
                        "message",
                        serde_json::json!({ "message": m }),
                    )
                    .await
                {
                    result = Err(e);
                    break;
                }
                added.push(m.clone());
                emit(AgentEvent::ToolResult {
                    result: r.clone(),
                    message: m,
                });
            }
            if !result.is_ok() {
                break;
            }
            if controller.is_cancelled() {
                continue;
            }
            if had_results && all_terminate {
                turn_reason = StopReason::TerminatedByTool;
                break;
            }
            continue;
        }

        if step.finish_reason == FinishReason::Length {
            turn_reason = StopReason::Length;
            break;
        }

        let stopping_payload = serde_json::json!({
            "agentId": agent.id,
            "turnId": turn_id,
            "message": step.message,
            "usage": usage,
            "steps": steps,
        });
        let decisions = agent
            .ctx
            .serial("agent/turn-stopping", stopping_payload)
            .await
            .unwrap_or_default();
        let cont = decisions
            .iter()
            .find(|d| d.get("continue").and_then(|c| c.as_bool()).unwrap_or(false));
        if let Some(cont) = cont {
            if let Some(msg) = cont.get("message") {
                let m: AgentMessage =
                    serde_json::from_value(msg.clone()).unwrap_or_else(|_| AgentMessage::user(""));
                if let Err(e) = sessions
                    .append(
                        &agent.session_id,
                        "message",
                        serde_json::json!({ "message": m }),
                    )
                    .await
                {
                    result = Err(e);
                    break;
                }
                added.push(m);
            }
            continue;
        }
        let next = agent.follow_up_queue.lock().unwrap().pop_front();
        if let Some(next) = next {
            if let Err(e) = sessions
                .append(
                    &agent.session_id,
                    "message",
                    serde_json::json!({ "message": next }),
                )
                .await
            {
                result = Err(e);
                break;
            }
            added.push(next);
            continue;
        }
        turn_reason = StopReason::Completed;
        break;
    }

    if let Err(e) = result {
        if timed_out.load(Ordering::SeqCst) {
            turn_reason = StopReason::Timeout;
            turn_error = Some(LeoError::new(
                LeoErrorCode::Timeout,
                format!("Turn exceeded {}ms", limits.turn_timeout_ms.unwrap_or(0)),
            ));
        } else if controller.is_cancelled() || e.code == LeoErrorCode::Cancelled {
            turn_reason = StopReason::Cancelled;
            cancelled_by_user = true;
        } else {
            turn_reason = StopReason::Error;
            turn_error = Some(e);
        }
    }
    let _ = cancelled_by_user;

    let err_info = turn_error.as_ref().map(|e| ErrorInfo {
        code: e.code.as_str().into(),
        message: e.message.clone(),
    });
    let _ = sessions
        .append(
            &agent.session_id,
            "turn/end",
            serde_json::json!({
                "turnId": turn_id,
                "reason": turn_reason.as_str(),
                "usage": usage,
                "steps": steps,
                "error": err_info,
            }),
        )
        .await;
    emit(AgentEvent::TurnEnd {
        turn_id: turn_id.clone(),
        reason: turn_reason,
        usage,
        steps,
        error: err_info,
    });
    let last = added.iter().rev().find(|m| m.role == "assistant");
    let text = last.map(|m| text_of(&m.content)).unwrap_or_default();
    Ok(TurnResult {
        turn_id,
        reason: turn_reason,
        text,
        usage,
        steps,
        messages: added,
        error: turn_error,
    })
}

struct StepOutcome {
    message: AgentMessage,
    usage: crate::protocol::messages::Usage,
    finish_reason: FinishReason,
}

async fn step_once(
    agent: &Arc<AgentInner>,
    turn_id: &str,
    step_id: &str,
    force_compact: bool,
    controller: &CancellationToken,
    emit: &Arc<dyn Fn(AgentEvent) + Send + Sync>,
) -> LeoResult<StepOutcome> {
    let sessions = agent.ctx.get::<SessionStoreHandle>("sessions")?;
    let o = &agent.options;
    let tools = if matches!(&o.tools, Some(f) if f.deny_all) {
        Vec::new()
    } else {
        agent
            .ctx
            .get::<ToolRegistryHandle>("tools")?
            .schemas(o.tools.as_ref())
    };
    let visible = sessions.messages(&agent.session_id).await?;
    let built = agent
        .ctx
        .get::<crate::context::builder::ContextServiceHandle>("context")?
        .build(BuildInput {
            assemble: crate::context::builder::AssembleInput {
                agent_id: agent.id.clone(),
                session_id: agent.session_id.clone(),
                turn_id: turn_id.to_string(),
                model: o.model.clone(),
                tenant: o.tenant.clone(),
                system_prompt: o.system_prompt.clone(),
                state: o.state.clone().unwrap_or(Value::Null),
            },
            messages: visible,
            tools,
            max_output_tokens: o.max_output_tokens.map(|v| v as u64),
            force_compact,
            signal: controller.clone(),
        })
        .await?;
    if let Some(compaction) = &built.compaction {
        let record = serde_json::json!({
            "summary": compaction.summary,
            "replacesUpTo": compaction.replaces_up_to,
            "strategy": compaction.strategy,
        });
        sessions
            .append(&agent.session_id, "compaction", record)
            .await?;
        emit(AgentEvent::Compaction {
            strategy: compaction.strategy.clone(),
            replaces_up_to: compaction.replaces_up_to.clone(),
        });
    }

    let params = serde_json::json!({
        "toolChoice": if built.tools.is_empty() { Value::Null } else { o.tool_choice.as_ref().map(tool_choice_json).unwrap_or(Value::Null) },
        "maxOutputTokens": o.max_output_tokens,
        "temperature": o.temperature,
        "topP": o.top_p,
        "stop": o.stop,
        "reasoning": if o.reasoning.as_ref().is_some_and(|r| r.enabled.is_some() || r.effort.is_some()) { serde_json::to_value(o.reasoning.clone()).unwrap_or(Value::Null) } else { Value::Null },
        "providerOptions": o.provider_options,
    });
    sessions
        .append(
            &agent.session_id,
            "llm/request",
            serde_json::json!({
                "turnId": turn_id,
                "stepId": step_id,
                "model": o.model,
                "system": built.system,
                "messageIds": built.messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
                "tools": built.tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
                "params": params,
                "fingerprint": built.fingerprint,
                "estimatedTokens": built.estimated_tokens,
            }),
        )
        .await?;

    let request = LlmRequest {
        model: o.model.clone(),
        system: if built.system.is_empty() {
            None
        } else {
            Some(built.system.clone())
        },
        messages: built.messages.clone(),
        tools: if built.tools.is_empty() {
            None
        } else {
            Some(built.tools.clone())
        },
        tool_choice: o.tool_choice.clone(),
        max_output_tokens: o.max_output_tokens,
        temperature: o.temperature,
        top_p: o.top_p,
        stop: o.stop.clone(),
        reasoning: o.reasoning.clone(),
        provider_options: o.provider_options.clone(),
    };
    let retry = o.retry.clone().unwrap_or_default();
    let llm = agent.ctx.get::<LlmService>("llm")?;

    let mut attempt = 1;
    loop {
        let mut acc = StreamAccumulator::default();
        let stream_opts = StreamOptions {
            signal: controller.clone(),
            tenant: o.tenant.clone(),
        };
        let mut stream = llm.stream(&o.model, request.clone(), stream_opts)?;
        let mut stream_error: Option<LeoError> = None;
        while let Some(item) = futures::StreamExt::next(&mut stream).await {
            match item {
                Ok(ev) => {
                    match &ev {
                        LlmStreamEvent::TextDelta { text } => emit(AgentEvent::TextDelta {
                            step_id: step_id.into(),
                            text: text.clone(),
                        }),
                        LlmStreamEvent::ReasoningDelta { text, .. } => {
                            emit(AgentEvent::ReasoningDelta {
                                step_id: step_id.into(),
                                text: text.clone(),
                            })
                        }
                        LlmStreamEvent::ToolCallDelta {
                            index,
                            name,
                            arguments_delta,
                            ..
                        } => emit(AgentEvent::ToolCallDelta {
                            step_id: step_id.into(),
                            index: *index,
                            name: name.clone(),
                            arguments_delta: arguments_delta.clone(),
                        }),
                        _ => {}
                    }
                    acc.push(ev);
                }
                Err(e) => {
                    stream_error = Some(e);
                    break;
                }
            }
        }
        if let Some(e) = stream_error {
            if controller.is_cancelled() || e.code == LeoErrorCode::Cancelled {
                if !acc.text.is_empty() || !acc.reasoning.is_empty() {
                    let partial = acc.to_message(true);
                    sessions
                        .append(
                            &agent.session_id,
                            "message",
                            serde_json::json!({ "message": partial }),
                        )
                        .await?;
                    emit(AgentEvent::Message { message: partial });
                }
                return Err(LeoError::new(LeoErrorCode::Cancelled, "Turn cancelled"));
            }
            sessions
                .append(
                    &agent.session_id,
                    "llm/attempt-failed",
                    serde_json::json!({
                        "turnId": turn_id,
                        "stepId": step_id,
                        "attempt": attempt,
                        "code": e.code.as_str(),
                        "message": e.message,
                    }),
                )
                .await?;
            if e.code == LeoErrorCode::ContextOverflow
                || !e.retryable()
                || attempt >= retry.max_attempts
            {
                return Err(e);
            }
            let delay_ms = backoff(attempt, &retry, e.retry_after_ms);
            agent.ctx.logger().warn_fields(serde_json::json!({
                "code": e.code.as_str(), "attempt": attempt, "delayMs": delay_ms, "msg": "LLM request failed, retrying"
            }));
            emit(AgentEvent::Retry {
                step_id: step_id.into(),
                attempt,
                delay_ms,
                error: ErrorInfo {
                    code: e.code.as_str().into(),
                    message: e.message.clone(),
                },
            });
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {}
                _ = controller.cancelled() => return Err(LeoError::new(LeoErrorCode::Cancelled, "Turn cancelled")),
            }
            attempt += 1;
            continue;
        }
        if controller.is_cancelled() {
            if !acc.text.is_empty() || !acc.reasoning.is_empty() {
                let partial = acc.to_message(true);
                sessions
                    .append(
                        &agent.session_id,
                        "message",
                        serde_json::json!({ "message": partial }),
                    )
                    .await?;
                emit(AgentEvent::Message { message: partial });
            }
            return Err(LeoError::new(LeoErrorCode::Cancelled, "Turn cancelled"));
        }
        let message = acc.to_message(false);
        let step_usage = with_cost(
            Usage {
                input_tokens: acc.usage.as_ref().map(|u| u.input_tokens).unwrap_or(0),
                output_tokens: acc.usage.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                cached_input_tokens: acc
                    .usage
                    .as_ref()
                    .map(|u| u.cached_input_tokens)
                    .unwrap_or(0),
                reasoning_tokens: acc.usage.as_ref().map(|u| u.reasoning_tokens).unwrap_or(0),
                cost_usd: acc.usage.as_ref().map(|u| u.cost_usd).unwrap_or(0.0),
            },
            built.model_info.as_ref(),
        );
        let finish_reason = acc
            .finish_reason
            .unwrap_or(if tool_calls_of(&message).is_empty() {
                FinishReason::Stop
            } else {
                FinishReason::ToolCalls
            });
        sessions
            .append(
                &agent.session_id,
                "llm/response",
                serde_json::json!({
                    "turnId": turn_id,
                    "stepId": step_id,
                    "messageId": message.id,
                    "finishReason": finish_reason,
                    "usage": step_usage,
                    "attempts": attempt,
                }),
            )
            .await?;
        let _ = agent.ctx.emit(
            "usage/recorded",
            serde_json::json!({
                "agentId": agent.id,
                "sessionId": agent.session_id,
                "turnId": turn_id,
                "stepId": step_id,
                "model": o.model,
                "usage": step_usage,
                "tenant": o.tenant,
            }),
        );
        return Ok(StepOutcome {
            message,
            usage: step_usage,
            finish_reason,
        });
    }
}

fn user_message(input: UserInput) -> AgentMessage {
    let (content, meta) = crate::protocol::messages::normalize_input(input);
    let mut m = AgentMessage::new("user", content);
    if let Some(meta) = meta {
        m.meta = Some(meta);
    }
    m
}

fn over_budget(usage: &crate::protocol::messages::Usage, limits: &RunLimits) -> bool {
    if let Some(max) = limits.max_turn_tokens {
        if usage.input_tokens + usage.output_tokens >= max {
            return true;
        }
    }
    if let Some(max) = limits.max_turn_cost_usd {
        if usage.cost_usd >= max {
            return true;
        }
    }
    false
}

fn with_cost(
    mut u: crate::protocol::messages::Usage,
    info: Option<&crate::llm::types::ModelInfo>,
) -> crate::protocol::messages::Usage {
    if u.cost_usd != 0.0 {
        return u;
    }
    let Some(info) = info else { return u };
    let Some(pricing) = &info.pricing else {
        return u;
    };
    let cached = u.cached_input_tokens;
    let cost = ((u.input_tokens.saturating_sub(cached)) as f64 * pricing.input_per_mtok
        + cached as f64
            * pricing
                .cached_input_per_mtok
                .unwrap_or(pricing.input_per_mtok)
        + u.output_tokens as f64 * pricing.output_per_mtok)
        / 1_000_000.0;
    u.cost_usd = cost;
    u
}

pub fn backoff(attempt: u32, p: &RetryPolicy, retry_after_ms: Option<u64>) -> u64 {
    if let Some(ms) = retry_after_ms {
        return ms.min(p.max_delay_ms * 2);
    }
    let exp = p.max_delay_ms.min(
        p.base_delay_ms
            .saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1))),
    );
    let jitter = rand_f64();
    ((exp as f64) * (0.5 + jitter * 0.5)).round() as u64
}

fn rand_f64() -> f64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u128(crate::protocol::messages::now_ms() as u128);
    (h.finish() % 1_000_000) as f64 / 1_000_000.0
}

fn stop_reason_from_str(s: &str) -> Option<StopReason> {
    Some(match s {
        "completed" => StopReason::Completed,
        "max_steps" => StopReason::MaxSteps,
        "budget_exceeded" => StopReason::BudgetExceeded,
        "terminated_by_tool" => StopReason::TerminatedByTool,
        "length" => StopReason::Length,
        "rejected" => StopReason::Rejected,
        "cancelled" => StopReason::Cancelled,
        "timeout" => StopReason::Timeout,
        "error" => StopReason::Error,
        _ => return None,
    })
}

fn tool_choice_json(c: &crate::llm::types::ToolChoice) -> Value {
    match c {
        crate::llm::types::ToolChoice::Auto => "auto".into(),
        crate::llm::types::ToolChoice::None => "none".into(),
        crate::llm::types::ToolChoice::Required => "required".into(),
        crate::llm::types::ToolChoice::Named(n) => serde_json::json!({ "name": n }),
    }
}

struct EventStream {
    rx: mpsc::UnboundedReceiver<LeoResult<AgentEvent>>,
    cancel: CancellationToken,
}

impl futures::Stream for EventStream {
    type Item = LeoResult<AgentEvent>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[async_trait]
impl Agent for DefaultAgent {
    fn id(&self) -> &str {
        &self.inner.id
    }

    fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    fn options(&self) -> &AgentOptions {
        &self.inner.options
    }

    fn status(&self) -> AgentStatus {
        match self.inner.status.load(Ordering::SeqCst) {
            STATUS_RUNNING => AgentStatus::Running,
            STATUS_DISPOSED => AgentStatus::Disposed,
            _ => AgentStatus::Idle,
        }
    }

    fn ctx(&self) -> Context {
        self.inner.ctx.clone()
    }

    fn prompt(
        &self,
        input: UserInput,
        opts: RunOptions,
    ) -> LeoResult<Pin<Box<dyn futures::Stream<Item = LeoResult<AgentEvent>> + Send>>> {
        self.stream(input, opts, None)
    }

    async fn run(&self, input: UserInput, opts: RunOptions) -> LeoResult<TurnResult> {
        let stream = self.stream(input, opts, None)?;
        let mut stream = stream;
        let mut last_text = String::new();
        let mut added = Vec::new();
        let mut turn: Option<(
            String,
            StopReason,
            crate::protocol::messages::Usage,
            u32,
            Option<ErrorInfo>,
        )> = None;
        while let Some(item) = futures::StreamExt::next(&mut stream).await {
            match item? {
                AgentEvent::Message { message } => {
                    if message.role == "assistant" {
                        last_text = text_of(&message.content);
                    }
                    added.push(message);
                }
                AgentEvent::ToolResult { message, .. } => added.push(message),
                AgentEvent::TurnEnd {
                    turn_id,
                    reason,
                    usage,
                    steps,
                    error,
                } => {
                    turn = Some((turn_id, reason, usage, steps, error));
                }
                _ => {}
            }
        }
        let (turn_id, reason, usage, steps, error) = turn
            .ok_or_else(|| LeoError::new(LeoErrorCode::Internal, "Turn ended without a result"))?;
        let error = error.map(|e| {
            LeoError::new(
                LeoErrorCode::from_str(&e.code).unwrap_or(LeoErrorCode::Internal),
                e.message,
            )
        });
        Ok(TurnResult {
            turn_id,
            reason,
            text: last_text,
            usage,
            steps,
            messages: added,
            error,
        })
    }

    fn steer(&self, input: UserInput) {
        self.inner
            .steer_queue
            .lock()
            .unwrap()
            .push_back(user_message(input));
    }

    fn follow_up(&self, input: UserInput) {
        self.inner
            .follow_up_queue
            .lock()
            .unwrap()
            .push_back(user_message(input));
    }

    fn abort(&self, reason: Option<String>) {
        if let Some(controller) = self.inner.controller.lock().unwrap().clone() {
            let _ = reason;
            controller.cancel();
        }
    }

    async fn messages(&self) -> LeoResult<Vec<AgentMessage>> {
        let sessions = self.inner.ctx.get::<SessionStoreHandle>("sessions")?;
        sessions.messages(&self.inner.session_id).await
    }

    async fn dispose(&self) -> LeoResult<()> {
        self.abort(Some("agent disposed".into()));
        self.inner.status.store(STATUS_DISPOSED, Ordering::SeqCst);
        (self.inner.on_dispose)(&self.inner.id);
        self.inner.ctx.dispose().await
    }
}

#[allow(dead_code)]
fn _tenant(_: Option<TenantContext>) {}

#[allow(dead_code)]
fn _tool_filter(_: Option<ToolFilter>) {}

#[allow(dead_code)]
fn _result(_: ToolResult) {}

#[allow(dead_code)]
fn _retry(_: RetryPolicy) {}
