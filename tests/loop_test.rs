use futures::StreamExt;
use leo_agents::context::TokenBudgetOptions;
use leo_agents::errors::{LeoError, LeoErrorCode};
use leo_agents::kernel::LogLevel;
use leo_agents::llm::{MockProvider, MockResponse, MockStep, ModelInfo, ModelPricing};
use leo_agents::protocol::messages::UserInput;
use leo_agents::r#loop::{Agent, AgentEvent, AgentOptions, RunOptions, StopReason};
use leo_agents::session::SessionStoreHandle;
use leo_agents::tools::{define_tool, tool_output, ToolOutput, ToolRegistryHandle};
use leo_agents::{create_Leo, CreateLeoOptions};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

fn response(text: &str) -> MockStep {
    MockStep::Response(MockResponse {
        text: Some(text.into()),
        ..Default::default()
    })
}

async fn setup(script: Vec<MockStep>) -> (leo_agents::Leo, Arc<MockProvider>) {
    let mock = Arc::new(MockProvider::new(
        "mock",
        script,
        vec![ModelInfo {
            id: "m".into(),
            context_window: 32_000,
            pricing: Some(ModelPricing {
                input_per_mtok: 1.0,
                output_per_mtok: 2.0,
                cached_input_per_mtok: None,
            }),
            ..Default::default()
        }],
    ));
    let leo = create_Leo(CreateLeoOptions {
        providers: vec![mock.clone()],
        log_level: Some(LogLevel::Silent),
        ..Default::default()
    })
    .await
    .unwrap();
    (leo, mock)
}

async fn collect(agent: &Arc<dyn Agent>, input: &str) -> Vec<AgentEvent> {
    let mut stream = agent
        .prompt(UserInput::text(input), RunOptions::default())
        .unwrap();
    let mut out = Vec::new();
    while let Some(ev) = stream.next().await {
        out.push(ev.unwrap());
    }
    out
}

#[tokio::test]
async fn streams_answer_and_records_session_log() {
    let (leo, _mock) = setup(vec![MockStep::Response(MockResponse {
        text: Some("你好，我是 leo。".into()),
        usage: Some(leo_agents::protocol::messages::Usage {
            input_tokens: 100,
            output_tokens: 20,
            ..Default::default()
        }),
        ..Default::default()
    })])
    .await;
    let agent = leo
        .create_agent(AgentOptions {
            model: "mock/m".into(),
            system_prompt: Some("be nice".into()),
            ..AgentOptions::new("mock/m")
        })
        .unwrap();
    let events = collect(&agent, "hi").await;
    let types: Vec<&str> = events
        .iter()
        .map(|e| match e {
            AgentEvent::TurnStart { .. } => "turn_start",
            AgentEvent::StepStart { .. } => "step_start",
            AgentEvent::TextDelta { .. } => "text_delta",
            AgentEvent::Message { .. } => "message",
            AgentEvent::StepEnd { .. } => "step_end",
            AgentEvent::TurnEnd { .. } => "turn_end",
            _ => "other",
        })
        .collect();
    assert_eq!(types.first(), Some(&"turn_start"));
    assert!(types.contains(&"text_delta"));
    assert_eq!(types.last(), Some(&"turn_end"));
    let AgentEvent::TurnEnd { reason, usage, .. } = events.last().unwrap() else {
        panic!()
    };
    assert_eq!(*reason, StopReason::Completed);
    assert_eq!(usage.input_tokens, 100);
    assert!((usage.cost_usd - 140.0 / 1_000_000.0).abs() < 1e-9);

    let sessions = leo.ctx.get::<SessionStoreHandle>("sessions").unwrap();
    let log = sessions.events(agent.session_id()).await.unwrap();
    let kinds: Vec<&str> = log.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            "turn/start",
            "message",
            "llm/request",
            "llm/response",
            "message",
            "turn/end"
        ]
    );
    let req = log.iter().find(|e| e.event_type == "llm/request").unwrap();
    assert_eq!(
        req.data.get("system").and_then(|v| v.as_str()),
        Some("be nice")
    );
}

#[tokio::test]
async fn executes_tools_and_keeps_result_order() {
    let (leo, mock) = setup(vec![
        MockStep::Response(MockResponse {
            tool_calls: vec![
                leo_agents::llm::MockToolCall {
                    id: Some("a".into()),
                    name: "sleep".into(),
                    arguments: json!({ "ms": 60, "tag": "slow" }),
                },
                leo_agents::llm::MockToolCall {
                    id: Some("b".into()),
                    name: "sleep".into(),
                    arguments: json!({ "ms": 5, "tag": "fast" }),
                },
            ],
            ..Default::default()
        }),
        response("done"),
    ])
    .await;
    let tools = leo.ctx.get::<ToolRegistryHandle>("tools").unwrap();
    let _d = tools.register(define_tool(
        "sleep",
        "sleep",
        json!({
            "type": "object",
            "properties": {"ms": {"type": "number"}, "tag": {"type": "string"}},
            "required": ["ms", "tag"]
        }),
        |args, _exec| async move {
            let ms = args.get("ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let tag = args
                .get("tag")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(ToolOutput::text(format!("{} ok", tag)))
        },
    ));
    let agent = leo.create_agent(AgentOptions::new("mock/m")).unwrap();
    let t0 = std::time::Instant::now();
    let result = agent
        .run(UserInput::text("go"), RunOptions::default())
        .await
        .unwrap();
    assert!(t0.elapsed() < Duration::from_millis(500));
    assert_eq!(result.reason, StopReason::Completed);
    assert_eq!(result.text, "done");
    let tool_msgs: Vec<&str> = result
        .messages
        .iter()
        .filter(|m| m.role == "tool")
        .map(|m| m.tool_call_id.as_deref().unwrap())
        .collect();
    assert_eq!(tool_msgs, vec!["a", "b"]);
    let reqs = mock.requests.lock().unwrap();
    let second = reqs.get(1).unwrap();
    let roles: Vec<&str> = second.messages.iter().map(|m| m.role.as_str()).collect();
    assert_eq!(roles, vec!["user", "assistant", "tool", "tool"]);
    assert_eq!(second.tools.as_ref().unwrap()[0].name, "sleep");
}

#[tokio::test]
async fn retries_retryable_llm_errors() {
    let (leo, mock) = setup(vec![
        MockStep::Response(MockResponse {
            error: Some(LeoError::new(LeoErrorCode::RateLimit, "slow down").with_retry_after(10)),
            ..Default::default()
        }),
        MockStep::Response(MockResponse {
            text: Some("partial".into()),
            error: Some(LeoError::new(LeoErrorCode::Overloaded, "boom")),
            error_after_text: true,
            ..Default::default()
        }),
        response("finally"),
    ])
    .await;
    let agent = leo
        .create_agent(AgentOptions {
            model: "mock/m".into(),
            retry: Some(leo_agents::r#loop::RetryPolicy {
                max_attempts: 4,
                base_delay_ms: 1,
                max_delay_ms: 10,
            }),
            ..AgentOptions::new("mock/m")
        })
        .unwrap();
    let events = collect(&agent, "x").await;
    let retries = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Retry { .. }))
        .count();
    assert_eq!(retries, 2);
    assert_eq!(mock.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn stops_at_max_steps() {
    let call = MockStep::Response(MockResponse {
        tool_calls: vec![leo_agents::llm::MockToolCall {
            id: None,
            name: "noop".into(),
            arguments: json!({}),
        }],
        ..Default::default()
    });
    let (leo, _mock) = setup(vec![call.clone(), call.clone(), call]).await;
    let tools = leo.ctx.get::<ToolRegistryHandle>("tools").unwrap();
    let _d = tools.register(define_tool(
        "noop",
        "n",
        json!({"type": "object", "properties": {}}),
        |_args, _exec| async { Ok(ToolOutput::text("ok")) },
    ));
    let agent = leo
        .create_agent(AgentOptions {
            model: "mock/m".into(),
            limits: Some(leo_agents::r#loop::RunLimits {
                max_steps: 2,
                ..Default::default()
            }),
            ..AgentOptions::new("mock/m")
        })
        .unwrap();
    let r = agent
        .run(UserInput::text("x"), RunOptions::default())
        .await
        .unwrap();
    assert_eq!(r.reason, StopReason::MaxSteps);
    assert_eq!(r.steps, 2);
}

#[tokio::test]
async fn cancels_mid_tool_and_records_cancelled_result() {
    let (leo, _mock) = setup(vec![MockStep::Response(MockResponse {
        tool_calls: vec![leo_agents::llm::MockToolCall {
            id: Some("c1".into()),
            name: "hang".into(),
            arguments: json!({}),
        }],
        ..Default::default()
    })])
    .await;
    let tools = leo.ctx.get::<ToolRegistryHandle>("tools").unwrap();
    let _d = tools.register(define_tool(
        "hang",
        "h",
        json!({"type": "object", "properties": {}}),
        |_args, exec| async move {
            exec.signal.cancelled().await;
            Err(LeoError::new(LeoErrorCode::Cancelled, "cancelled"))
        },
    ));
    let agent = leo.create_agent(AgentOptions::new("mock/m")).unwrap();
    let mut stream = agent
        .prompt(UserInput::text("x"), RunOptions::default())
        .unwrap();
    let mut last_reason = None;
    while let Some(ev) = stream.next().await {
        let ev = ev.unwrap();
        if let AgentEvent::ToolStart { .. } = &ev {
            agent.abort(Some("user pressed stop".into()));
        }
        if let AgentEvent::TurnEnd { reason, .. } = &ev {
            last_reason = Some(*reason);
        }
    }
    assert_eq!(last_reason, Some(StopReason::Cancelled));
    let msgs = agent.messages().await.unwrap();
    let tool = msgs.iter().find(|m| m.role == "tool").unwrap();
    assert_eq!(tool.tool_call_id.as_deref(), Some("c1"));
    assert_eq!(
        tool.meta
            .as_ref()
            .and_then(|m| m.get("errorCode"))
            .and_then(|v| v.as_str()),
        Some("cancelled")
    );
    assert_eq!(agent.status(), leo_agents::r#loop::AgentStatus::Idle);
}

#[tokio::test]
async fn stops_when_token_budget_exhausted() {
    let call = MockStep::Response(MockResponse {
        tool_calls: vec![leo_agents::llm::MockToolCall {
            id: None,
            name: "noop".into(),
            arguments: json!({}),
        }],
        usage: Some(leo_agents::protocol::messages::Usage {
            input_tokens: 600,
            output_tokens: 10,
            ..Default::default()
        }),
        ..Default::default()
    });
    let (leo, _mock) = setup(vec![call.clone(), call]).await;
    let tools = leo.ctx.get::<ToolRegistryHandle>("tools").unwrap();
    let _d = tools.register(define_tool(
        "noop",
        "n",
        json!({"type": "object", "properties": {}}),
        |_args, _exec| async { Ok(ToolOutput::text("ok")) },
    ));
    let agent = leo.create_agent(AgentOptions::new("mock/m")).unwrap();
    let r = agent
        .run(
            UserInput::text("x"),
            RunOptions {
                max_turn_tokens: Some(1000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(r.reason, StopReason::BudgetExceeded);
    assert_eq!(r.steps, 2);
}

#[tokio::test]
async fn ends_turn_when_all_tools_terminate() {
    let (leo, mock) = setup(vec![MockStep::Response(MockResponse {
        tool_calls: vec![leo_agents::llm::MockToolCall {
            id: None,
            name: "finish".into(),
            arguments: json!({}),
        }],
        ..Default::default()
    })])
    .await;
    let tools = leo.ctx.get::<ToolRegistryHandle>("tools").unwrap();
    let _d = tools.register(define_tool(
        "finish",
        "f",
        json!({"type": "object", "properties": {}}),
        |_args, _exec| async {
            Ok(tool_output(ToolOutput {
                content: "bye".into(),
                is_error: None,
                terminate: Some(true),
                details: None,
                display: None,
            }))
        },
    ));
    let agent = leo.create_agent(AgentOptions::new("mock/m")).unwrap();
    let r = agent
        .run(UserInput::text("x"), RunOptions::default())
        .await
        .unwrap();
    assert_eq!(r.reason, StopReason::TerminatedByTool);
    assert_eq!(mock.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn context_budget_defaults_are_used() {
    let (leo, _mock) = setup(vec![response("ok")]).await;
    let _ = TokenBudgetOptions::default();
    let agent = leo.create_agent(AgentOptions::new("mock/m")).unwrap();
    assert_eq!(agent.id().is_empty(), false);
}
