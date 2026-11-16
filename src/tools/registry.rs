//! 工具注册表 + 受控执行管线。

use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::context::Context;
use crate::kernel::plugin::{plugin_fn, PluginRef};
use crate::kernel::types::{BoxFuture, Disposer};
use crate::llm::types::ToolSchema;
use crate::protocol::messages::{ContentBlock, ToolCallBlock};
use crate::tools::types::{
    ApprovalRequest, ApprovalServiceHandle, BatchContext, PreExecutePayload, ToolDecision,
    ToolDefinition, ToolExecContext, ToolFilter, ToolOutput, ToolRegistry, ToolRegistryHandle,
    ToolResult,
};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const NAME_RE: &str = r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$";

#[derive(Clone, serde::Serialize)]
pub struct ToolRegistryOptions {
    pub default_timeout_ms: u64,
    pub concurrency: usize,
    pub max_output_chars: usize,
}

impl Default for ToolRegistryOptions {
    fn default() -> Self {
        Self {
            default_timeout_ms: 120_000,
            concurrency: 8,
            max_output_chars: 50_000,
        }
    }
}

impl<'de> serde::Deserialize<'de> for ToolRegistryOptions {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        Ok(Self {
            default_timeout_ms: value
                .get("defaultTimeoutMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(120_000),
            concurrency: value
                .get("concurrency")
                .and_then(|v| v.as_u64())
                .unwrap_or(8) as usize,
            max_output_chars: value
                .get("maxOutputChars")
                .and_then(|v| v.as_u64())
                .unwrap_or(50_000) as usize,
        })
    }
}

struct RegistryInner {
    tools: Mutex<HashMap<String, Arc<ToolDefinition>>>,
    opts: ToolRegistryOptions,
}

#[derive(Clone)]
pub struct DefaultToolRegistry {
    ctx: Context,
    inner: Arc<RegistryInner>,
}

impl DefaultToolRegistry {
    pub fn new(ctx: Context, opts: ToolRegistryOptions) -> Self {
        Self {
            ctx,
            inner: Arc::new(RegistryInner {
                tools: Mutex::new(HashMap::new()),
                opts,
            }),
        }
    }

    fn register_inner(&self, def: Arc<ToolDefinition>) -> LeoResult<Disposer> {
        let re = regex::Regex::new(NAME_RE).unwrap();
        if !re.is_match(&def.name) {
            return Err(LeoError::new(
                LeoErrorCode::Internal,
                format!("Invalid tool name \"{}\"", def.name),
            ));
        }
        {
            let mut tools = self.inner.tools.lock().unwrap();
            if tools.contains_key(&def.name) {
                return Err(LeoError::new(
                    LeoErrorCode::Internal,
                    format!("Tool \"{}\" is already registered", def.name),
                ));
            }
            tools.insert(def.name.clone(), def.clone());
        }
        let weak = Arc::downgrade(&self.inner);
        let name = def.name.clone();
        Ok(Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                let mut tools = inner.tools.lock().unwrap();
                if tools.get(&name).is_some_and(|t| Arc::ptr_eq(t, &def)) {
                    tools.remove(&name);
                }
            }
            Box::pin(async {}) as BoxFuture<()>
        }))
    }

    fn get_inner(&self, name: &str) -> Option<Arc<ToolDefinition>> {
        self.inner.tools.lock().unwrap().get(name).cloned()
    }

    fn list_inner(&self, filter: Option<&ToolFilter>) -> Vec<Arc<ToolDefinition>> {
        let tools: Vec<_> = self.inner.tools.lock().unwrap().values().cloned().collect();
        match filter {
            Some(f) => tools.into_iter().filter(|t| f.matches(t)).collect(),
            None => tools,
        }
    }

    fn schemas_inner(&self, filter: Option<&ToolFilter>) -> Vec<ToolSchema> {
        self.list_inner(filter)
            .into_iter()
            .map(|t| ToolSchema {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: to_json_schema(&t.parameters),
            })
            .collect()
    }

    async fn prepare(
        &self,
        call: &ToolCallBlock,
        batch: &BatchContext,
    ) -> Result<Prepared, ToolResult> {
        let (call_id, name, mut args, raw) =
            call_parts(call).map_err(|e| error_result("", "", "tool_error", e.message, 0))?;
        let tool = self.get_inner(&name).ok_or_else(|| {
            let available: Vec<String> = self.inner.tools.lock().unwrap().keys().cloned().collect();
            error_result(
                &call_id,
                &name,
                "tool_not_found",
                format!(
                    "Unknown tool \"{}\". Available tools: {}",
                    name,
                    if available.is_empty() {
                        "(none)".into()
                    } else {
                        available.join(", ")
                    }
                ),
                0,
            )
        })?;
        if let Some(filter) = &batch.filter {
            if !filter.matches(&tool) {
                return Err(error_result(
                    &call_id,
                    &name,
                    "tool_not_found",
                    format!("Tool \"{}\" is not available to this agent", name),
                    0,
                ));
            }
        }
        if args.is_null() {
            if raw.trim().is_empty() {
                args = serde_json::json!({});
            } else {
                return Err(error_result(
                    &call_id,
                    &name,
                    "tool_invalid_args",
                    format!("Arguments are not valid JSON: {}", truncate_str(&raw, 500)),
                    0,
                ));
            }
        }
        if let Err(e) = validate_schema(&tool.parameters, &args, "") {
            return Err(error_result(
                &call_id,
                &name,
                "tool_invalid_args",
                format!("Invalid arguments for \"{}\":\n{}", tool.name, e),
                0,
            ));
        }
        let payload = PreExecutePayload {
            call: serde_json::to_value(call).unwrap_or(Value::Null),
            tool_name: tool.name.clone(),
            permissions: tool.permissions.clone(),
            args: args.clone(),
            agent_id: batch.agent_id.clone(),
            session_id: batch.session_id.clone(),
            turn_id: batch.turn_id.clone(),
            tenant: batch.tenant.clone(),
        };
        let payload_value = serde_json::to_value(&payload).unwrap_or(Value::Null);
        let final_fn: crate::kernel::events::FinalFn = Arc::new(|_p: Value| {
            Box::pin(async { Ok(serde_json::json!({ "action": "allow" })) })
                as BoxFuture<LeoResult<Value>>
        });
        let decision_value = match self
            .ctx
            .waterfall("tools/pre-execute", payload_value, move |p| final_fn(p))
            .await
        {
            Ok(v) => v,
            Err(e) => {
                return Err(error_result(
                    &call_id,
                    &name,
                    "tool_denied",
                    format!("Policy check failed: {}", e.message),
                    0,
                ))
            }
        };
        let decision: ToolDecision =
            serde_json::from_value(decision_value).unwrap_or(ToolDecision::Allow { args: None });
        if let ToolDecision::Allow {
            args: Some(new_args),
        } = &decision
        {
            args = new_args.clone();
        }
        match decision {
            ToolDecision::Deny { reason } => {
                return Err(error_result(
                    &call_id,
                    &name,
                    "tool_denied",
                    format!("Tool call denied: {}", reason),
                    0,
                ))
            }
            ToolDecision::Ask { reason } => {
                let approval = self.ctx.maybe::<ApprovalServiceHandle>("approval");
                let Some(approval) = approval else {
                    return Err(error_result(
                        &call_id,
                        &name,
                        "tool_denied",
                        "Tool call requires approval but no approval service is configured",
                        0,
                    ));
                };
                let req = ApprovalRequest {
                    payload: payload.clone(),
                    reason,
                };
                match approval.request(req, batch.signal.clone()).await {
                    Ok(r) if r.approved => {}
                    Ok(r) => {
                        return Err(error_result(
                            &call_id,
                            &name,
                            "tool_denied",
                            format!(
                                "Tool call rejected{}",
                                r.reason.map(|s| format!(": {}", s)).unwrap_or_default()
                            ),
                            0,
                        ));
                    }
                    Err(e) => {
                        let code = if e.code == LeoErrorCode::Cancelled {
                            "cancelled"
                        } else {
                            "tool_denied"
                        };
                        return Err(error_result(
                            &call_id,
                            &name,
                            code,
                            format!("Approval failed: {}", e.message),
                            0,
                        ));
                    }
                }
            }
            ToolDecision::Allow { .. } => {}
        }
        let guard_payload = serde_json::json!({
            "call": payload.call,
            "toolName": tool.name,
            "permissions": tool.permissions,
            "args": args,
            "agentId": batch.agent_id,
            "sessionId": batch.session_id,
            "turnId": batch.turn_id,
        });
        match self.ctx.bail("tools/guard", guard_payload).await {
            Ok(Some(v)) => {
                let reason = v
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| v.to_string());
                return Err(error_result(
                    &call_id,
                    &name,
                    "tool_denied",
                    format!("Tool call blocked: {}", reason),
                    0,
                ));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(error_result(
                    &call_id,
                    &name,
                    "tool_denied",
                    format!("Guard failed: {}", e.message),
                    0,
                ))
            }
        }
        Ok(Prepared {
            call_id,
            name,
            tool,
            args,
        })
    }

    async fn run(&self, p: Prepared, batch: &BatchContext) -> ToolResult {
        let started = std::time::Instant::now();
        if batch.signal.is_cancelled() {
            return error_result(
                &p.call_id,
                &p.name,
                "cancelled",
                "Cancelled before execution",
                0,
            );
        }
        if let Some(on_start) = &batch.on_start {
            on_start(ContentBlock::ToolCall {
                id: p.call_id.clone(),
                name: p.name.clone(),
                arguments: p.args.clone(),
                raw_arguments: String::new(),
            });
        }
        let attempts = 1 + if p.tool.idempotent {
            p.tool.max_retries.unwrap_or(0)
        } else {
            0
        };
        let mut result = None;
        for attempt in 1..=attempts {
            result = Some(self.run_once(&p, batch, started).await);
            let should_retry = result.as_ref().is_some_and(|r| {
                r.error_code.as_deref() == Some("tool_error") && !batch.signal.is_cancelled()
            });
            if !should_retry || attempt >= attempts {
                break;
            }
            self.ctx.logger().warn_fields(serde_json::json!({
                "tool": p.tool.name, "attempt": attempt, "msg": "tool failed, retrying"
            }));
        }
        let mut final_result = result.unwrap();
        let post_payload = serde_json::json!({
            "toolName": p.tool.name,
            "args": p.args,
            "callId": p.call_id,
            "result": final_result,
        });
        let final_fn: crate::kernel::events::FinalFn =
            Arc::new(|p: Value| Box::pin(async move { Ok(p) }) as BoxFuture<LeoResult<Value>>);
        match self
            .ctx
            .waterfall("tools/post-execute", post_payload, move |p| final_fn(p))
            .await
        {
            Ok(v) => {
                if let Ok(r) = serde_json::from_value::<ToolResult>(v) {
                    final_result = r;
                }
            }
            Err(e) => {
                final_result = error_result(
                    &p.call_id,
                    &p.name,
                    "tool_error",
                    format!("Post-processing failed: {}", e.message),
                    started.elapsed().as_millis() as u64,
                );
            }
        }
        final_result
    }

    async fn run_once(
        &self,
        p: &Prepared,
        batch: &BatchContext,
        started: std::time::Instant,
    ) -> ToolResult {
        let timeout_ms = p
            .tool
            .timeout_ms
            .unwrap_or(self.inner.opts.default_timeout_ms);
        let exec = ToolExecContext {
            call_id: p.call_id.clone(),
            tool_name: p.tool.name.clone(),
            agent_id: batch.agent_id.clone(),
            session_id: batch.session_id.clone(),
            turn_id: batch.turn_id.clone(),
            tenant: batch.tenant.clone(),
            signal: batch.signal.clone(),
            on_update: {
                let on_update = batch.on_update.clone();
                let call_id = p.call_id.clone();
                Arc::new(move |partial: Value| {
                    if let Some(f) = &on_update {
                        f(call_id.clone(), partial);
                    }
                })
            },
            ctx: batch.ctx.clone(),
            logger: batch
                .ctx
                .logger()
                .child(serde_json::json!({ "tool": p.tool.name, "callId": p.call_id })),
        };
        let execute_payload = serde_json::json!({
            "toolName": p.tool.name,
            "args": p.args,
        });
        let tool = p.tool.clone();
        let args = p.args.clone();
        let final_fn: crate::kernel::events::FinalFn = Arc::new(move |_p: Value| {
            let tool = tool.clone();
            let args = args.clone();
            let exec = exec.clone();
            Box::pin(async move {
                let value = (tool.execute)(args, exec).await?;
                Ok(serde_json::to_value(value).unwrap_or(Value::Null))
            }) as BoxFuture<LeoResult<Value>>
        });
        let execution = self
            .ctx
            .waterfall("tools/execute", execute_payload, move |p| final_fn(p));
        tokio::select! {
            _ = batch.signal.cancelled() => {
                error_result(&p.call_id, &p.name, "cancelled", "Tool execution cancelled", started.elapsed().as_millis() as u64)
            }
            _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                error_result(&p.call_id, &p.name, "tool_timeout", format!("Tool \"{}\" timed out after {}ms", p.tool.name, timeout_ms), started.elapsed().as_millis() as u64)
            }
            result = execution => {
                match result {
                    Ok(v) => {
                        let out: ToolOutput = serde_json::from_value(v).unwrap_or_else(|_| ToolOutput::text("(no output)"));
                        self.normalize(&p.call_id, &p.name, out, started.elapsed().as_millis() as u64)
                    }
                    Err(e) => {
                        if batch.signal.is_cancelled() {
                            error_result(&p.call_id, &p.name, "cancelled", "Tool execution cancelled", started.elapsed().as_millis() as u64)
                        } else {
                            error_result(&p.call_id, &p.name, "tool_error", e.message, started.elapsed().as_millis() as u64)
                        }
                    }
                }
            }
        }
    }

    fn normalize(&self, call_id: &str, name: &str, out: ToolOutput, ms: u64) -> ToolResult {
        let content = truncate_blocks(out.content.into_blocks(), self.inner.opts.max_output_chars);
        ToolResult {
            call_id: call_id.to_string(),
            name: name.to_string(),
            content,
            is_error: out.is_error.unwrap_or(false),
            terminate: out.terminate.unwrap_or(false),
            details: out.details,
            display: out.display,
            error_code: None,
            duration_ms: ms,
        }
    }
}

#[derive(Clone)]
struct Prepared {
    call_id: String,
    name: String,
    tool: Arc<ToolDefinition>,
    args: Value,
}

#[async_trait::async_trait]
impl ToolRegistry for DefaultToolRegistry {
    fn register(&self, def: Arc<ToolDefinition>) -> Disposer {
        self.register_inner(def).unwrap_or_else(|e| panic!("{}", e))
    }

    fn get(&self, name: &str) -> Option<Arc<ToolDefinition>> {
        self.get_inner(name)
    }

    fn list(&self, filter: Option<&ToolFilter>) -> Vec<Arc<ToolDefinition>> {
        self.list_inner(filter)
    }

    fn schemas(&self, filter: Option<&ToolFilter>) -> Vec<ToolSchema> {
        self.schemas_inner(filter)
    }

    async fn execute_batch(
        &self,
        calls: Vec<ToolCallBlock>,
        batch: BatchContext,
    ) -> Vec<ToolResult> {
        let mut prepared: Vec<Result<Prepared, ToolResult>> = Vec::new();
        for call in calls {
            if batch.signal.is_cancelled() {
                let (id, name, _, _) = call_parts(&call)
                    .unwrap_or_else(|_| (String::new(), String::new(), Value::Null, String::new()));
                prepared.push(Err(error_result(
                    &id,
                    &name,
                    "cancelled",
                    "Cancelled before execution",
                    0,
                )));
            } else {
                prepared.push(self.prepare(&call, &batch).await);
            }
        }
        let runnable: Vec<(usize, Prepared)> = prepared
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.as_ref().ok().map(|p| (i, p.clone())))
            .collect();
        let sequential = batch.sequential || runnable.iter().any(|(_, p)| p.tool.sequential);
        let limit = if sequential {
            1
        } else {
            self.inner.opts.concurrency.max(1)
        };
        let results: Arc<Mutex<HashMap<usize, ToolResult>>> = Arc::new(Mutex::new(HashMap::new()));
        let queue = Arc::new(Mutex::new(VecDeque::from(runnable)));
        let workers = limit.min(queue.lock().unwrap().len().max(1));
        let mut handles = Vec::new();
        for _ in 0..workers {
            let queue = queue.clone();
            let results = results.clone();
            let registry = self.clone();
            let worker_batch = BatchContext {
                agent_id: batch.agent_id.clone(),
                session_id: batch.session_id.clone(),
                turn_id: batch.turn_id.clone(),
                tenant: batch.tenant.clone(),
                signal: batch.signal.clone(),
                ctx: batch.ctx.clone(),
                sequential: batch.sequential,
                filter: batch.filter.clone(),
                on_update: batch.on_update.clone(),
                on_start: batch.on_start.clone(),
            };
            handles.push(tokio::spawn(async move {
                loop {
                    let next = queue.lock().unwrap().pop_front();
                    let Some((idx, p)) = next else { break };
                    let r = registry.run(p, &worker_batch).await;
                    results.lock().unwrap().insert(idx, r);
                }
            }));
        }
        for h in handles {
            let _ = h.await;
        }
        let results = results.lock().unwrap();
        prepared
            .into_iter()
            .enumerate()
            .map(|(i, p)| match p {
                Ok(_) => results.get(&i).cloned().unwrap_or_else(|| {
                    error_result("", "", "tool_error", "tool result missing", 0)
                }),
                Err(e) => e,
            })
            .collect()
    }
}

fn call_parts(call: &ToolCallBlock) -> LeoResult<(String, String, Value, String)> {
    match call {
        ContentBlock::ToolCall {
            id,
            name,
            arguments,
            raw_arguments,
        } => Ok((
            id.clone(),
            name.clone(),
            arguments.clone(),
            raw_arguments.clone(),
        )),
        _ => Err(LeoError::new(
            LeoErrorCode::Internal,
            "expected a tool_call block",
        )),
    }
}

fn error_result(
    call_id: &str,
    name: &str,
    code: &str,
    message: impl Into<String>,
    ms: u64,
) -> ToolResult {
    ToolResult {
        call_id: call_id.to_string(),
        name: name.to_string(),
        content: vec![ContentBlock::text(format!("Error: {}", message.into()))],
        is_error: true,
        terminate: false,
        details: None,
        display: None,
        error_code: Some(code.to_string()),
        duration_ms: ms,
    }
}

fn truncate_blocks(blocks: Vec<ContentBlock>, max: usize) -> Vec<ContentBlock> {
    let mut budget = max;
    blocks
        .into_iter()
        .map(|b| match b {
            ContentBlock::Text { text } => {
                let len = text.chars().count();
                if len <= budget {
                    budget = budget.saturating_sub(len);
                    ContentBlock::Text { text }
                } else {
                    let kept: String = text.chars().take(budget).collect();
                    let dropped = len - kept.chars().count();
                    budget = 0;
                    ContentBlock::Text {
                        text: format!("{}\n…[truncated {} characters]", kept, dropped),
                    }
                }
            }
            other => other,
        })
        .collect()
}

fn truncate_str(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// zod / JSON Schema → 发给模型的 JSON Schema（Rust 版参数本身就是 JSON Schema）。
pub fn to_json_schema(p: &Value) -> Value {
    if p.is_object() {
        let mut s = p.clone();
        if let Some(obj) = s.as_object_mut() {
            obj.remove("$schema");
        }
        if s.get("type").and_then(|t| t.as_str()) != Some("object") {
            let mut wrapped = serde_json::Map::new();
            wrapped.insert("type".into(), "object".into());
            wrapped.insert("properties".into(), serde_json::json!({}));
            if let Value::Object(map) = s {
                for (k, v) in map {
                    wrapped.insert(k, v);
                }
            }
            return Value::Object(wrapped);
        }
        s
    } else {
        serde_json::json!({ "type": "object", "properties": {} })
    }
}

/// 极简 JSON Schema 校验，覆盖内置工具与常见插件参数。
pub fn validate_schema(schema: &Value, value: &Value, path: &str) -> LeoResult<()> {
    let Some(obj) = schema.as_object() else {
        return Ok(());
    };
    let ty = obj.get("type").and_then(|t| t.as_str());
    let type_ok = match ty {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("number") => value.is_number(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        _ => true,
    };
    if !type_ok {
        return Err(LeoError::new(
            LeoErrorCode::ToolInvalidArgs,
            format!(
                "{}: expected type {}",
                if path.is_empty() { "value" } else { path },
                ty.unwrap_or("?")
            ),
        ));
    }
    if let Some(required) = obj.get("required").and_then(|r| r.as_array()) {
        if let Some(map) = value.as_object() {
            for key in required.iter().filter_map(|k| k.as_str()) {
                if !map.contains_key(key) {
                    return Err(LeoError::new(
                        LeoErrorCode::ToolInvalidArgs,
                        format!(
                            "{}: missing required property \"{}\"",
                            if path.is_empty() { "value" } else { path },
                            key
                        ),
                    ));
                }
            }
        }
    }
    if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
        if let Some(map) = value.as_object() {
            for (key, subschema) in props {
                if let Some(v) = map.get(key) {
                    let subpath = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{}.{}", path, key)
                    };
                    validate_schema(subschema, v, &subpath)?;
                }
            }
        }
    }
    if let Some(items) = obj.get("items") {
        if let Some(arr) = value.as_array() {
            for (i, v) in arr.iter().enumerate() {
                validate_schema(items, v, &format!("{}[{}]", path, i))?;
            }
        }
    }
    if let Some(min) = obj.get("minLength").and_then(|v| v.as_u64()) {
        if let Some(s) = value.as_str() {
            if (s.chars().count() as u64) < min {
                return Err(LeoError::new(
                    LeoErrorCode::ToolInvalidArgs,
                    format!("{}: too short", path),
                ));
            }
        }
    }
    if let Some(max) = obj.get("maxLength").and_then(|v| v.as_u64()) {
        if let Some(s) = value.as_str() {
            if (s.chars().count() as u64) > max {
                return Err(LeoError::new(
                    LeoErrorCode::ToolInvalidArgs,
                    format!("{}: too long", path),
                ));
            }
        }
    }
    if let Some(min) = obj.get("minimum").and_then(|v| v.as_f64()) {
        if let Some(n) = value.as_f64() {
            if n < min {
                return Err(LeoError::new(
                    LeoErrorCode::ToolInvalidArgs,
                    format!("{}: below minimum", path),
                ));
            }
        }
    }
    if let Some(max) = obj.get("maximum").and_then(|v| v.as_f64()) {
        if let Some(n) = value.as_f64() {
            if n > max {
                return Err(LeoError::new(
                    LeoErrorCode::ToolInvalidArgs,
                    format!("{}: above maximum", path),
                ));
            }
        }
    }
    if let Some(enum_values) = obj.get("enum").and_then(|v| v.as_array()) {
        if !enum_values.iter().any(|v| v == value) {
            return Err(LeoError::new(
                LeoErrorCode::ToolInvalidArgs,
                format!("{}: not in enum", path),
            ));
        }
    }
    Ok(())
}

/// 核心插件：提供 `tools` 服务。
pub fn tools_plugin() -> PluginRef {
    plugin_fn("leo:tools", |ctx, cfg| async move {
        let opts = if cfg.is_null() {
            ToolRegistryOptions::default()
        } else {
            serde_json::from_value(cfg).unwrap_or_default()
        };
        ctx.provide(
            "tools",
            Arc::new(ToolRegistryHandle(Arc::new(DefaultToolRegistry::new(
                ctx.clone(),
                opts,
            )))),
        );
        Ok(())
    })
}

#[allow(dead_code)]
fn _unused(_: Weak<RegistryInner>) {}
