//! 创建一个 leo 实例：内核 + 核心插件 + 你的插件。

use crate::commands::commands_plugin;
use crate::context::{context_plugin, TokenBudgetOptions};
use crate::errors::LeoResult;
use crate::kernel::{
    create_console_logger, plugin_fn, Context, Kernel, LogLevel, Logger, PluginRef, Scope,
};
use crate::llm::{llm_plugin, provider_plugin, LlmProvider};
use crate::r#loop::{agent_loop_plugin, Agent, AgentLoopServiceHandle, AgentOptions};
use crate::session::session_plugin;
use crate::tools::{tools_plugin, ToolRegistryOptions};
use serde_json::Value;
use std::sync::Arc;

pub struct CreateLeoOptions {
    pub logger: Option<Logger>,
    pub log_level: Option<LogLevel>,
    pub scope: Option<Scope>,
    pub sessions: Option<Option<String>>,
    pub tools: Option<ToolRegistryOptions>,
    pub context: Option<TokenBudgetOptions>,
    pub providers: Vec<Arc<dyn LlmProvider>>,
    pub plugins: Vec<PluginRef>,
    pub core: bool,
}

impl Default for CreateLeoOptions {
    fn default() -> Self {
        Self {
            logger: None,
            log_level: None,
            scope: None,
            sessions: None,
            tools: None,
            context: None,
            providers: Vec::new(),
            plugins: Vec::new(),
            core: true,
        }
    }
}

pub struct Leo {
    pub kernel: Kernel,
    pub ctx: Context,
}

impl Leo {
    pub fn create_agent(&self, opts: AgentOptions) -> LeoResult<Arc<dyn Agent>> {
        let service = self.ctx.get::<AgentLoopServiceHandle>("agentLoop")?;
        Ok(service.create(opts))
    }

    pub async fn plugin(&self, plugin: PluginRef, config: Value) -> LeoResult<()> {
        self.ctx.plugin(plugin, config).await.map(|_| ())
    }

    pub fn describe(&self) -> Value {
        self.kernel.describe()
    }

    pub async fn dispose(&self) -> LeoResult<()> {
        self.kernel.dispose().await
    }
}

#[allow(non_snake_case)]
pub async fn create_Leo(opts: CreateLeoOptions) -> LeoResult<Leo> {
    let logger = opts
        .logger
        .clone()
        .unwrap_or_else(|| create_console_logger(opts.log_level.unwrap_or(LogLevel::Warn)));
    let kernel = Kernel::new(logger, opts.scope.clone().unwrap_or_default());
    let root = kernel.root();
    if opts.core {
        root.plugin(
            session_plugin(opts.sessions.clone().unwrap_or(None)),
            Value::Null,
        )
        .await?;
        root.plugin(llm_plugin(), Value::Null).await?;
        root.plugin(
            tools_plugin(),
            serde_json::to_value(&opts.tools).unwrap_or(Value::Null),
        )
        .await?;
        root.plugin(
            context_plugin(opts.context.clone().unwrap_or_default()),
            Value::Null,
        )
        .await?;
        root.plugin(agent_loop_plugin(), Value::Null).await?;
        root.plugin(commands_plugin(), Value::Null).await?;
    }
    for (i, provider) in opts.providers.iter().enumerate() {
        root.plugin(provider_plugin(provider.clone(), i == 0), Value::Null)
            .await?;
    }
    for plugin in &opts.plugins {
        root.plugin(plugin.clone(), Value::Null).await?;
    }
    kernel.ready().await?;
    Ok(Leo { kernel, ctx: root })
}

#[allow(dead_code)]
fn _plugin() -> PluginRef {
    plugin_fn("noop", |_ctx, _cfg| async { Ok(()) })
}
