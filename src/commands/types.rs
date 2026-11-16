//! 插件注册的斜杠命令：人触发、不经过模型。

use crate::errors::LeoResult;
use crate::kernel::context::Context;
use crate::kernel::types::{BoxFuture, Disposer, TenantContext};
use crate::protocol::display::DisplayBlock;
use crate::protocol::messages::UserInput;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct CommandContext {
    /// 命令名之后的原始参数（已去掉首尾空白）
    pub args: String,
    /// 按空白切分的参数
    pub argv: Vec<String>,
    pub session_id: Option<String>,
    pub surface: String,
    pub user_id: Option<String>,
    pub signal: Option<CancellationToken>,
    pub ctx: Context,
    pub tenant: Option<TenantContext>,
}

#[derive(Debug, Clone, Default)]
pub struct CommandResult {
    pub text: Option<String>,
    pub display: Option<Vec<DisplayBlock>>,
    pub is_error: Option<bool>,
    pub prompt: Option<UserInput>,
}

impl CommandResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            ..Default::default()
        }
    }
}

impl From<&str> for CommandResult {
    fn from(value: &str) -> Self {
        Self::text(value)
    }
}

impl From<String> for CommandResult {
    fn from(value: String) -> Self {
        Self::text(value)
    }
}

pub type CommandRunFn =
    Arc<dyn Fn(CommandContext) -> BoxFuture<LeoResult<CommandResult>> + Send + Sync>;

pub struct CommandDefinition {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub usage: Option<String>,
    pub plugin: Option<String>,
    pub run: CommandRunFn,
}

impl CommandDefinition {
    pub fn new<F, Fut>(name: impl Into<String>, run: F) -> Self
    where
        F: Fn(CommandContext) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = LeoResult<CommandResult>> + Send + 'static,
    {
        Self {
            name: name.into(),
            aliases: Vec::new(),
            description: None,
            usage: None,
            plugin: None,
            run: Arc::new(move |ctx| Box::pin(run(ctx))),
        }
    }

    pub fn aliases(mut self, aliases: Vec<&str>) -> Self {
        self.aliases = aliases.into_iter().map(String::from).collect();
        self
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn usage(mut self, usage: impl Into<String>) -> Self {
        self.usage = Some(usage.into());
        self
    }
}

#[derive(Clone)]
pub struct CommandServiceHandle(pub Arc<dyn CommandService>);

impl std::ops::Deref for CommandServiceHandle {
    type Target = dyn CommandService;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[async_trait::async_trait]
pub trait CommandService: Send + Sync {
    fn register(&self, def: CommandDefinition) -> Disposer;
    fn get(&self, name: &str) -> Option<Arc<CommandDefinition>>;
    fn list(&self) -> Vec<Arc<CommandDefinition>>;
    async fn run(&self, name: &str, ctx: CommandContext) -> LeoResult<Option<CommandResult>>;
}

#[allow(dead_code)]
fn _value(_: Value) {}
