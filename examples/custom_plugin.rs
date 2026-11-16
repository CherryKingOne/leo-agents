//! 插件开发示例：一个函数就是一个插件。

use leo_agents::kernel::{plugin_fn, LogLevel};
use leo_agents::llm::{MockProvider, MockResponse, MockStep, ModelInfo};
use leo_agents::protocol::messages::UserInput;
use leo_agents::r#loop::{AgentOptions, RunOptions};
use leo_agents::tools::{define_tool, ToolOutput, ToolRegistryHandle};
use leo_agents::{create_Leo, CreateLeoOptions};
use serde_json::json;
use std::sync::Arc;

#[derive(Clone)]
struct GreetingService;

impl GreetingService {
    fn greet(&self, name: &str) -> String {
        format!("hi {}", name)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let plugin = plugin_fn("weather", |ctx, _config| async move {
        ctx.provide("greeter", Arc::new(GreetingService));
        let tools = ctx.get::<ToolRegistryHandle>("tools")?;
        let d = tools.register(define_tool(
            "greet",
            "打招呼",
            json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}),
            |args, _exec| async move {
                let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("world");
                Ok(ToolOutput::text(format!("hi {}", name)))
            },
        ));
        ctx.effect(|| async { Ok(d) }).await?;
        Ok(())
    });

    let mock = Arc::new(MockProvider::new(
        "mock",
        vec![MockStep::Response(MockResponse {
            text: Some("你好，我是插件版 leo。".into()),
            ..Default::default()
        })],
        vec![ModelInfo {
            id: "m".into(),
            context_window: 32_000,
            ..Default::default()
        }],
    ));
    let leo = create_Leo(CreateLeoOptions {
        providers: vec![mock],
        log_level: Some(LogLevel::Silent),
        plugins: vec![plugin],
        ..Default::default()
    })
    .await?;

    let greeter = leo.ctx.get::<GreetingService>("greeter")?;
    println!("{}", greeter.greet("leo"));

    let agent = leo.create_agent(AgentOptions::new("mock/m"))?;
    let result = agent
        .run(UserInput::text("你好"), RunOptions::default())
        .await?;
    println!("{}", result.text);
    leo.dispose().await?;
    Ok(())
}
