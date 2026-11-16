//! Context：插件看到的一切。
//!
//! - 服务仓库：`provide(key, impl)` / `get(key)`
//! - 事件：`on` / `emit` / `parallel` / `serial` / `bail` / `waterfall`
//! - 副作用生命周期：通过本 Context 做的每一次注册都会压入撤销栈，插件卸载 / 热重载 / 依赖服务被替换时按 LIFO 顺序自动撤销
//! - 插件树：`plugin()` 加载子插件；`fork()` 派生带作用域（租户/agent/会话）的子上下文

use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::events::{EventBus, FinalFn, HandlerFn, NextFn};
use crate::kernel::logger::Logger;
use crate::kernel::plugin::{noop_plugin, PluginRef, ServiceKey};
use crate::kernel::types::{BoxFuture, Disposer, Scope, TenantContext};
use serde_json::Value;
use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

type AnyArc = Arc<dyn Any + Send + Sync>;

struct ServiceEntry {
    value: AnyArc,
    owner: Arc<PluginRuntime>,
}

pub struct KernelInner {
    pub logger: Logger,
    pub bus: EventBus,
    providers: Mutex<HashMap<String, Vec<ServiceEntry>>>,
    pub runtimes: Mutex<Vec<Arc<PluginRuntime>>>,
    pub root_scope: Scope,
    task_lock: tokio::sync::Mutex<()>,
    busy: AtomicUsize,
    notify: Notify,
}

impl KernelInner {
    fn enqueue<Fut>(self: &Arc<Self>, task: Fut)
    where
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.busy.fetch_add(1, Ordering::SeqCst);
        let inner = self.clone();
        tokio::spawn(async move {
            let _guard = inner.task_lock.lock().await;
            task.await;
            inner.busy.fetch_sub(1, Ordering::SeqCst);
            inner.notify.notify_waiters();
        });
    }

    fn get_service(&self, key: &str) -> Option<AnyArc> {
        let providers = self.providers.lock().unwrap();
        providers
            .get(key)
            .and_then(|list| list.last())
            .map(|e| e.value.clone())
    }

    fn add_provider(self: &Arc<Self>, key: String, value: AnyArc, owner: Arc<PluginRuntime>) {
        {
            let mut providers = self.providers.lock().unwrap();
            providers
                .entry(key.clone())
                .or_default()
                .push(ServiceEntry {
                    value,
                    owner: owner.clone(),
                });
        }
        self.logger.debug_fields(serde_json::json!({
            "service": key, "plugin": owner.name(), "msg": "service provided"
        }));
        self.service_changed(key);
    }

    fn remove_provider(self: &Arc<Self>, key: &str, id: usize) {
        let removed_owner = {
            let mut providers = self.providers.lock().unwrap();
            let Some(list) = providers.get_mut(key) else {
                return;
            };
            let Some(pos) = list
                .iter()
                .position(|e| Arc::as_ptr(&e.value) as *const () as usize == id)
            else {
                return;
            };
            let was_active = pos + 1 == list.len();
            let entry = list.remove(pos);
            if list.is_empty() {
                providers.remove(key);
            }
            was_active.then_some(entry.owner)
        };
        if let Some(owner) = removed_owner {
            self.service_changed(key.to_string());
            let _ = owner;
        }
    }

    fn service_changed(self: &Arc<Self>, key: String) {
        let dependents: Vec<Arc<PluginRuntime>> = self
            .runtimes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.state() == PluginState::Active && r.inject().iter().any(|k| k == &key))
            .cloned()
            .collect();
        let inner = self.clone();
        self.enqueue(async move {
            for r in dependents {
                inner.logger.debug_fields(serde_json::json!({
                    "plugin": r.name(), "service": key, "msg": "dependency changed, restarting plugin"
                }));
                deactivate(&inner, &r).await;
            }
            retry_pending(&inner).await;
        });
    }

    async fn wait_idle(&self) {
        loop {
            let notified = self.notify.notified();
            if self.busy.load(Ordering::SeqCst) == 0 {
                break;
            }
            notified.await;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginState {
    Pending,
    Active,
    Failed,
    Disposed,
}

pub struct PluginRuntime {
    kernel: Weak<KernelInner>,
    pub def: PluginRef,
    pub config: Value,
    pub parent_scope: Scope,
    state: Mutex<PluginState>,
    ctx: Mutex<Option<Context>>,
}

impl PluginRuntime {
    fn new(
        kernel: &Arc<KernelInner>,
        def: PluginRef,
        config: Value,
        parent_scope: Scope,
    ) -> Arc<Self> {
        Arc::new(Self {
            kernel: Arc::downgrade(kernel),
            def,
            config,
            parent_scope,
            state: Mutex::new(PluginState::Pending),
            ctx: Mutex::new(None),
        })
    }

    pub fn name(&self) -> &str {
        self.def.name()
    }

    pub fn inject(&self) -> Vec<ServiceKey> {
        self.def.inject()
    }

    pub fn state(&self) -> PluginState {
        *self.state.lock().unwrap()
    }

    pub fn context(&self) -> Option<Context> {
        self.ctx.lock().unwrap().clone()
    }

    /// 卸载插件：撤销其全部副作用与子插件。
    pub async fn dispose(&self) -> LeoResult<()> {
        let kernel = self
            .kernel
            .upgrade()
            .ok_or_else(|| LeoError::new(LeoErrorCode::Internal, "kernel gone"))?;
        unload(&kernel, self).await
    }
}

struct ContextInner {
    kernel: Weak<KernelInner>,
    runtime: Arc<PluginRuntime>,
    config: Value,
    scope: Scope,
    logger: Logger,
    stack: Mutex<Vec<Disposer>>,
    disposed: AtomicBool,
    abort: CancellationToken,
}

#[derive(Clone)]
pub struct Context {
    inner: Arc<ContextInner>,
}

impl Context {
    fn new(
        kernel: Weak<KernelInner>,
        runtime: Arc<PluginRuntime>,
        config: Value,
        scope: Scope,
        logger: Logger,
    ) -> Self {
        Self {
            inner: Arc::new(ContextInner {
                kernel,
                runtime,
                config,
                scope,
                logger,
                stack: Mutex::new(Vec::new()),
                disposed: AtomicBool::new(false),
                abort: CancellationToken::new(),
            }),
        }
    }

    pub fn logger(&self) -> Logger {
        self.inner.logger.clone()
    }

    pub fn runtime(&self) -> Arc<PluginRuntime> {
        self.inner.runtime.clone()
    }

    pub fn plugin_name(&self) -> &str {
        self.inner.runtime.name()
    }

    pub fn config(&self) -> &Value {
        &self.inner.config
    }

    pub fn scope(&self) -> &Scope {
        &self.inner.scope
    }

    pub fn tenant(&self) -> Option<&TenantContext> {
        self.inner.scope.tenant.as_ref()
    }

    pub fn signal(&self) -> CancellationToken {
        self.inner.abort.clone()
    }

    pub fn is_disposed(&self) -> bool {
        self.inner.disposed.load(Ordering::SeqCst)
    }

    fn kernel(&self) -> LeoResult<Arc<KernelInner>> {
        self.inner
            .kernel
            .upgrade()
            .ok_or_else(|| LeoError::new(LeoErrorCode::Internal, "kernel gone"))
    }

    fn assert_alive(&self) -> LeoResult<()> {
        if self.is_disposed() {
            return Err(LeoError::new(
                LeoErrorCode::Internal,
                format!("Context of plugin \"{}\" is disposed", self.plugin_name()),
            ));
        }
        Ok(())
    }

    // ————————————————————————— 服务 —————————————————————————

    /// 注册服务。同一个键可以被多次 provide，最后一个生效（用于替换默认实现）。
    pub fn provide<T>(&self, key: &str, value: Arc<T>) -> Disposer
    where
        T: Any + Send + Sync + 'static,
    {
        self.assert_alive().expect("context alive");
        let kernel = self.kernel().expect("kernel alive");
        let any: AnyArc = value;
        let id = Arc::as_ptr(&any) as *const () as usize;
        kernel.add_provider(key.to_string(), any, self.inner.runtime.clone());
        let key = key.to_string();
        let kernel_weak = Arc::downgrade(&kernel);
        self.track(Arc::new(move || {
            if let Some(kernel) = kernel_weak.upgrade() {
                kernel.remove_provider(&key, id);
            }
            Box::pin(async {}) as BoxFuture<()>
        }))
    }

    /// 获取服务，缺失则抛出 `service_missing`。
    pub fn get<T>(&self, key: &str) -> LeoResult<Arc<T>>
    where
        T: Any + Send + Sync + 'static,
    {
        let kernel = self.kernel()?;
        let value = kernel.get_service(key).ok_or_else(|| {
            LeoError::new(
                LeoErrorCode::ServiceMissing,
                format!(
                    "Service \"{}\" is not available (plugin \"{}\")",
                    key,
                    self.plugin_name()
                ),
            )
        })?;
        value.downcast::<T>().map_err(|_| {
            LeoError::new(
                LeoErrorCode::ServiceMissing,
                format!("Service \"{}\" has an unexpected type", key),
            )
        })
    }

    /// 获取可选服务，缺失返回 None。
    pub fn maybe<T>(&self, key: &str) -> Option<Arc<T>>
    where
        T: Any + Send + Sync + 'static,
    {
        self.kernel().ok()?.get_service(key)?.downcast::<T>().ok()
    }

    pub fn has(&self, key: &str) -> bool {
        self.kernel()
            .map(|k| k.get_service(key).is_some())
            .unwrap_or(false)
    }

    // ————————————————————————— 事件 —————————————————————————

    pub fn on<F>(&self, event: &str, owner: &str, prepend: bool, handler: F) -> Disposer
    where
        F: Fn(Value, NextFn) -> BoxFuture<LeoResult<Value>> + Send + Sync + 'static,
    {
        self.assert_alive().expect("context alive");
        let kernel = self.kernel().expect("kernel alive");
        let func: HandlerFn = Arc::new(handler);
        let d = kernel.bus.on(event, owner, func, prepend);
        self.track(d)
    }

    /// 注册一个更简单的处理器：只接收 payload，返回可选结果。
    pub fn on_simple<F, Fut>(&self, event: &str, handler: F) -> Disposer
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = LeoResult<Value>> + Send + 'static,
    {
        self.on(event, self.plugin_name(), false, move |payload, _next| {
            Box::pin(handler(payload))
        })
    }

    pub async fn emit(&self, event: &str, payload: Value) {
        if let Ok(kernel) = self.kernel() {
            kernel.bus.emit(event, payload).await;
        }
    }

    pub async fn parallel(&self, event: &str, payload: Value) -> LeoResult<()> {
        self.kernel()?.bus.parallel(event, payload).await
    }

    pub async fn serial(&self, event: &str, payload: Value) -> LeoResult<Vec<Value>> {
        self.kernel()?.bus.serial(event, payload).await
    }

    pub async fn bail(&self, event: &str, payload: Value) -> LeoResult<Option<Value>> {
        self.kernel()?.bus.bail(event, payload).await
    }

    pub async fn waterfall<F, Fut>(
        &self,
        event: &str,
        payload: Value,
        final_fn: F,
    ) -> LeoResult<Value>
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = LeoResult<Value>> + Send + 'static,
    {
        let f: FinalFn = Arc::new(move |p| Box::pin(final_fn(p)));
        self.kernel()?.bus.waterfall(event, payload, f).await
    }

    // ————————————————————————— 副作用 —————————————————————————

    /// 注册任意可撤销副作用（定时器、连接、文件句柄……）。
    pub async fn effect<Fut>(&self, setup: impl FnOnce() -> Fut) -> LeoResult<Disposer>
    where
        Fut: std::future::Future<Output = LeoResult<Disposer>>,
    {
        self.assert_alive()?;
        let d = setup().await?;
        Ok(self.track(d))
    }

    fn track(&self, disposer: Disposer) -> Disposer {
        let once = Arc::new(AtomicBool::new(false));
        let inner = disposer.clone();
        let wrapped: Disposer = Arc::new(move || {
            if once.swap(true, Ordering::SeqCst) {
                return Box::pin(async {}) as BoxFuture<()>;
            }
            let inner = inner.clone();
            Box::pin(async move { inner().await }) as BoxFuture<()>
        });
        self.inner.stack.lock().unwrap().push(wrapped.clone());
        wrapped
    }

    // ————————————————————————— 插件树 —————————————————————————

    pub async fn plugin(&self, plugin: PluginRef, config: Value) -> LeoResult<Arc<PluginRuntime>> {
        self.assert_alive()?;
        let kernel = self.kernel()?;
        let rt = load(&kernel, plugin, config, Some(self.clone())).await?;
        let rt_for_dispose = rt.clone();
        let d: Disposer = Arc::new(move || {
            let rt = rt_for_dispose.clone();
            Box::pin(async move {
                let _ = rt.dispose().await;
            }) as BoxFuture<()>
        });
        self.track(d);
        Ok(rt)
    }

    pub fn fork(&self, scope: Scope) -> Context {
        self.assert_alive().expect("context alive");
        let mut merged = self.inner.scope.clone();
        if scope.tenant.is_some() {
            merged.tenant = scope.tenant;
        }
        if scope.agent_id.is_some() {
            merged.agent_id = scope.agent_id;
        }
        if scope.session_id.is_some() {
            merged.session_id = scope.session_id;
        }
        let mut bindings = serde_json::Map::new();
        if let Some(t) = &merged.tenant {
            bindings.insert("tenantId".into(), t.tenant_id.clone().into());
        }
        if let Some(a) = &merged.agent_id {
            bindings.insert("agentId".into(), a.clone().into());
        }
        if let Some(s) = &merged.session_id {
            bindings.insert("sessionId".into(), s.clone().into());
        }
        let child = Context::new(
            self.inner.kernel.clone(),
            self.inner.runtime.clone(),
            self.inner.config.clone(),
            merged,
            self.inner.logger.child(Value::Object(bindings)),
        );
        let weak = Arc::downgrade(&child.inner);
        let d: Disposer = Arc::new(move || {
            let child = Context {
                inner: weak.clone().upgrade().expect("child context"),
            };
            Box::pin(async move {
                let _ = child.dispose().await;
            }) as BoxFuture<()>
        });
        self.track(d);
        child
    }

    pub async fn dispose(&self) -> LeoResult<()> {
        if self.inner.disposed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.inner.abort.cancel();
        loop {
            let next = self.inner.stack.lock().unwrap().pop();
            let Some(d) = next else { break };
            d().await;
        }
        Ok(())
    }
}

// ————————————————————————— Kernel —————————————————————————

pub struct Kernel {
    inner: Arc<KernelInner>,
    root: Context,
}

impl Kernel {
    pub fn new(logger: Logger, scope: Scope) -> Self {
        let inner = Arc::new_cyclic(|_weak| {
            let bus = EventBus::new(logger.clone());
            KernelInner {
                logger,
                bus,
                providers: Mutex::new(HashMap::new()),
                runtimes: Mutex::new(Vec::new()),
                root_scope: scope,
                task_lock: tokio::sync::Mutex::new(()),
                busy: AtomicUsize::new(0),
                notify: Notify::new(),
            }
        });
        let root_runtime =
            PluginRuntime::new(&inner, noop_plugin("root"), Value::Null, Scope::default());
        *root_runtime.state.lock().unwrap() = PluginState::Active;
        let root = Context::new(
            Arc::downgrade(&inner),
            root_runtime,
            Value::Null,
            inner.root_scope.clone(),
            inner.logger.clone(),
        );
        Self { inner, root }
    }

    pub fn logger(&self) -> Logger {
        self.inner.logger.clone()
    }

    pub fn bus(&self) -> &EventBus {
        &self.inner.bus
    }

    pub fn root(&self) -> Context {
        self.root.clone()
    }

    pub fn plugins(&self) -> Vec<Arc<PluginRuntime>> {
        self.inner.runtimes.lock().unwrap().clone()
    }

    pub async fn load(
        &self,
        plugin: PluginRef,
        config: Value,
        parent: Option<Context>,
    ) -> LeoResult<Arc<PluginRuntime>> {
        load(&self.inner, plugin, config, parent).await
    }

    /// 等待内核稳定（所有服务变化引起的重启都已完成），并检查是否有插件因依赖缺失仍处于 pending 或启动失败。
    pub async fn ready(&self) -> LeoResult<()> {
        self.inner.wait_idle().await;
        let runtimes = self.inner.runtimes.lock().unwrap().clone();
        let pending: Vec<_> = runtimes
            .iter()
            .filter(|r| r.state() == PluginState::Pending)
            .map(|r| {
                let missing = missing_services(&self.inner, r);
                serde_json::json!({ "plugin": r.name(), "missing": missing })
            })
            .collect();
        let failed: Vec<_> = runtimes
            .iter()
            .filter(|r| r.state() == PluginState::Failed)
            .map(|r| serde_json::json!({ "plugin": r.name() }))
            .collect();
        if !pending.is_empty() || !failed.is_empty() {
            let mut desc = Vec::new();
            for p in &pending {
                let missing = p["missing"].as_array().cloned().unwrap_or_default();
                let names: Vec<String> = missing
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                desc.push(format!(
                    "\"{}\" is missing services: {}",
                    p["plugin"].as_str().unwrap_or("?"),
                    names.join(", ")
                ));
            }
            for f in &failed {
                desc.push(format!(
                    "\"{}\" failed to start",
                    f["plugin"].as_str().unwrap_or("?")
                ));
            }
            return Err(LeoError::new(
                LeoErrorCode::PluginUnresolved,
                format!("Some plugins could not start: {}", desc.join("; ")),
            )
            .with_details(serde_json::json!({ "pending": pending, "failed": failed })));
        }
        Ok(())
    }

    pub async fn dispose(&self) -> LeoResult<()> {
        self.root.dispose().await?;
        let runtimes = self.inner.runtimes.lock().unwrap().clone();
        for rt in runtimes.iter().rev() {
            let _ = rt.dispose().await;
        }
        Ok(())
    }

    pub fn describe(&self) -> Value {
        let runtimes = self.inner.runtimes.lock().unwrap().clone();
        let plugins: Vec<Value> = runtimes
            .iter()
            .map(|r| {
                serde_json::json!({
                    "name": r.name(),
                    "state": format!("{:?}", r.state()).to_lowercase(),
                    "inject": r.inject(),
                })
            })
            .collect();
        let providers = self.inner.providers.lock().unwrap();
        let services: Vec<Value> = providers
            .iter()
            .map(|(key, list)| {
                let provider = list
                    .last()
                    .map(|e| e.owner.name().to_string())
                    .unwrap_or_default();
                let shadowed: Vec<String> = list[..list.len().saturating_sub(1)]
                    .iter()
                    .map(|e| e.owner.name().to_string())
                    .collect();
                serde_json::json!({ "key": key, "provider": provider, "shadowed": shadowed })
            })
            .collect();
        serde_json::json!({ "plugins": plugins, "services": services })
    }
}

async fn load(
    kernel: &Arc<KernelInner>,
    plugin: PluginRef,
    config: Value,
    parent: Option<Context>,
) -> LeoResult<Arc<PluginRuntime>> {
    let parsed = plugin.validate(&config)?;
    let scope = parent
        .as_ref()
        .map(|p| p.scope().clone())
        .unwrap_or_else(|| kernel.root_scope.clone());
    let rt = PluginRuntime::new(kernel, plugin, parsed, scope);
    kernel.runtimes.lock().unwrap().push(rt.clone());
    if deps_ready(kernel, &rt) {
        activate(kernel, &rt, true).await?;
    } else {
        kernel.logger.debug_fields(serde_json::json!({
            "plugin": rt.name(), "missing": missing_services(kernel, &rt), "msg": "plugin pending on dependencies"
        }));
    }
    Ok(rt)
}

async fn unload(kernel: &Arc<KernelInner>, rt: &PluginRuntime) -> LeoResult<()> {
    if rt.state() == PluginState::Disposed {
        return Ok(());
    }
    kernel
        .runtimes
        .lock()
        .unwrap()
        .retain(|r| !std::ptr::eq(r.as_ref(), rt));
    let ctx = rt.ctx.lock().unwrap().take();
    if let Some(ctx) = ctx {
        ctx.dispose().await?;
    }
    *rt.state.lock().unwrap() = PluginState::Disposed;
    Ok(())
}

fn deps_ready(kernel: &Arc<KernelInner>, rt: &Arc<PluginRuntime>) -> bool {
    rt.inject().iter().all(|k| kernel.get_service(k).is_some())
}

fn missing_services(kernel: &Arc<KernelInner>, rt: &Arc<PluginRuntime>) -> Vec<String> {
    rt.inject()
        .iter()
        .filter(|k| kernel.get_service(k).is_none())
        .cloned()
        .collect()
}

async fn activate(
    kernel: &Arc<KernelInner>,
    rt: &Arc<PluginRuntime>,
    rethrow: bool,
) -> LeoResult<()> {
    let logger = kernel
        .logger
        .child(serde_json::json!({ "plugin": rt.name() }));
    let ctx = Context::new(
        Arc::downgrade(kernel),
        rt.clone(),
        rt.config.clone(),
        rt.parent_scope.clone(),
        logger,
    );
    *rt.ctx.lock().unwrap() = Some(ctx.clone());
    *rt.state.lock().unwrap() = PluginState::Active;
    match rt.def.apply(ctx.clone(), rt.config.clone()).await {
        Ok(()) => {
            kernel
                .logger
                .debug_fields(serde_json::json!({ "plugin": rt.name(), "msg": "plugin applied" }));
            Ok(())
        }
        Err(err) => {
            *rt.state.lock().unwrap() = PluginState::Failed;
            let _ = ctx.dispose().await;
            *rt.ctx.lock().unwrap() = None;
            kernel.logger.error_fields(serde_json::json!({
                "err": err.to_string(), "plugin": rt.name(), "msg": "plugin apply failed"
            }));
            if rethrow {
                Err(err)
            } else {
                Ok(())
            }
        }
    }
}

async fn deactivate(kernel: &Arc<KernelInner>, rt: &Arc<PluginRuntime>) {
    let ctx = rt.ctx.lock().unwrap().take();
    *rt.state.lock().unwrap() = PluginState::Pending;
    if let Some(ctx) = ctx {
        let _ = ctx.dispose().await;
    }
    let _ = kernel;
}

async fn retry_pending(kernel: &Arc<KernelInner>) {
    let mut progress = true;
    while progress {
        progress = false;
        let pending: Vec<Arc<PluginRuntime>> = kernel
            .runtimes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.state() == PluginState::Pending)
            .cloned()
            .collect();
        for rt in pending {
            if rt.state() != PluginState::Pending || !deps_ready(kernel, &rt) {
                continue;
            }
            let _ = activate(kernel, &rt, false).await;
            progress = true;
        }
    }
}
