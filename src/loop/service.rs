//! 核心插件：提供 `agentLoop` 服务。

use crate::kernel::plugin::{plugin_fn_injected, PluginRef};
use crate::r#loop::agent::DefaultAgent;
use crate::r#loop::types::{Agent, AgentLoopService, AgentLoopServiceHandle, AgentOptions};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

struct Shared {
    agents: Mutex<HashMap<String, Arc<dyn Agent>>>,
    locks: Arc<Mutex<HashSet<String>>>,
}

pub struct ContextAgentLoopService {
    ctx: crate::kernel::context::Context,
    shared: Arc<Shared>,
}

#[async_trait::async_trait]
impl AgentLoopService for ContextAgentLoopService {
    fn create(&self, opts: AgentOptions) -> Arc<dyn Agent> {
        let locks = self.shared.locks.clone();
        let shared = self.shared.clone();
        let on_dispose: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |id| {
            shared.agents.lock().unwrap().remove(id);
        });
        let agent: Arc<dyn Agent> =
            Arc::new(DefaultAgent::new(self.ctx.clone(), opts, locks, on_dispose));
        self.shared
            .agents
            .lock()
            .unwrap()
            .insert(agent.id().to_string(), agent.clone());
        agent
    }

    fn get(&self, id: &str) -> Option<Arc<dyn Agent>> {
        self.shared.agents.lock().unwrap().get(id).cloned()
    }

    fn list(&self) -> Vec<Arc<dyn Agent>> {
        self.shared
            .agents
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect()
    }
}

/// 核心插件：提供 `agentLoop` 服务。
pub fn agent_loop_plugin() -> PluginRef {
    plugin_fn_injected(
        "leo:agent-loop",
        vec![
            "sessions".into(),
            "llm".into(),
            "tools".into(),
            "context".into(),
        ],
        |ctx, _cfg| async move {
            let shared = Arc::new(Shared {
                agents: Mutex::new(HashMap::new()),
                locks: Arc::new(Mutex::new(HashSet::new())),
            });
            let service = Arc::new(ContextAgentLoopService {
                ctx: ctx.clone(),
                shared,
            });
            let handle = Arc::new(AgentLoopServiceHandle(service.clone()));
            ctx.provide("agentLoop", handle);
            let _ = ctx.effect(|| async {
                let d: crate::kernel::types::Disposer = Arc::new(move || {
                    let service = service.clone();
                    Box::pin(async move {
                        for agent in service.list() {
                            agent.abort(Some("agent loop plugin disposed".into()));
                        }
                    }) as crate::kernel::types::BoxFuture<()>
                });
                Ok(d)
            });
            Ok(())
        },
    )
}
