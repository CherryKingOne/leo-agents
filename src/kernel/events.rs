//! 事件总线：所有插件共享同一个总线，监听器按注册顺序执行（`prepend` 可插到最前）。

use crate::errors::{LeoError, LeoResult};
use crate::kernel::logger::Logger;
use crate::kernel::types::{BoxFuture, Disposer};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// waterfall 的 next：可传入改写后的 payload，不传则沿用当前 payload。
pub type NextFn = Arc<dyn Fn(Value) -> BoxFuture<LeoResult<Value>> + Send + Sync>;

/// 事件处理器。返回 `Value::Null` 表示没有结果。
pub type HandlerFn = Arc<dyn Fn(Value, NextFn) -> BoxFuture<LeoResult<Value>> + Send + Sync>;

/// 发布方提供的默认实现（waterfall 最内层）。
pub type FinalFn = Arc<dyn Fn(Value) -> BoxFuture<LeoResult<Value>> + Send + Sync>;

#[derive(Clone)]
struct Entry {
    id: u64,
    owner: String,
    func: HandlerFn,
}

struct EventBusInner {
    handlers: Mutex<HashMap<String, Vec<Entry>>>,
    next_id: AtomicU64,
    logger: Logger,
}

#[derive(Clone)]
pub struct EventBus {
    inner: Arc<EventBusInner>,
}

impl EventBus {
    pub fn new(logger: Logger) -> Self {
        Self {
            inner: Arc::new(EventBusInner {
                handlers: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                logger,
            }),
        }
    }

    pub fn on(&self, event: &str, owner: &str, func: HandlerFn, prepend: bool) -> Disposer {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Entry {
            id,
            owner: owner.to_string(),
            func,
        };
        {
            let mut map = self.inner.handlers.lock().unwrap();
            let list = map.entry(event.to_string()).or_default();
            if prepend {
                list.insert(0, entry);
            } else {
                list.push(entry);
            }
        }
        let weak = Arc::downgrade(&self.inner);
        let event_name = event.to_string();
        Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                let mut map = inner.handlers.lock().unwrap();
                if let Some(list) = map.get_mut(&event_name) {
                    list.retain(|e| e.id != id);
                }
            }
            Box::pin(async {}) as BoxFuture<()>
        })
    }

    pub fn listener_count(&self, event: &str) -> usize {
        self.inner
            .handlers
            .lock()
            .unwrap()
            .get(event)
            .map(|l| l.len())
            .unwrap_or(0)
    }

    fn snapshot(&self, event: &str) -> Vec<Entry> {
        self.inner
            .handlers
            .lock()
            .unwrap()
            .get(event)
            .cloned()
            .unwrap_or_default()
    }

    /// 通知：不等待、不抛出。异常记录日志，绝不影响发布方。
    pub async fn emit(&self, event: &str, payload: Value) {
        for h in self.snapshot(event) {
            let owner = h.owner.clone();
            let next: NextFn = Arc::new(|_| Box::pin(async { Ok(Value::Null) }));
            if let Err(err) = (h.func)(payload.clone(), next).await {
                self.inner.logger.error_fields(serde_json::json!({
                    "err": err.to_string(), "event": event, "plugin": owner, "msg": "event listener failed"
                }));
            }
        }
    }

    /// 并发执行并等待全部完成；任一失败则抛出。
    pub async fn parallel(&self, event: &str, payload: Value) -> LeoResult<()> {
        let entries = self.snapshot(event);
        let mut futs = Vec::new();
        for h in entries {
            let next: NextFn = Arc::new(|_| Box::pin(async { Ok(Value::Null) }));
            futs.push((h.func)(payload.clone(), next));
        }
        let results = futures::future::join_all(futs).await;
        for r in results {
            r?;
        }
        Ok(())
    }

    /// 串行执行，收集所有非空（非 Null）的返回值。
    pub async fn serial(&self, event: &str, payload: Value) -> LeoResult<Vec<Value>> {
        let mut out = Vec::new();
        for h in self.snapshot(event) {
            let next: NextFn = Arc::new(|_| Box::pin(async { Ok(Value::Null) }));
            let r = (h.func)(payload.clone(), next).await?;
            if !r.is_null() {
                out.push(r);
            }
        }
        Ok(out)
    }

    /// 闸门：返回第一个非空的结果；都没有则返回 None。
    pub async fn bail(&self, event: &str, payload: Value) -> LeoResult<Option<Value>> {
        for h in self.snapshot(event) {
            let next: NextFn = Arc::new(|_| Box::pin(async { Ok(Value::Null) }));
            let r = (h.func)(payload.clone(), next).await?;
            if !r.is_null() {
                return Ok(Some(r));
            }
        }
        Ok(None)
    }

    /// 洋葱中间件。`final_fn` 是发布方提供的默认实现（最内层）。
    pub async fn waterfall(
        &self,
        event: &str,
        payload: Value,
        final_fn: FinalFn,
    ) -> LeoResult<Value> {
        let chain = Arc::new(self.snapshot(event));
        run_chain(chain, 0, payload, final_fn).await
    }
}

fn run_chain(
    chain: Arc<Vec<Entry>>,
    index: usize,
    payload: Value,
    final_fn: FinalFn,
) -> BoxFuture<LeoResult<Value>> {
    Box::pin(async move {
        if index >= chain.len() {
            return final_fn(payload).await;
        }
        let entry = chain[index].clone();
        let next_chain = chain.clone();
        let next_final = final_fn.clone();
        let next: NextFn = Arc::new(move |p: Value| {
            run_chain(next_chain.clone(), index + 1, p, next_final.clone())
        });
        (entry.func)(payload, next).await
    })
}

#[allow(dead_code)]
fn _event_error(err: LeoError) -> LeoError {
    err
}
