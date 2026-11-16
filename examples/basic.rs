//! 无 API Key 时离线演示：Mock Provider + 自定义工具 + Agent Loop。

use leo_agents::kernel::LogLevel;
use leo_agents::llm::{MockProvider, MockResponse, MockStep, ModelInfo};
use leo_agents::protocol::messages::UserInput;
use leo_agents::r#loop::{AgentOptions, RunOptions};
use leo_agents::tools::{define_tool, ToolOutput, ToolRegistryHandle};
use leo_agents::{create_Leo, CreateLeoOptions};
use serde_json::json;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mock = Arc::new(MockProvider::new(
        "mock",
        vec![MockStep::Response(MockResponse {
            text: Some("你好，我是 leo。1+2=3。".into()),
            ..Default::default()
        })],
        vec![ModelInfo {
            id: "m".into(),
            context_window: 32_000,
            pricing: Some(leo_agents::llm::ModelPricing {
                input_per_mtok: 1.0,
                output_per_mtok: 2.0,
                cached_input_per_mtok: None,
            }),
            ..Default::default()
        }],
    ));
    let leo = create_Leo(CreateLeoOptions {
        providers: vec![mock],
        log_level: Some(LogLevel::Silent),
        ..Default::default()
    })
    .await?;

    let tools = leo.ctx.get::<ToolRegistryHandle>("tools")?;
    let _disposer = tools.register(define_tool(
        "add",
        "两数相加",
        json!({
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"]
        }),
        |args, _exec| async move {
            let a = args.get("a").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let b = args.get("b").and_then(|v| v.as_f64()).unwrap_or(0.0);
            Ok(ToolOutput::text(format!("{}", a + b)))
        },
    ));

    let agent = leo.create_agent(AgentOptions::new("mock/m"))?;
    let result = agent
        .run(UserInput::text("1+2 等于几？"), RunOptions::default())
        .await?;
    println!("{}", result.text);
    println!("reason={:?} steps={}", result.reason, result.steps);
    leo.dispose().await?;
    Ok(())
}
