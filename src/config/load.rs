//! 配置发现与合并。

use crate::config::secrets::{read_credential_file, CredentialMap};
use crate::config::types::{LeoConfig, PluginEntry};
use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone)]
pub struct PluginSpec {
    pub spec: String,
    pub config: Option<Value>,
    pub from: String,
}

#[derive(Debug, Clone, Default)]
pub struct LeoPaths {
    pub cwd: String,
    pub project_root: Option<String>,
    pub project_dir: Option<String>,
    pub user_dir: String,
    pub project_config: Option<String>,
    pub user_config: String,
    pub project_credentials: Option<String>,
    pub user_credentials: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub config: LeoConfig,
    pub paths: LeoPaths,
    pub credentials: ResolvedCredentials,
    pub plugins: Vec<PluginSpec>,
    pub loaded_files: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ResolvedCredentials {
    pub project: CredentialMap,
    pub user: CredentialMap,
}

#[derive(Debug, Clone, Default)]
pub struct LoadConfigOptions {
    pub cwd: Option<String>,
    pub user_dir: Option<String>,
    pub overrides: Option<Value>,
    pub env: Option<BTreeMap<String, String>>,
    pub ignore_project: bool,
}

pub fn default_user_dir(env: &BTreeMap<String, String>) -> String {
    if let Some(home) = env.get("LEO_HOME") {
        return PathBuf::from(home).display().to_string();
    }
    let home = env
        .get("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".leo").display().to_string()
}

pub fn find_project_root(cwd: &str, user_dir: &str) -> Option<String> {
    let mut dir = PathBuf::from(cwd);
    loop {
        let candidate = dir.join(".leo");
        if candidate.exists() && candidate.is_dir() && candidate.display().to_string() != user_dir {
            return Some(dir.display().to_string());
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn read_json(path: &Path) -> LeoResult<Option<Map<String, Value>>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(LeoError::new(LeoErrorCode::Internal, e.to_string())),
    };
    let stripped = strip_line_comments(&text);
    let data: Value = serde_json::from_str(&stripped).map_err(|e| {
        LeoError::new(
            LeoErrorCode::PluginConfigInvalid,
            format!("Invalid config file {}: {}", path.display(), e),
        )
    })?;
    data.as_object().cloned().map(Some).ok_or_else(|| {
        LeoError::new(
            LeoErrorCode::PluginConfigInvalid,
            format!(
                "Invalid config file {}: must be a JSON object",
                path.display()
            ),
        )
    })
}

fn strip_line_comments(text: &str) -> String {
    let re = regex::Regex::new(r"(?m)^\s*//.*$").unwrap();
    re.replace_all(text, "").to_string()
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_plain_object(v: &Value) -> bool {
    v.is_object()
}

/// 深合并：b 覆盖 a；plugins 数组拼接。
pub fn merge_config(a: &Map<String, Value>, b: &Map<String, Value>) -> Map<String, Value> {
    let mut out = a.clone();
    for (k, v) in b {
        if v.is_null() {
            continue;
        }
        if k == "plugins" && v.is_array() && out.get(k).is_some_and(|x| x.is_array()) {
            let mut merged = out
                .get(k)
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            merged.extend(v.as_array().cloned().unwrap_or_default());
            out.insert(k.clone(), Value::Array(merged));
        } else if is_plain_object(v) && out.get(k).is_some_and(is_plain_object) {
            let left = out
                .get(k)
                .and_then(|x| x.as_object())
                .cloned()
                .unwrap_or_default();
            let right = v.as_object().cloned().unwrap_or_default();
            out.insert(k.clone(), Value::Object(merge_config(&left, &right)));
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn plugin_refs(
    raw: Option<&Map<String, Value>>,
    base_dir: &str,
    from: &str,
) -> LeoResult<Vec<PluginSpec>> {
    let Some(list) = raw
        .and_then(|m| m.get("plugins"))
        .and_then(|p| p.as_array())
    else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in list {
        let (spec, config) = match entry {
            Value::String(s) => (s.clone(), None),
            Value::Array(arr) if !arr.is_empty() => {
                let spec = arr[0]
                    .as_str()
                    .ok_or_else(|| {
                        LeoError::new(
                            LeoErrorCode::PluginConfigInvalid,
                            format!("Invalid plugin entry in {}", from),
                        )
                    })?
                    .to_string();
                (spec, arr.get(1).cloned())
            }
            _ => {
                return Err(LeoError::new(
                    LeoErrorCode::PluginConfigInvalid,
                    format!("Invalid plugin entry in {}", from),
                ))
            }
        };
        let path = Path::new(&spec);
        let abs = if spec.starts_with('.') || path.is_absolute() {
            normalize(&Path::new(base_dir).join(path))
                .display()
                .to_string()
        } else {
            spec.clone()
        };
        out.push(PluginSpec {
            spec: abs,
            config,
            from: from.to_string(),
        });
    }
    Ok(out)
}

fn discover_plugin_dir(dir: &Path) -> Vec<PluginSpec> {
    let mut files: Vec<String> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|f| {
                (f.ends_with(".js") || f.ends_with(".mjs") || f.ends_with(".ts"))
                    && !f.ends_with(".d.ts")
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    files
        .into_iter()
        .map(|f| PluginSpec {
            spec: dir.join(f).display().to_string(),
            config: None,
            from: dir.display().to_string(),
        })
        .collect()
}

fn bundle_key(
    spec: &str,
    user_plugin_dir: &str,
    project_plugin_dir: Option<&str>,
) -> Option<String> {
    let path = Path::new(spec);
    let dir = path.parent()?.display().to_string();
    if dir == user_plugin_dir || Some(dir.as_str()) == project_plugin_dir {
        Some(format!("plugins/{}", path.file_name()?.to_string_lossy()))
    } else {
        None
    }
}

pub fn load_config(opts: &LoadConfigOptions) -> LeoResult<ResolvedConfig> {
    let env = opts
        .env
        .clone()
        .unwrap_or_else(|| std::env::vars().collect::<BTreeMap<String, String>>());
    let cwd = opts.cwd.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| ".".into())
    });
    let user_dir = opts
        .user_dir
        .clone()
        .unwrap_or_else(|| default_user_dir(&env));
    let project_root = if opts.ignore_project {
        None
    } else {
        find_project_root(&cwd, &user_dir)
    };
    let project_dir = project_root
        .as_ref()
        .map(|r| Path::new(r).join(".leo").display().to_string());
    let user_config = Path::new(&user_dir)
        .join("config.json")
        .display()
        .to_string();
    let user_credentials = Path::new(&user_dir)
        .join("credentials.json")
        .display()
        .to_string();
    let project_config = project_dir
        .as_ref()
        .map(|d| Path::new(d).join("config.json").display().to_string());
    let project_credentials = project_dir
        .as_ref()
        .map(|d| Path::new(d).join("credentials.json").display().to_string());

    let mut loaded_files = Vec::new();
    let user_raw = read_json(Path::new(&user_config))?;
    if user_raw.is_some() {
        loaded_files.push(user_config.clone());
    }
    let project_raw = match &project_config {
        Some(p) => read_json(Path::new(p))?,
        None => None,
    };
    if project_raw.is_some() {
        loaded_files.push(project_config.clone().unwrap());
    }

    let mut all: Vec<PluginSpec> = Vec::new();
    all.extend(plugin_refs(user_raw.as_ref(), &user_dir, &user_config)?);
    all.extend(discover_plugin_dir(&Path::new(&user_dir).join("plugins")));
    if let Some(root) = &project_root {
        all.extend(plugin_refs(
            project_raw.as_ref(),
            root,
            project_config.as_deref().unwrap_or(""),
        )?);
    }
    if let Some(dir) = &project_dir {
        all.extend(discover_plugin_dir(&Path::new(dir).join("plugins")));
    }
    all.extend(plugin_refs(
        opts.overrides.as_ref().and_then(|v| v.as_object()),
        &cwd,
        "overrides",
    )?);

    let user_plugin_dir = Path::new(&user_dir).join("plugins").display().to_string();
    let project_plugin_dir = project_dir
        .as_ref()
        .map(|d| Path::new(d).join("plugins").display().to_string());
    let mut plugins: Vec<PluginSpec> = Vec::new();
    for ref_ in all {
        let key = bundle_key(&ref_.spec, &user_plugin_dir, project_plugin_dir.as_deref());
        let idx = plugins.iter().position(|p| {
            p.spec == ref_.spec
                || (key.is_some()
                    && bundle_key(&p.spec, &user_plugin_dir, project_plugin_dir.as_deref()) == key)
        });
        match idx {
            None => plugins.push(ref_),
            Some(i) => {
                if plugins[i].spec != ref_.spec {
                    let config = ref_.config.clone().or_else(|| plugins[i].config.clone());
                    plugins[i] = PluginSpec {
                        spec: ref_.spec,
                        config,
                        from: ref_.from,
                    };
                } else if ref_.config.is_some() && plugins[i].config.is_none() {
                    plugins[i].config = ref_.config;
                }
            }
        }
    }

    let mut merged = Map::new();
    for layer in [
        user_raw,
        project_raw,
        opts.overrides.as_ref().and_then(|v| v.as_object()).cloned(),
    ] {
        if let Some(layer) = layer {
            merged = merge_config(&merged, &layer);
        }
    }
    merged.remove("plugins");
    let config: LeoConfig = serde_json::from_value(Value::Object(merged)).map_err(|e| {
        LeoError::new(
            LeoErrorCode::PluginConfigInvalid,
            format!("Invalid leo config: {}", e),
        )
    })?;

    let credentials = ResolvedCredentials {
        user: read_credential_file(Path::new(&user_credentials))?,
        project: match &project_credentials {
            Some(p) => read_credential_file(Path::new(p))?,
            None => CredentialMap::new(),
        },
    };

    Ok(ResolvedConfig {
        config,
        paths: LeoPaths {
            cwd,
            project_root,
            project_dir,
            user_dir,
            project_config,
            user_config,
            project_credentials,
            user_credentials,
        },
        credentials,
        plugins,
        loaded_files,
    })
}

#[allow(dead_code)]
fn _entry(_: &PluginEntry) {}
