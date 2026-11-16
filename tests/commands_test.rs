use leo_agents::commands::{
    CommandContext, CommandDefinition, CommandResult, CommandServiceHandle,
};
use leo_agents::kernel::LogLevel;
use leo_agents::llm::{MockProvider, MockResponse, MockStep, ModelInfo};
use leo_agents::tools::{define_tool, ToolOutput, ToolRegistryHandle};
use leo_agents::{create_Leo, CreateLeoOptions};
use serde_json::json;
use std::sync::Arc;

async fn leo_with_mock() -> leo_agents::Leo {
    let mock = Arc::new(MockProvider::new(
        "mock",
        vec![
            MockStep::Response(MockResponse {
                tool_calls: vec![leo_agents::llm::MockToolCall {
                    id: Some("a".into()),
                    name: "send_sticker".into(),
                    arguments: json!({ "id": "enough" }),
                }],
                ..Default::default()
            }),
            MockStep::Response(MockResponse {
                text: Some("ok".into()),
                ..Default::default()
            }),
        ],
        vec![ModelInfo {
            id: "m".into(),
            context_window: 32_000,
            ..Default::default()
        }],
    ));
    create_Leo(CreateLeoOptions {
        providers: vec![mock],
        log_level: Some(LogLevel::Silent),
        ..Default::default()
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn registers_runs_lists_and_unregisters_commands() {
    let leo = leo_with_mock().await;
    let cmds = leo.ctx.get::<CommandServiceHandle>("commands").unwrap();
    let off = cmds.register(
        CommandDefinition::new("sticker", |ctx: CommandContext| async move {
            Ok(CommandResult {
                text: Some(format!(
                    "{}:{}",
                    ctx.surface,
                    ctx.argv.first().cloned().unwrap_or_default()
                )),
                display: Some(vec![leo_agents::protocol::DisplayBlock::Text {
                    text: "hi".into(),
                }]),
                prompt: Some(leo_agents::protocol::UserInput::text(format!(
                    "[表情] {}",
                    ctx.argv.first().cloned().unwrap_or_default()
                ))),
                is_error: None,
            })
        })
        .aliases(vec!["st"])
        .usage("<id>"),
    );
    assert_eq!(cmds.list().len(), 1);
    let ctx = CommandContext {
        args: "  enough  ".into(),
        argv: vec!["enough".into()],
        session_id: None,
        surface: "cli".into(),
        user_id: None,
        signal: None,
        ctx: leo.ctx.clone(),
        tenant: None,
    };
    let r = cmds.run("st", ctx).await.unwrap().unwrap();
    assert_eq!(r.text.as_deref(), Some("cli:enough"));
    off();
    assert!(cmds
        .run(
            "sticker",
            CommandContext {
                args: String::new(),
                argv: vec![],
                session_id: None,
                surface: "cli".into(),
                user_id: None,
                signal: None,
                ctx: leo.ctx.clone(),
                tenant: None
            }
        )
        .await
        .unwrap()
        .is_none());
    leo.dispose().await.unwrap();
}

#[tokio::test]
async fn passes_tool_display_to_result_event_and_log_but_not_model() {
    let leo = leo_with_mock().await;
    let tools = leo.ctx.get::<ToolRegistryHandle>("tools").unwrap();
    let _d = tools.register(define_tool(
        "send_sticker",
        "send a sticker",
        json!({"type":"object","properties":{"id":{"type":"string"}}}),
        |args, _exec| async move {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            Ok(ToolOutput {
                content: format!("已发送表情 {}", id).into(),
                is_error: None,
                terminate: None,
                details: None,
                display: Some(vec![leo_agents::protocol::DisplayBlock::Ansi {
                    lines: vec!["\x1b[31m▀\x1b[0m".into()],
                    fallback: Some("[这就够了]".into()),
                }]),
            })
        },
    ));
    let agent = leo
        .create_agent(leo_agents::r#loop::AgentOptions::new("mock/m"))
        .unwrap();
    let mut stream = agent
        .prompt(
            leo_agents::protocol::UserInput::text("go"),
            leo_agents::r#loop::RunOptions::default(),
        )
        .unwrap();
    let mut seen = None;
    while let Some(ev) = futures::StreamExt::next(&mut stream).await {
        if let leo_agents::r#loop::AgentEvent::ToolResult { result, .. } = ev.unwrap() {
            seen = result.display;
        }
    }
    assert!(seen.is_some());
    let msgs = agent.messages().await.unwrap();
    let tool = msgs.iter().find(|m| m.role == "tool").unwrap();
    assert!(tool.meta.as_ref().unwrap().get("display").is_some());
    leo.dispose().await.unwrap();
}

#[tokio::test]
async fn turns_string_results_and_errors_into_command_results() {
    let leo = leo_with_mock().await;
    let cmds = leo.ctx.get::<CommandServiceHandle>("commands").unwrap();
    cmds.register(CommandDefinition::new(
        "echo",
        |ctx: CommandContext| async move { Ok(CommandResult::text(ctx.args)) },
    ));
    cmds.register(CommandDefinition::new("boom", |_| async move {
        Err(leo_agents::LeoError::new(
            leo_agents::LeoErrorCode::Internal,
            "nope",
        ))
    }));
    let ctx = CommandContext {
        args: "a b".into(),
        argv: vec!["a".into(), "b".into()],
        session_id: None,
        surface: "gateway".into(),
        user_id: None,
        signal: None,
        ctx: leo.ctx.clone(),
        tenant: None,
    };
    let r = cmds.run("echo", ctx).await.unwrap().unwrap();
    assert_eq!(r.text.as_deref(), Some("a b"));
    let ctx = CommandContext {
        args: String::new(),
        argv: vec![],
        session_id: None,
        surface: "cli".into(),
        user_id: None,
        signal: None,
        ctx: leo.ctx.clone(),
        tenant: None,
    };
    let r = cmds.run("boom", ctx).await.unwrap().unwrap();
    assert_eq!(r.is_error, Some(true));
    assert_eq!(r.text.as_deref(), Some("nope"));
    leo.dispose().await.unwrap();
}
