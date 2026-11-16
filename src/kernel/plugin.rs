//! 插件定义。

use crate::errors::LeoResult;
use crate::kernel::context::Context;
use crate::kernel::types::BoxFuture;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

/// 可被 inject 的服务键（字符串）。
pub type ServiceKey = String;

#[async_trait]
pub trait Plugin: Send + Sync {
    /// 插件名，建议使用 `scope/name` 或 `leo-plugin-xxx` 形式，用于日志与诊断。
    fn name(&self) -> &str;
    /// 依赖的服务键。任一服务缺失时插件处于 pending；服务被替换时插件会自动重新 apply。
    fn inject(&self) -> Vec<ServiceKey> {
        Vec::new()
    }
    /// 热重载时要关注的数据文件（相对 `.leo/` 的路径，以 `/` 结尾表示目录）。
    fn watch(&self) -> Vec<String> {
        Vec::new()
    }
    /// 加载时校验配置；失败抛出 `plugin_config_invalid`。
    fn validate(&self, config: &Value) -> LeoResult<Value> {
        Ok(config.clone())
    }
    /// 插件入口：在这里注册服务、监听事件、注册工具等。
    async fn apply(&self, ctx: Context, config: Value) -> LeoResult<()>;
}

/// 函数式插件（一个函数就是一个插件）。
pub struct FnPlugin {
    pub plugin_name: String,
    pub inject: Vec<ServiceKey>,
    pub watch: Vec<String>,
    pub func: Arc<dyn Fn(Context, Value) -> BoxFuture<LeoResult<()>> + Send + Sync>,
    pub validator: Option<Arc<dyn Fn(&Value) -> LeoResult<Value> + Send + Sync>>,
}

#[async_trait]
impl Plugin for FnPlugin {
    fn name(&self) -> &str {
        &self.plugin_name
    }
    fn inject(&self) -> Vec<ServiceKey> {
        self.inject.clone()
    }
    fn watch(&self) -> Vec<String> {
        self.watch.clone()
    }
    fn validate(&self, config: &Value) -> LeoResult<Value> {
        match &self.validator {
            Some(f) => f(config),
            None => Ok(config.clone()),
        }
    }
    async fn apply(&self, ctx: Context, config: Value) -> LeoResult<()> {
        (self.func)(ctx, config).await
    }
}

/// 统一插件句柄。
pub type PluginRef = Arc<dyn Plugin>;

/// 构造函数式插件。
pub fn plugin_fn<F, Fut>(name: impl Into<String>, func: F) -> PluginRef
where
    F: Fn(Context, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = LeoResult<()>> + Send + 'static,
{
    Arc::new(FnPlugin {
        plugin_name: name.into(),
        inject: Vec::new(),
        watch: Vec::new(),
        func: Arc::new(move |ctx, cfg| Box::pin(func(ctx, cfg))),
        validator: None,
    })
}

/// 带 inject 的函数式插件。
pub fn plugin_fn_injected<F, Fut>(
    name: impl Into<String>,
    inject: Vec<ServiceKey>,
    func: F,
) -> PluginRef
where
    F: Fn(Context, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = LeoResult<()>> + Send + 'static,
{
    Arc::new(FnPlugin {
        plugin_name: name.into(),
        inject,
        watch: Vec::new(),
        func: Arc::new(move |ctx, cfg| Box::pin(func(ctx, cfg))),
        validator: None,
    })
}

/// 带 watch 的函数式插件。
pub fn plugin_fn_watched<F, Fut>(
    name: impl Into<String>,
    inject: Vec<ServiceKey>,
    watch: Vec<String>,
    func: F,
) -> PluginRef
where
    F: Fn(Context, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = LeoResult<()>> + Send + 'static,
{
    Arc::new(FnPlugin {
        plugin_name: name.into(),
        inject,
        watch,
        func: Arc::new(move |ctx, cfg| Box::pin(func(ctx, cfg))),
        validator: None,
    })
}

/// 空插件（用于占位/命名）。
pub fn noop_plugin(name: &str) -> PluginRef {
    plugin_fn(name, |_ctx, _cfg| async { Ok(()) })
}
