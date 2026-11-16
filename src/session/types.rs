//! 会话事件与会话存储接口。

use crate::errors::LeoResult;
use crate::protocol::messages::AgentMessage;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 会话事件：只追加（append-only）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// 会话内单调递增序号，从 1 开始
    pub seq: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub at: u64,
    pub data: Value,
}

/// `ctx.get('sessions')`：会话存储。
#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn append(
        &self,
        session_id: &str,
        event_type: &str,
        data: Value,
    ) -> LeoResult<SessionEvent>;
    async fn events(&self, session_id: &str) -> LeoResult<Vec<SessionEvent>>;
    async fn messages(&self, session_id: &str) -> LeoResult<Vec<AgentMessage>>;
    async fn delete(&self, session_id: &str) -> LeoResult<()>;
}

/// 服务句柄：因为 `dyn Trait` 不能做 `Any` 向下转型。
#[derive(Clone)]
pub struct SessionStoreHandle(pub std::sync::Arc<dyn SessionStore>);

impl std::ops::Deref for SessionStoreHandle {
    type Target = dyn SessionStore;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}
