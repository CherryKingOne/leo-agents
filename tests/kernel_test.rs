use leo_agents::kernel::{
    create_console_logger, plugin_fn, plugin_fn_injected, BoxFuture, Context, Disposer, Kernel,
    LogLevel, NextFn,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Greeter(&'static str);

impl Greeter {
    fn greet(&self, name: &str) -> String {
        format!("{} {}", self.0, name)
    }
}

fn quiet() -> Kernel {
    Kernel::new(create_console_logger(LogLevel::Silent), Default::default())
}

#[tokio::test]
async fn waits_for_injected_services_and_applies_once_ready() {
    let k = quiet();
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let consumer = {
        let log = log.clone();
        plugin_fn_injected(
            "consumer",
            vec!["test.greeter".into()],
            move |ctx: Context, _cfg| {
                let log = log.clone();
                async move {
                    let greeter = ctx.get::<Greeter>("test.greeter")?;
                    log.lock().unwrap().push(greeter.greet("leo"));
                    Ok(())
                }
            },
        )
    };
    k.root().plugin(consumer, Value::Null).await.unwrap();
    assert!(log.lock().unwrap().is_empty());

    let provider = plugin_fn("provider", |ctx, _cfg| async move {
        ctx.provide("test.greeter", Arc::new(Greeter("hi")));
        Ok(())
    });
    k.root().plugin(provider, Value::Null).await.unwrap();
    k.ready().await.unwrap();
    assert_eq!(&*log.lock().unwrap(), &["hi leo"]);
}

#[tokio::test]
async fn ready_reports_unresolved_plugins() {
    let k = quiet();
    let lonely = plugin_fn_injected("lonely", vec!["nope".into()], |_ctx, _cfg| async { Ok(()) });
    k.root().plugin(lonely, Value::Null).await.unwrap();
    let err = k.ready().await.unwrap_err();
    assert_eq!(err.code, leo_agents::LeoErrorCode::PluginUnresolved);
}

#[tokio::test]
async fn disposes_effects_in_lifo_order() {
    let k = quiet();
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let plugin = {
        let order = order.clone();
        plugin_fn("fx", move |ctx, _cfg| {
            let order = order.clone();
            async move {
                for name in ["a", "b"] {
                    let order = order.clone();
                    let d: Disposer = Arc::new(move || {
                        let order = order.clone();
                        Box::pin(async move {
                            order.lock().unwrap().push(name);
                        }) as BoxFuture<()>
                    });
                    ctx.effect(|| async { Ok(d) }).await?;
                }
                Ok(())
            }
        })
    };
    let rt = k.root().plugin(plugin, Value::Null).await.unwrap();
    rt.dispose().await.unwrap();
    assert_eq!(&*order.lock().unwrap(), &["b", "a"]);
}

#[tokio::test]
async fn restarts_dependents_when_service_replaced() {
    let k = quiet();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let p1 = {
        let seen = seen.clone();
        plugin_fn("p1", move |ctx, _cfg| {
            let seen = seen.clone();
            async move {
                ctx.provide("test.greeter", Arc::new(Greeter("v1")));
                let _ = seen;
                Ok(())
            }
        })
    };
    k.root().plugin(p1, Value::Null).await.unwrap();
    let consumer = {
        let seen = seen.clone();
        plugin_fn_injected("c", vec!["test.greeter".into()], move |ctx, _cfg| {
            let seen = seen.clone();
            async move {
                let greeter = ctx.get::<Greeter>("test.greeter")?;
                seen.lock().unwrap().push(greeter.greet(""));
                Ok(())
            }
        })
    };
    k.root().plugin(consumer, Value::Null).await.unwrap();
    let p2 = plugin_fn("p2", |ctx, _cfg| async move {
        ctx.provide("test.greeter", Arc::new(Greeter("v2")));
        Ok(())
    });
    let rt2 = k.root().plugin(p2, Value::Null).await.unwrap();
    k.ready().await.unwrap();
    assert_eq!(&*seen.lock().unwrap(), &["v1 ", "v2 "]);
    rt2.dispose().await.unwrap();
    k.ready().await.unwrap();
    assert_eq!(&*seen.lock().unwrap(), &["v1 ", "v2 ", "v1 "]);
}

#[tokio::test]
async fn supports_waterfall_bail_serial() {
    let k = quiet();
    let ctx = k.root();
    ctx.on("test/wf", "test", false, |p: Value, next: NextFn| {
        Box::pin(async move {
            let n = p.get("n").and_then(|v| v.as_i64()).unwrap_or(0);
            let r = next(json!({ "n": n + 1 })).await?;
            let n = r
                .as_i64()
                .or_else(|| r.get("n").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            Ok(json!(n * 10))
        }) as BoxFuture<_>
    });
    ctx.on("test/wf", "test", false, |p: Value, next: NextFn| {
        Box::pin(async move {
            let n = p.get("n").and_then(|v| v.as_i64()).unwrap_or(0);
            if n > 100 {
                Ok(json!(-1))
            } else {
                next(p).await
            }
        }) as BoxFuture<_>
    });
    let r = ctx
        .waterfall("test/wf", json!({ "n": 1 }), |p| async { Ok(p) })
        .await
        .unwrap();
    assert_eq!(r, json!(20));
    let r = ctx
        .waterfall("test/wf", json!({ "n": 200 }), |p| async { Ok(p) })
        .await
        .unwrap();
    assert_eq!(r, json!(-10));

    ctx.on("test/bail", "test", false, |p: Value, _next: NextFn| {
        Box::pin(async move {
            if p.as_i64() == Some(1) {
                Ok(json!("first"))
            } else {
                Ok(Value::Null)
            }
        }) as BoxFuture<_>
    });
    ctx.on("test/bail", "test", false, |_p: Value, _next: NextFn| {
        Box::pin(async { Ok(json!("second")) }) as BoxFuture<_>
    });
    assert_eq!(
        ctx.bail("test/bail", json!(1)).await.unwrap(),
        Some(json!("first"))
    );
    assert_eq!(
        ctx.bail("test/bail", json!(2)).await.unwrap(),
        Some(json!("second"))
    );

    ctx.on("test/serial", "test", false, |p: Value, _next: NextFn| {
        Box::pin(async move { Ok(p) }) as BoxFuture<_>
    });
    ctx.on("test/serial", "test", false, |_p: Value, _next: NextFn| {
        Box::pin(async { Ok(Value::Null) }) as BoxFuture<_>
    });
    ctx.on("test/serial", "test", false, |p: Value, _next: NextFn| {
        Box::pin(async move { Ok(json!(p.as_i64().unwrap_or(0) * 2)) }) as BoxFuture<_>
    });
    assert_eq!(
        ctx.serial("test/serial", json!(3)).await.unwrap(),
        vec![json!(3), json!(6)]
    );
}

#[tokio::test]
async fn fork_creates_scoped_child_contexts() {
    let k = quiet();
    let child = k.root().fork(leo_agents::kernel::Scope {
        tenant: Some(leo_agents::kernel::TenantContext {
            tenant_id: "t1".into(),
            ..Default::default()
        }),
        agent_id: Some("a1".into()),
        session_id: None,
    });
    assert_eq!(child.tenant().unwrap().tenant_id, "t1");
    assert_eq!(child.scope().agent_id.as_deref(), Some("a1"));
    k.root().dispose().await.unwrap();
    assert!(child.is_disposed());
}
