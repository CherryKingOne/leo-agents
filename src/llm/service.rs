//! `llm` 服务：模型提供方注册表 + 统一调用入口。

use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::context::Context;
use crate::kernel::plugin::{plugin_fn, PluginRef};
use crate::kernel::types::{BoxFuture, Disposer};
use crate::llm::types::{
    LlmProvider, LlmRequest, LlmStream, LlmStreamEvent, ModelInfo, ProviderModels, ResolvedModel,
    StreamOptions,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// 近似 token 估算：按 UTF-8 字节数 / 3.5，偏保守（中英文混合时略高估）。
pub fn approximate_tokens(request: &LlmRequest) -> u64 {
    let text = serde_json::json!({
        "s": request.system,
        "m": request.messages,
        "t": request.tools,
    })
    .to_string();
    (text.len() as f64 / 3.5).ceil() as u64
}

pub struct LlmService {
    ctx: Context,
    providers: Arc<Mutex<Vec<Arc<dyn LlmProvider>>>>,
    default_id: Arc<Mutex<Option<String>>>,
}

impl LlmService {
    pub fn new(ctx: Context) -> Self {
        Self {
            ctx,
            providers: Arc::new(Mutex::new(Vec::new())),
            default_id: Arc::new(Mutex::new(None)),
        }
    }

    pub fn register_provider(
        &self,
        provider: Arc<dyn LlmProvider>,
        default: bool,
    ) -> LeoResult<Disposer> {
        {
            let mut list = self.providers.lock().unwrap();
            if list.iter().any(|p| p.id() == provider.id()) {
                return Err(LeoError::new(
                    LeoErrorCode::Internal,
                    format!("LLM provider \"{}\" is already registered", provider.id()),
                ));
            }
            list.push(provider.clone());
            let mut def = self.default_id.lock().unwrap();
            if default || def.is_none() {
                *def = Some(provider.id().to_string());
            }
        }
        let providers = self.providers.clone();
        let default_id = self.default_id.clone();
        let id = provider.id().to_string();
        Ok(Arc::new(move || {
            {
                let mut list = providers.lock().unwrap();
                if let Some(pos) = list.iter().position(|p| p.id() == id) {
                    list.remove(pos);
                }
                let first = list.first().map(|p| p.id().to_string());
                let mut def = default_id.lock().unwrap();
                if def.as_deref() == Some(id.as_str()) {
                    *def = first;
                }
            }
            Box::pin(async {}) as BoxFuture<()>
        }))
    }

    pub fn providers(&self) -> Vec<Arc<dyn LlmProvider>> {
        self.providers.lock().unwrap().clone()
    }

    pub fn resolve(&self, model: &str) -> LeoResult<ResolvedModel> {
        if let Some(slash) = model.find('/') {
            if slash > 0 {
                let (provider_id, rest) = model.split_at(slash);
                let id = &rest[1..];
                let list = self.providers.lock().unwrap();
                if let Some(provider) = list.iter().find(|p| p.id() == provider_id) {
                    return Ok(with_info(provider.clone(), id.to_string()));
                }
            }
        }
        let default_id = self.default_id.lock().unwrap().clone();
        let list = self.providers.lock().unwrap();
        let provider = default_id
            .as_deref()
            .and_then(|d| list.iter().find(|p| p.id() == d))
            .or_else(|| list.first())
            .cloned()
            .ok_or_else(|| {
                LeoError::new(
                    LeoErrorCode::ServiceMissing,
                    format!("No LLM provider can serve model \"{}\"", model),
                )
            })?;
        Ok(with_info(provider, model.to_string()))
    }

    pub fn stream(
        &self,
        model: &str,
        mut request: LlmRequest,
        opts: StreamOptions,
    ) -> LeoResult<LlmStream> {
        let resolved = self.resolve(model)?;
        request.model = resolved.model.clone();
        let ctx = self.ctx.clone();
        let provider = resolved.provider.clone();
        let stream: LlmStream = Box::pin(async_stream::stream! {
            let payload = serde_json::json!({
                "providerId": provider.id(),
                "request": serde_json::to_value(&request).unwrap_or(Value::Null),
            });
            let final_fn: crate::kernel::events::FinalFn = Arc::new(|_p: Value| {
                Box::pin(async { Ok(Value::Null) }) as BoxFuture<LeoResult<Value>>
            });
            let _ = ctx.waterfall("llm/stream", payload, move |p| final_fn(p)).await;
            let mut stream = provider.stream(request, opts);
            while let Some(item) = futures::StreamExt::next(&mut stream).await {
                yield item;
            }
        });
        Ok(stream)
    }

    pub async fn count_tokens(&self, model: &str, request: &LlmRequest) -> LeoResult<u64> {
        let resolved = self.resolve(model)?;
        let mut req = request.clone();
        req.model = resolved.model.clone();
        if let Some(n) = resolved.provider.count_tokens(&req).await {
            Ok(n)
        } else {
            Ok(approximate_tokens(&req))
        }
    }

    pub async fn models(
        &self,
        refresh: bool,
        provider_id: Option<&str>,
        _signal: Option<&tokio_util::sync::CancellationToken>,
    ) -> LeoResult<Vec<ProviderModels>> {
        let mut list: Vec<Arc<dyn LlmProvider>> = self.providers.lock().unwrap().clone();
        if let Some(id) = provider_id {
            list.retain(|p| p.id() == id);
            if list.is_empty() {
                return Err(LeoError::new(
                    LeoErrorCode::InvalidRequest,
                    format!("Unknown LLM provider \"{}\"", id),
                ));
            }
        }
        let mut out = Vec::new();
        for provider in list {
            let mut error = None;
            let mut models = None;
            if refresh {
                match provider.refresh_models().await {
                    Ok(m) => models = Some(m),
                    Err(e) => error = Some(e.message),
                }
            }
            if models.is_none() {
                models = Some(provider.list_models());
            }
            let visible: Vec<ModelInfo> = models
                .unwrap_or_default()
                .into_iter()
                .filter(|m| !m.alias.unwrap_or(false))
                .collect();
            out.push(ProviderModels {
                provider,
                models: visible,
                error,
            });
        }
        Ok(out)
    }
}

fn with_info(provider: Arc<dyn LlmProvider>, model: String) -> ResolvedModel {
    let info = provider.get_model_info(&model);
    ResolvedModel {
        provider,
        model,
        info,
    }
}

/// 核心插件：提供 `llm` 服务。
pub fn llm_plugin() -> PluginRef {
    plugin_fn("leo:llm", |ctx, _cfg| async move {
        ctx.provide("llm", Arc::new(LlmService::new(ctx.clone())));
        Ok(())
    })
}

/// 把一个 LlmProvider 实例包装成插件：加载即注册到 `llm` 服务，卸载即撤销。
pub fn provider_plugin(provider: Arc<dyn LlmProvider>, default: bool) -> PluginRef {
    let id = provider.id().to_string();
    plugin_fn(format!("leo:provider:{}", id), move |ctx, _cfg| {
        let provider = provider.clone();
        async move {
            let llm = ctx.get::<LlmService>("llm")?;
            let d = llm.register_provider(provider, default)?;
            let _ = ctx.effect(|| async { Ok(d) }).await?;
            Ok(())
        }
    })
}

#[allow(dead_code)]
fn _event(_: LlmStreamEvent) {}
