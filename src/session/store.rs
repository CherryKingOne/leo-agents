//! 会话存储实现：内存与 JSONL 文件。

use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::plugin::{plugin_fn, PluginRef};
use crate::protocol::messages::{new_id, AgentMessage};
use crate::session::types::{SessionEvent, SessionStore, SessionStoreHandle};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

/// 从事件日志投影出当前可见的消息列表（应用压缩）。
pub fn derive_messages(events: &[SessionEvent]) -> Vec<AgentMessage> {
    let mut out: Vec<AgentMessage> = Vec::new();
    for e in events {
        if e.event_type == "message" {
            if let Some(msg) = e.data.get("message") {
                if let Ok(m) = serde_json::from_value::<AgentMessage>(msg.clone()) {
                    out.push(m);
                }
            }
        } else if e.event_type == "compaction" {
            let replaces_up_to = e
                .data
                .get("replacesUpTo")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let summary = e
                .data
                .get("summary")
                .cloned()
                .and_then(|v| serde_json::from_value::<AgentMessage>(v).ok());
            if let Some(summary) = summary {
                let idx = out.iter().position(|m| m.id == replaces_up_to);
                let mut next = vec![summary];
                if let Some(idx) = idx {
                    next.extend(out[idx + 1..].iter().cloned());
                } else {
                    next.extend(out.iter().cloned());
                }
                out = next;
            }
        }
    }
    out
}

type AppendHook = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// 内存会话存储：开发与测试使用，进程重启后丢失。
pub struct InMemorySessionStore {
    data: Mutex<HashMap<String, Vec<SessionEvent>>>,
    on_append: Option<AppendHook>,
}

impl InMemorySessionStore {
    pub fn new(on_append: Option<AppendHook>) -> Self {
        Self {
            data: Mutex::new(HashMap::new()),
            on_append,
        }
    }
}

#[async_trait]
impl SessionStore for InMemorySessionStore {
    async fn append(
        &self,
        session_id: &str,
        event_type: &str,
        data: Value,
    ) -> LeoResult<SessionEvent> {
        let mut map = self.data.lock().unwrap();
        let list = map.entry(session_id.to_string()).or_default();
        let event = SessionEvent {
            id: new_id("evt"),
            session_id: session_id.to_string(),
            seq: list.len() as u64 + 1,
            event_type: event_type.to_string(),
            at: crate::protocol::messages::now_ms(),
            data,
        };
        list.push(event.clone());
        drop(map);
        if let Some(hook) = &self.on_append {
            hook(event.clone());
        }
        Ok(event)
    }

    async fn events(&self, session_id: &str) -> LeoResult<Vec<SessionEvent>> {
        Ok(self
            .data
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn messages(&self, session_id: &str) -> LeoResult<Vec<AgentMessage>> {
        let events = self.events(session_id).await?;
        Ok(derive_messages(&events))
    }

    async fn delete(&self, session_id: &str) -> LeoResult<()> {
        self.data.lock().unwrap().remove(session_id);
        Ok(())
    }
}

/// JSONL 文件会话存储：每个会话一个 `<dir>/<sessionId>.jsonl`，追加写入。
pub struct FileSessionStore {
    dir: PathBuf,
    seq: Mutex<HashMap<String, u64>>,
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    on_append: Option<AppendHook>,
}

impl FileSessionStore {
    pub fn new(dir: impl Into<PathBuf>, on_append: Option<AppendHook>) -> Self {
        Self {
            dir: PathBuf::from(dir.into()),
            seq: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            on_append,
        }
    }

    fn file(&self, session_id: &str) -> LeoResult<PathBuf> {
        let valid = !session_id.is_empty()
            && session_id.len() <= 128
            && session_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-');
        if !valid {
            return Err(LeoError::new(
                LeoErrorCode::Internal,
                format!("Invalid session id for file store: {}", session_id),
            ));
        }
        Ok(self.dir.join(format!("{}.jsonl", session_id)))
    }

    fn lock_for(&self, session_id: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.locks.lock().unwrap();
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

#[async_trait]
impl SessionStore for FileSessionStore {
    async fn append(
        &self,
        session_id: &str,
        event_type: &str,
        data: Value,
    ) -> LeoResult<SessionEvent> {
        let lock = self.lock_for(session_id);
        let _guard = lock.lock().await;
        let existing = self.events(session_id).await?.len() as u64;
        let next_seq = {
            let mut seq = self.seq.lock().unwrap();
            if !seq.contains_key(session_id) {
                seq.insert(session_id.to_string(), existing);
            }
            let n = seq.get(session_id).copied().unwrap_or(0) + 1;
            seq.insert(session_id.to_string(), n);
            n
        };
        let event = SessionEvent {
            id: new_id("evt"),
            session_id: session_id.to_string(),
            seq: next_seq,
            event_type: event_type.to_string(),
            at: crate::protocol::messages::now_ms(),
            data,
        };
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
        let file = self.file(session_id)?;
        let line = serde_json::to_string(&event)
            .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .await
            .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
        f.write_all(line.as_bytes())
            .await
            .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
        f.write_all(b"\n")
            .await
            .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
        drop(_guard);
        if let Some(hook) = &self.on_append {
            hook(event.clone());
        }
        Ok(event)
    }

    async fn events(&self, session_id: &str) -> LeoResult<Vec<SessionEvent>> {
        let file = self.file(session_id)?;
        let text = match tokio::fs::read_to_string(&file).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(LeoError::new(LeoErrorCode::Internal, e.to_string())),
        };
        let mut out = Vec::new();
        for line in text.lines().filter(|l| !l.is_empty()) {
            let event = serde_json::from_str::<SessionEvent>(line)
                .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
            out.push(event);
        }
        Ok(out)
    }

    async fn messages(&self, session_id: &str) -> LeoResult<Vec<AgentMessage>> {
        let events = self.events(session_id).await?;
        Ok(derive_messages(&events))
    }

    async fn delete(&self, session_id: &str) -> LeoResult<()> {
        let file = self.file(session_id)?;
        match tokio::fs::remove_file(&file).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(LeoError::new(LeoErrorCode::Internal, e.to_string())),
        }
        self.seq.lock().unwrap().remove(session_id);
        Ok(())
    }
}

/// 核心插件：提供 `sessions` 服务（默认内存实现）。
pub fn session_plugin(dir: Option<String>) -> PluginRef {
    plugin_fn("leo:sessions", move |ctx, _cfg| {
        let dir = dir.clone();
        async move {
            let ctx2 = ctx.clone();
            let hook: AppendHook = Arc::new(move |e: SessionEvent| {
                let ctx = ctx2.clone();
                tokio::spawn(async move {
                    let _ = ctx
                        .emit(
                            "session/appended",
                            serde_json::to_value(e).unwrap_or(Value::Null),
                        )
                        .await;
                });
            });
            let store: Arc<dyn SessionStore> = match dir {
                Some(d) => Arc::new(FileSessionStore::new(d, Some(hook))),
                None => Arc::new(InMemorySessionStore::new(Some(hook))),
            };
            ctx.provide("sessions", Arc::new(SessionStoreHandle(store)));
            Ok(())
        }
    })
}
