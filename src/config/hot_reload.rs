//! 插件热加载：运行中的 leo 感知插件的安装、移除、更新与插件数据文件的变化。

use crate::config::load::{load_config, LeoPaths, LoadConfigOptions, PluginSpec};
use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::context::{Context, PluginRuntime};
use crate::kernel::logger::Logger;
use crate::kernel::plugin::PluginRef;
use crate::kernel::types::Disposer;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginChangeReason {
    Added,
    Changed,
    Removed,
}

#[derive(Debug, Default)]
pub struct ReloadResult {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    pub failed: Vec<(String, String)>,
}

pub trait PluginLoader: Send + Sync {
    fn load(&self, spec: &PluginSpec, version: Option<&str>) -> LeoResult<PluginRef>;
    fn resolve_file(&self, spec: &PluginSpec) -> Option<PathBuf>;
}

#[derive(Clone)]
struct Slot {
    spec: String,
    plugin: PluginRef,
    name: String,
    watch: Vec<String>,
    module_stamp: String,
    config_stamp: String,
    data_stamp: String,
    rt: Option<Arc<PluginRuntime>>,
}

pub struct PluginHotReloader {
    load_options: LoadConfigOptions,
    paths: LeoPaths,
    logger: Logger,
    loader: Arc<dyn PluginLoader>,
    slots: Mutex<BTreeMap<String, Slot>>,
    failed_stamps: Mutex<BTreeMap<String, String>>,
    ctx: Mutex<Option<Context>>,
    emit: Mutex<Option<Arc<dyn Fn(&str, Value) + Send + Sync>>>,
    closed: Mutex<bool>,
    reload_lock: tokio::sync::Mutex<()>,
}

impl PluginHotReloader {
    pub fn new(
        load_options: LoadConfigOptions,
        paths: LeoPaths,
        logger: Logger,
        loader: Arc<dyn PluginLoader>,
        _poll_ms: u64,
        _debounce_ms: u64,
    ) -> Self {
        Self {
            load_options,
            paths,
            logger,
            loader,
            slots: Mutex::new(BTreeMap::new()),
            failed_stamps: Mutex::new(BTreeMap::new()),
            ctx: Mutex::new(None),
            emit: Mutex::new(None),
            closed: Mutex::new(false),
            reload_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn loaded(&self) -> Vec<(String, String, String)> {
        self.slots
            .lock()
            .unwrap()
            .values()
            .map(|s| (s.spec.clone(), s.name.clone(), String::new()))
            .collect()
    }

    pub async fn load_initial(&self, ctx: Context, refs: &[PluginSpec]) -> LeoResult<()> {
        *self.ctx.lock().unwrap() = Some(ctx.clone());
        for ref_ in refs {
            let slot = self.prepare(ref_, None).await?;
            let rt = ctx
                .plugin(
                    slot.plugin.clone(),
                    ref_.config.clone().unwrap_or(Value::Null),
                )
                .await?;
            let mut slots = self.slots.lock().unwrap();
            slots.insert(
                ref_.spec.clone(),
                Slot {
                    rt: Some(rt),
                    ..slot
                },
            );
        }
        Ok(())
    }

    pub fn start(&self, emit: Arc<dyn Fn(&str, Value) + Send + Sync>, _watch: bool) {
        *self.emit.lock().unwrap() = Some(emit);
    }

    pub async fn reload(&self) -> LeoResult<ReloadResult> {
        let _guard = self.reload_lock.lock().await;
        self.do_reload().await
    }

    async fn prepare(&self, ref_: &PluginSpec, version: Option<&str>) -> LeoResult<Slot> {
        let file = self.loader.resolve_file(ref_);
        let module_stamp = file_stamp(file.as_deref()).await;
        let plugin = self.loader.load(ref_, version)?;
        let name = plugin.name().to_string();
        let watch = plugin.watch();
        let config_stamp =
            serde_json::to_string(&ref_.config.clone().unwrap_or(Value::Null)).unwrap_or_default();
        let mut slot = Slot {
            spec: ref_.spec.clone(),
            plugin,
            name,
            watch,
            module_stamp,
            config_stamp,
            data_stamp: String::new(),
            rt: None,
        };
        slot.data_stamp = self.data_stamp(&slot).await;
        Ok(slot)
    }

    fn data_dirs(&self) -> Vec<String> {
        let mut dirs = vec![self.paths.user_dir.clone()];
        if let Some(p) = &self.paths.project_dir {
            dirs.push(p.clone());
        }
        dirs
    }

    async fn data_stamp(&self, slot: &Slot) -> String {
        if slot.watch.is_empty() {
            return String::new();
        }
        let mut parts = Vec::new();
        for dir in self.data_dirs() {
            for w in &slot.watch {
                parts.push(format!(
                    "{}@{}={}",
                    w,
                    dir,
                    file_stamp(Some(Path::new(&dir).join(w).as_path())).await
                ));
            }
        }
        parts.join("|")
    }

    pub async fn acknowledge(&self, plugin_name: &str) -> LeoResult<()> {
        let _guard = self.reload_lock.lock().await;
        let slot = {
            let slots = self.slots.lock().unwrap();
            slots.values().find(|s| s.name == plugin_name).cloned()
        };
        let Some(slot) = slot else { return Ok(()) };
        let stamp = self.data_stamp(&slot).await;
        if let Some(slot) = self.slots.lock().unwrap().get_mut(&slot.spec) {
            slot.data_stamp = stamp;
        }
        Ok(())
    }

    async fn do_reload(&self) -> LeoResult<ReloadResult> {
        let mut result = ReloadResult::default();
        if *self.closed.lock().unwrap() {
            return Ok(result);
        }
        let Some(ctx) = self.ctx.lock().unwrap().clone() else {
            return Ok(result);
        };
        let resolved = match load_config(&self.load_options) {
            Ok(r) => r,
            Err(_) => return Ok(result),
        };
        let want: BTreeMap<String, PluginSpec> = resolved
            .plugins
            .iter()
            .map(|p| (p.spec.clone(), p.clone()))
            .collect();

        // 1. 卸载已消失的
        let removed: Vec<String> = self
            .slots
            .lock()
            .unwrap()
            .keys()
            .filter(|spec| !want.contains_key(*spec))
            .cloned()
            .collect();
        for spec in removed {
            let slot = self.slots.lock().unwrap().remove(&spec);
            if let Some(slot) = slot {
                if let Some(rt) = &slot.rt {
                    let _ = rt.dispose().await;
                }
                result.removed.push(spec.clone());
                self.notify(
                    "plugin/unloaded",
                    serde_json::json!({ "spec": spec, "name": slot.name, "reason": "removed" }),
                );
                self.logger.info_fields(serde_json::json!({ "plugin": slot.name, "spec": spec, "msg": "plugin unloaded" }));
            }
        }

        // 2. 变化的
        let current_specs: Vec<String> = want.keys().cloned().collect();
        for spec in current_specs {
            let Some(ref_) = want.get(&spec) else {
                continue;
            };
            let Some(slot) = self.slots.lock().unwrap().get(&spec).cloned() else {
                continue;
            };
            let module_stamp = file_stamp(self.loader.resolve_file(ref_).as_deref()).await;
            let config_stamp = serde_json::to_string(&ref_.config.clone().unwrap_or(Value::Null))
                .unwrap_or_default();
            let data_stamp = self.data_stamp(&slot).await;
            if module_stamp == slot.module_stamp
                && config_stamp == slot.config_stamp
                && data_stamp == slot.data_stamp
            {
                continue;
            }
            let stamp = format!("{}|{}|{}", module_stamp, config_stamp, data_stamp);
            if self
                .failed_stamps
                .lock()
                .unwrap()
                .get(&spec)
                .cloned()
                .unwrap_or_default()
                == stamp
            {
                continue;
            }
            if let Some(rt) = &slot.rt {
                let _ = rt.dispose().await;
            }
            self.notify(
                "plugin/unloaded",
                serde_json::json!({ "spec": spec, "name": slot.name, "reason": "changed" }),
            );
            let next = if module_stamp == slot.module_stamp {
                let mut s = slot.clone();
                s.config_stamp = config_stamp;
                s.data_stamp = data_stamp;
                s.rt = None;
                s
            } else {
                match self.prepare(ref_, None).await {
                    Ok(s) => s,
                    Err(e) => {
                        self.fail(&spec, &stamp, &e);
                        continue;
                    }
                }
            };
            match ctx
                .plugin(
                    next.plugin.clone(),
                    ref_.config.clone().unwrap_or(Value::Null),
                )
                .await
            {
                Ok(rt) => {
                    let mut next = next;
                    next.rt = Some(rt);
                    self.slots
                        .lock()
                        .unwrap()
                        .insert(spec.clone(), next.clone());
                    self.failed_stamps.lock().unwrap().remove(&spec);
                    result.changed.push(spec.clone());
                    self.notify(
                        "plugin/loaded",
                        serde_json::json!({ "spec": spec, "name": next.name, "reason": "changed" }),
                    );
                }
                Err(e) => {
                    self.fail(&spec, &stamp, &e);
                    // 恢复旧实例
                    match ctx
                        .plugin(
                            slot.plugin.clone(),
                            ref_.config.clone().unwrap_or(Value::Null),
                        )
                        .await
                    {
                        Ok(rt) => {
                            let mut old = slot.clone();
                            old.rt = Some(rt);
                            self.slots.lock().unwrap().insert(spec.clone(), old);
                        }
                        Err(e2) => {
                            self.slots.lock().unwrap().remove(&spec);
                            self.logger.error_fields(serde_json::json!({ "err": e2.to_string(), "spec": spec, "msg": "failed to restore previous plugin version" }));
                        }
                    }
                }
            }
        }

        // 3. 新增
        for (spec, ref_) in &want {
            if self.slots.lock().unwrap().contains_key(spec) {
                continue;
            }
            let module_stamp = file_stamp(self.loader.resolve_file(ref_).as_deref()).await;
            let stamp = format!(
                "{}|{}",
                module_stamp,
                serde_json::to_string(&ref_.config.clone().unwrap_or(Value::Null))
                    .unwrap_or_default()
            );
            if self
                .failed_stamps
                .lock()
                .unwrap()
                .get(spec)
                .cloned()
                .unwrap_or_default()
                == stamp
            {
                continue;
            }
            match self.prepare(ref_, None).await {
                Ok(slot) => {
                    let name = slot.name.clone();
                    match ctx
                        .plugin(
                            slot.plugin.clone(),
                            ref_.config.clone().unwrap_or(Value::Null),
                        )
                        .await
                    {
                        Ok(rt) => {
                            self.slots.lock().unwrap().insert(
                                spec.clone(),
                                Slot {
                                    rt: Some(rt),
                                    ..slot
                                },
                            );
                            self.failed_stamps.lock().unwrap().remove(spec);
                            result.added.push(spec.clone());
                            self.notify("plugin/loaded", serde_json::json!({ "spec": spec, "name": name, "reason": "added" }));
                        }
                        Err(e) => self.fail(spec, &stamp, &e),
                    }
                }
                Err(e) => self.fail(spec, &stamp, &e),
            }
        }
        Ok(result)
    }

    fn fail(&self, spec: &str, stamp: &str, err: &LeoError) {
        let mut result = ReloadResult::default();
        result.failed.push((spec.to_string(), err.message.clone()));
        self.failed_stamps
            .lock()
            .unwrap()
            .insert(spec.to_string(), stamp.to_string());
        self.notify(
            "plugin/failed",
            serde_json::json!({ "spec": spec, "error": err.message }),
        );
        self.logger.error_fields(serde_json::json!({ "err": err.to_string(), "spec": spec, "msg": "plugin reload failed" }));
    }

    fn notify(&self, event: &str, payload: Value) {
        if let Some(emit) = self.emit.lock().unwrap().clone() {
            emit(event, payload);
        }
    }

    pub fn close(&self) {
        *self.closed.lock().unwrap() = true;
    }
}

async fn file_stamp(file: Option<&Path>) -> String {
    let Some(file) = file else {
        return String::new();
    };
    let meta = match std::fs::metadata(file) {
        Ok(m) => m,
        Err(_) => return "missing".into(),
    };
    if meta.is_dir() {
        let mut entries: Vec<String> = match std::fs::read_dir(file) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect(),
            Err(_) => return "missing".into(),
        };
        entries.sort();
        let mut parts = Vec::new();
        for e in entries {
            parts.push(format!(
                "{}={}",
                e,
                Box::pin(file_stamp(Some(&file.join(&e).as_path()))).await
            ));
        }
        format!("dir[{}]", parts.join(","))
    } else {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{}:{}", mtime, meta.len())
    }
}

#[allow(dead_code)]
fn _disposer(_: Disposer) {}

#[allow(dead_code)]
fn _error_code(_: LeoErrorCode) {}
