//! `commands` 服务：插件注册斜杠命令，交互式 leo、网关等前端分发。

use crate::commands::types::{
    CommandContext, CommandDefinition, CommandResult, CommandService, CommandServiceHandle,
};
use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::context::Context;
use crate::kernel::plugin::{plugin_fn, PluginRef};
use crate::kernel::types::{BoxFuture, Disposer};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

const NAME: &str = r"^[a-z][a-z0-9_-]{0,31}$";

struct CommandInner {
    defs: Mutex<HashMap<String, Arc<CommandDefinition>>>,
}

#[derive(Clone)]
pub struct DefaultCommandService {
    ctx: Context,
    inner: Arc<CommandInner>,
}

impl DefaultCommandService {
    pub fn new(ctx: Context) -> Self {
        Self {
            ctx,
            inner: Arc::new(CommandInner {
                defs: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn register_inner(&self, def: CommandDefinition) -> LeoResult<Disposer> {
        let re = regex::Regex::new(NAME).unwrap();
        let names = std::iter::once(def.name.clone())
            .chain(def.aliases.iter().cloned())
            .collect::<Vec<_>>();
        for n in &names {
            if !re.is_match(n) {
                return Err(LeoError::new(
                    LeoErrorCode::InvalidRequest,
                    format!("Invalid command name \"{}\"", n),
                ));
            }
            if self.get_inner(n).is_some() {
                return Err(LeoError::new(
                    LeoErrorCode::Internal,
                    format!("Command \"/{}\" is already registered", n),
                ));
            }
        }
        let arc = Arc::new(def);
        {
            let mut defs = self.inner.defs.lock().unwrap();
            for n in names {
                defs.insert(n, arc.clone());
            }
        }
        let weak = Arc::downgrade(&self.inner);
        let _key = arc.name.clone();
        Ok(Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                let mut defs = inner.defs.lock().unwrap();
                defs.retain(|_, d| !Arc::ptr_eq(d, &arc));
            }
            Box::pin(async {}) as BoxFuture<()>
        }))
    }

    fn get_inner(&self, name: &str) -> Option<Arc<CommandDefinition>> {
        self.inner.defs.lock().unwrap().get(name).cloned()
    }

    fn list_inner(&self) -> Vec<Arc<CommandDefinition>> {
        let mut seen = std::collections::HashSet::new();
        self.inner
            .defs
            .lock()
            .unwrap()
            .values()
            .filter(|d| seen.insert(Arc::as_ptr(d) as *const ()))
            .cloned()
            .collect()
    }
}

#[async_trait::async_trait]
impl CommandService for DefaultCommandService {
    fn register(&self, def: CommandDefinition) -> Disposer {
        self.register_inner(def).unwrap_or_else(|e| panic!("{}", e))
    }

    fn get(&self, name: &str) -> Option<Arc<CommandDefinition>> {
        self.get_inner(name)
    }

    fn list(&self) -> Vec<Arc<CommandDefinition>> {
        self.list_inner()
    }

    async fn run(&self, name: &str, ctx: CommandContext) -> LeoResult<Option<CommandResult>> {
        let Some(def) = self.get_inner(name) else {
            return Ok(None);
        };
        let args = ctx.args.trim().to_string();
        let argv = if args.is_empty() {
            Vec::new()
        } else {
            args.split_whitespace().map(String::from).collect()
        };
        let surface = ctx.surface.clone();
        let session_id = ctx.session_id.clone();
        let mut call_ctx = ctx;
        call_ctx.args = args;
        call_ctx.argv = argv;
        if call_ctx.ctx.plugin_name().is_empty() {
            call_ctx.ctx = self.ctx.clone();
        }
        let result = match (def.run)(call_ctx).await {
            Ok(r) => r,
            Err(e) => CommandResult {
                text: Some(e.message),
                is_error: Some(true),
                ..Default::default()
            },
        };
        let _ = self
            .ctx
            .emit(
                "commands/executed",
                serde_json::json!({
                    "name": def.name,
                    "surface": surface,
                    "sessionId": session_id,
                    "isError": result.is_error.unwrap_or(false),
                }),
            )
            .await;
        Ok(Some(result))
    }
}

/// 核心插件：提供 `commands` 服务。
pub fn commands_plugin() -> PluginRef {
    plugin_fn("leo:commands", |ctx, _cfg| async move {
        ctx.provide(
            "commands",
            Arc::new(CommandServiceHandle(Arc::new(DefaultCommandService::new(
                ctx.clone(),
            )))),
        );
        Ok(())
    })
}

#[allow(dead_code)]
fn _weak(_: Weak<CommandInner>) {}
