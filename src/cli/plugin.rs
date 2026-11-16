//! `leo plugin`：从官方插件仓库（或自定义仓库）安装、移除、查看插件。

use crate::config::jsonc::{add_plugin_entry, list_plugin_entries, remove_plugin_entry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub const DEFAULT_PLUGIN_REGISTRY: &str =
    "https://raw.githubusercontent.com/CherryKingOne/leo-plugin/main/registry.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub id: String,
    pub package: String,
    pub version: String,
    pub status: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle: Option<Bundle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init: Option<Init>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purge: Option<Purge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bundle {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Init {
    #[serde(default)]
    pub files: Vec<InitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Purge {
    #[serde(default)]
    pub credentials: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    pub version: u32,
    pub plugins: Vec<RegistryEntry>,
}

pub trait PluginIo: Send + Sync {
    fn fetch_bytes(&self, location: &str) -> Result<Vec<u8>, String>;
    fn npm(&self, args: &[String], cwd: &str) -> Result<i32, String>;
    fn log(&self, line: &str);
}

pub struct DefaultIo<F> {
    pub log: F,
}

impl<F: Fn(&str) + Send + Sync> PluginIo for DefaultIo<F> {
    fn fetch_bytes(&self, location: &str) -> Result<Vec<u8>, String> {
        if let Some(path) = location.strip_prefix("file:") {
            return std::fs::read(path).map_err(|e| e.to_string());
        }
        if !location.starts_with("http://") && !location.starts_with("https://") {
            return std::fs::read(location).map_err(|e| e.to_string());
        }
        let resp = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .get(location)
            .call()
            .map_err(|e| format!("GET {} -> {}", location, e))?;
        let mut bytes = Vec::new();
        use std::io::Read;
        resp.into_reader()
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    }

    fn npm(&self, args: &[String], cwd: &str) -> Result<i32, String> {
        let status = Command::new("npm")
            .args(args)
            .current_dir(cwd)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(1))
    }

    fn log(&self, line: &str) {
        (self.log)(line);
    }
}

pub fn load_registry(location: &str, io: &dyn PluginIo) -> Result<Registry, String> {
    let bytes = io.fetch_bytes(location)?;
    let reg: Registry = serde_json::from_slice(&bytes)
        .map_err(|e| format!("无法读取插件仓库 {}：{}", location, e))?;
    Ok(reg)
}

pub fn find_entry<'a>(reg: &'a Registry, id_or_package: &str) -> Option<&'a RegistryEntry> {
    reg.plugins
        .iter()
        .find(|p| p.id == id_or_package || p.package == id_or_package)
}

fn resolve_location(location: &str, base: &str) -> String {
    if location.starts_with("http://")
        || location.starts_with("https://")
        || location.starts_with("file:")
        || Path::new(location).is_absolute()
    {
        return location.to_string();
    }
    if base.starts_with("http://") || base.starts_with("https://") {
        return format!("{}/{}", base.trim_end_matches('/'), location);
    }
    Path::new(base)
        .parent()
        .map(|p| p.join(location).display().to_string())
        .unwrap_or_else(|| location.to_string())
}

fn satisfies(range: Option<&str>, current: &str) -> bool {
    let Some(range) = range else { return true };
    let Some(rest) = range.trim().strip_prefix(">=") else {
        return true;
    };
    let want: Vec<u64> = rest.split('.').filter_map(|p| p.parse().ok()).collect();
    let have: Vec<u64> = current.split('.').filter_map(|p| p.parse().ok()).collect();
    for i in 0..3 {
        let a = have.get(i).copied().unwrap_or(0);
        let b = want.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    true
}

fn bundle_file(scope_dir: &str, id: &str) -> PathBuf {
    Path::new(scope_dir)
        .join("plugins")
        .join(format!("{}.bundle.js", id))
}

fn ensure_gitignore(project_root: &str, lines: &[&str]) {
    let gi = Path::new(project_root).join(".gitignore");
    let current = std::fs::read_to_string(&gi).unwrap_or_default();
    let need: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| !current.lines().any(|x| x == *l))
        .collect();
    if need.is_empty() {
        return;
    }
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&need.join("\n"));
    text.push('\n');
    let _ = std::fs::write(gi, text);
}

pub struct AddOptions {
    pub name: String,
    pub scope_dir: String,
    pub project_root: Option<String>,
    pub npm: bool,
    pub registry: String,
    pub leo_version: String,
    pub init: InitMode,
    pub force: bool,
}

#[derive(Debug, Clone)]
pub enum InitMode {
    Default,
    Skip,
    From(String),
}

pub async fn add_plugin(o: &AddOptions, io: &dyn PluginIo) -> Result<(), String> {
    let mut reg = None;
    let mut entry: Option<RegistryEntry> = None;
    match load_registry(&o.registry, io) {
        Ok(r) => {
            entry = find_entry(&r, &o.name).cloned();
            reg = Some(r);
        }
        Err(e) => {
            if !o.npm {
                return Err(e);
            }
            io.log(&format!("（{}，按 npm 包名安装）", e));
        }
    }
    if entry.is_none() && !o.npm {
        let ids: Vec<String> = reg
            .as_ref()
            .map(|r| {
                r.plugins
                    .iter()
                    .filter(|p| p.status != "planned")
                    .map(|p| p.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        return Err(format!(
            "插件仓库里没有 \"{}\"。可安装：{}。安装任意 npm 包请加 --npm",
            o.name,
            if ids.is_empty() {
                "（无）".into()
            } else {
                ids.join(", ")
            }
        ));
    }
    if let Some(e) = entry.as_ref() {
        if e.status == "planned" {
            return Err(format!("插件 \"{}\" 还在规划中，尚未发布", e.id));
        }
        if e.status == "deprecated" {
            io.log(&format!("注意：插件 \"{}\" 已弃用", e.id));
        }
        if !satisfies(e.leo.as_deref(), &o.leo_version) {
            return Err(format!(
                "插件 \"{}\" 需要 leo-agents {}，当前为 {}",
                e.id,
                e.leo.clone().unwrap_or_default(),
                o.leo_version
            ));
        }
    }

    std::fs::create_dir_all(&o.scope_dir).map_err(|e| e.to_string())?;
    if !o.npm {
        let e = entry.as_ref().ok_or("missing entry")?;
        let bundle = e.bundle.as_ref().ok_or_else(|| {
            format!(
                "插件 \"{}\" 没有提供单文件版本，请加 --npm 从 npm 安装",
                e.id
            )
        })?;
        let url = resolve_location(&bundle.url, &o.registry);
        io.log(&format!("下载 {}@{}：{}", e.id, e.version, url));
        let bytes = io.fetch_bytes(&url)?;
        if let Some(expected) = &bundle.sha256 {
            let got = hex(Sha256::digest(&bytes));
            if &got != expected.to_lowercase().as_str() {
                return Err(format!(
                    "校验失败：{} 的 sha256 应为 {}，实际为 {}。已放弃安装",
                    e.id, expected, got
                ));
            }
        }
        let file = bundle_file(&o.scope_dir, &e.id);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
        io.log(&format!(
            "已安装 {}@{} → {}",
            e.id,
            e.version,
            file.display()
        ));
        if !matches!(o.init, InitMode::Skip) {
            let from = match &o.init {
                InitMode::From(p) => Some(p.clone()),
                _ => None,
            };
            let _ = init_files(
                entry.as_ref(),
                &o.scope_dir,
                &o.registry,
                from,
                o.force,
                true,
                io,
            )
            .await?;
        }
        return Ok(());
    }

    let pkg = entry
        .as_ref()
        .map(|e| e.package.clone())
        .unwrap_or_else(|| o.name.clone());
    let spec = entry
        .as_ref()
        .map(|e| format!("{}@{}", e.package, e.version))
        .unwrap_or_else(|| pkg.clone());
    io.log(&format!("npm install {}（安装到 {}）", spec, o.scope_dir));
    let code = io.npm(
        &[
            "install".into(),
            "--prefix".into(),
            o.scope_dir.clone(),
            "--no-audit".into(),
            "--no-fund".into(),
            spec,
        ],
        &o.scope_dir,
    )?;
    if code != 0 {
        return Err(format!("npm install 失败（退出码 {}）", code));
    }
    let cfg = Path::new(&o.scope_dir).join("config.json");
    let text = std::fs::read_to_string(&cfg).unwrap_or_default();
    let pkg_name = pkg.clone();
    std::fs::write(&cfg, add_plugin_entry(&text, &pkg_name, None)).map_err(|e| e.to_string())?;
    if let Some(root) = &o.project_root {
        ensure_gitignore(root, &[".leo/node_modules/"]);
    }
    io.log(&format!(
        "已安装 {}（{}），并加入 {} 的 plugins",
        pkg_name,
        if o.project_root.is_some() {
            "当前项目"
        } else {
            "全局，所有项目可用"
        },
        cfg.display()
    ));
    Ok(())
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

fn safe_target(scope_dir: &str, path: &str) -> Result<PathBuf, String> {
    let target = Path::new(scope_dir).join(path);
    let root = Path::new(scope_dir);
    let rel = target.strip_prefix(root).map_err(|_| "outside")?;
    if rel.as_os_str().is_empty() || rel.starts_with("..") || Path::new(path).is_absolute() {
        return Err(format!(
            "初始化文件路径不合法：{}（必须是 .leo 内的相对路径）",
            path
        ));
    }
    Ok(target)
}

fn list_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(list_files(&p));
        } else {
            out.push(p);
        }
    }
    out
}

pub async fn init_files(
    entry: Option<&RegistryEntry>,
    scope_dir: &str,
    registry: &str,
    from: Option<String>,
    force: bool,
    quiet: bool,
    io: &dyn PluginIo,
) -> Result<Vec<String>, String> {
    let declared: Vec<InitFile> = entry
        .and_then(|e| e.init.as_ref())
        .map(|i| i.files.clone())
        .unwrap_or_default();
    let mut jobs: Vec<(
        String,
        Result<Vec<u8>, String>,
        Option<String>,
        Option<String>,
    )> = Vec::new();

    if let Some(src) = from {
        let src = PathBuf::from(src);
        if src.is_dir() {
            for f in list_files(&src) {
                let rel = f
                    .strip_prefix(&src)
                    .map(|p| p.display().to_string())
                    .unwrap_or_default();
                jobs.push((
                    rel,
                    std::fs::read(&f).map_err(|e| e.to_string()),
                    None,
                    None,
                ));
            }
        } else {
            let name = src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let target = if declared.len() == 1 {
                declared[0].path.clone()
            } else {
                declared
                    .iter()
                    .find(|d| d.path.ends_with(&name))
                    .map(|d| d.path.clone())
                    .unwrap_or(name)
            };
            jobs.push((
                target,
                std::fs::read(&src).map_err(|e| e.to_string()),
                None,
                None,
            ));
        }
    } else {
        if declared.is_empty() {
            if !quiet {
                io.log(&format!(
                    "插件 \"{}\" 没有需要初始化的配置文件",
                    entry.map(|e| e.id.as_str()).unwrap_or("?")
                ));
            }
            return Ok(Vec::new());
        }
        for f in &declared {
            if let Some(content) = &f.content {
                jobs.push((
                    f.path.clone(),
                    Ok(content.clone().into_bytes()),
                    f.sha256.clone(),
                    f.description.clone(),
                ));
            } else if let Some(url) = &f.url {
                let full = resolve_location(url, registry);
                jobs.push((
                    f.path.clone(),
                    io.fetch_bytes(&full),
                    f.sha256.clone(),
                    f.description.clone(),
                ));
            } else {
                return Err(format!("初始化文件 {} 缺少 url 或 content", f.path));
            }
        }
    }

    let mut written = Vec::new();
    for (path, load, sha, desc) in jobs {
        let target = safe_target(scope_dir, &path)?;
        if target.exists() && !force {
            io.log(&format!(
                "  已存在，保留：{}（--force 覆盖）",
                target.display()
            ));
            continue;
        }
        let bytes = load?;
        if let Some(expected) = sha {
            let got = hex(Sha256::digest(&bytes));
            if got != expected.to_lowercase() {
                return Err(format!(
                    "模板 {} 校验失败：sha256 应为 {}，实际为 {}",
                    path, expected, got
                ));
            }
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
        written.push(target.display().to_string());
        io.log(&format!(
            "  已初始化 {}{}",
            target.display(),
            desc.map(|d| format!("：{}", d)).unwrap_or_default()
        ));
    }
    Ok(written)
}

pub async fn init_plugin(
    name: &str,
    scope_dir: &str,
    registry: &str,
    from: Option<String>,
    force: bool,
    io: &dyn PluginIo,
) -> Result<Vec<String>, String> {
    let entry = load_registry(registry, io)
        .ok()
        .and_then(|r| find_entry(&r, name).cloned());
    if entry.is_none() && from.is_none() {
        return Err(format!("找不到插件 \"{}\" 的配置模板", name));
    }
    init_files(entry.as_ref(), scope_dir, registry, from, force, false, io).await
}

pub async fn remove_plugin(
    name: &str,
    scope_dir: &str,
    registry: &str,
    purge: bool,
    io: &dyn PluginIo,
) -> Result<bool, String> {
    let entry = load_registry(registry, io)
        .ok()
        .and_then(|r| find_entry(&r, name).cloned());
    let id = entry
        .as_ref()
        .map(|e| e.id.clone())
        .unwrap_or_else(|| name.to_string());
    let pkg = entry
        .as_ref()
        .map(|e| e.package.clone())
        .unwrap_or_else(|| name.to_string());
    let mut removed = false;

    let purge_files: Vec<String> = if purge {
        entry
            .as_ref()
            .and_then(|e| e.init.as_ref())
            .map(|i| i.files.iter().map(|f| f.path.clone()).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let purge_credentials: Vec<String> = if purge {
        entry
            .as_ref()
            .and_then(|e| e.purge.as_ref())
            .map(|p| p.credentials.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let file = bundle_file(scope_dir, &id);
    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| e.to_string())?;
        io.log(&format!("已删除 {}", file.display()));
        removed = true;
    }
    let cfg = Path::new(scope_dir).join("config.json");
    let text = std::fs::read_to_string(&cfg).unwrap_or_default();
    if list_plugin_entries(&text).iter().any(|p| p == &pkg) {
        std::fs::write(&cfg, remove_plugin_entry(&text, &pkg)).map_err(|e| e.to_string())?;
        io.log(&format!("已从 {} 移除 {}", cfg.display(), pkg));
        removed = true;
    }
    let pkg_json = Path::new(scope_dir)
        .join("node_modules")
        .join(&pkg)
        .join("package.json");
    if pkg_json.exists() {
        let code = io.npm(
            &[
                "uninstall".into(),
                "--prefix".into(),
                scope_dir.to_string(),
                "--no-audit".into(),
                "--no-fund".into(),
                pkg.clone(),
            ],
            scope_dir,
        )?;
        if code != 0 {
            return Err(format!("npm uninstall 失败（退出码 {}）", code));
        }
        io.log(&format!("已卸载 npm 包 {}", pkg));
        removed = true;
    }
    if removed {
        for rel in purge_files {
            let target = safe_target(scope_dir, &rel)?;
            if target.exists() {
                if target.is_dir() {
                    let _ = std::fs::remove_dir_all(&target);
                } else {
                    let _ = std::fs::remove_file(&target);
                }
                io.log(&format!("已删除配置文件 {}", target.display()));
            }
        }
        if !purge_credentials.is_empty() {
            let creds = Path::new(scope_dir).join("credentials.json");
            purge_credential_keys(&creds, &purge_credentials, io);
        }
    }
    if !removed {
        io.log(&format!("没有找到已安装的 \"{}\"（{}）", name, scope_dir));
    }
    Ok(removed)
}

fn purge_credential_keys(file: &Path, keys: &[String], io: &dyn PluginIo) {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    if text.trim().is_empty() {
        return;
    }
    let Ok(Value::Object(mut data)) = serde_json::from_str::<Value>(&text) else {
        io.log(&format!("跳过清理凭据：{} 不是合法 JSON", file.display()));
        return;
    };
    let hit: Vec<String> = data
        .keys()
        .filter(|k| {
            keys.iter().any(|p| {
                if let Some(prefix) = p.strip_suffix('/') {
                    k.starts_with(prefix)
                } else {
                    k.as_str() == p.as_str()
                }
            })
        })
        .cloned()
        .collect();
    if hit.is_empty() {
        return;
    }
    for k in &hit {
        data.remove(k);
    }
    let _ = std::fs::write(
        file,
        serde_json::to_string_pretty(&Value::Object(data)).unwrap() + "\n",
    );
    io.log(&format!(
        "已从 {} 删除凭据：{}",
        file.display(),
        hit.join(", ")
    ));
}

pub async fn uninstall_plugin(
    name: &str,
    registry: &str,
    user_dir: &str,
    project_dir: Option<&str>,
    scope: UninstallScope,
    purge: bool,
    io: &dyn PluginIo,
) -> Result<bool, String> {
    let mut dirs: Vec<(String, String)> = Vec::new();
    if scope != UninstallScope::Project {
        dirs.push(("全局".into(), user_dir.to_string()));
    }
    if scope != UninstallScope::Global {
        match project_dir {
            Some(p) if p != user_dir => dirs.push(("项目".into(), p.to_string())),
            Some(_) => {}
            None => {
                if scope == UninstallScope::Project {
                    io.log("当前目录及上级没有项目 .leo/，没有可卸载的项目插件");
                    return Ok(false);
                }
            }
        }
    }
    let mut any = false;
    for (label, dir) in &dirs {
        io.log(&format!("卸载{}插件 {}（{}）", label, name, dir));
        if remove_plugin(name, dir, registry, purge, io).await? {
            any = true;
        }
    }
    Ok(any)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UninstallScope {
    Global,
    Project,
    All,
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

/// 解析 npm 包入口（简化版，覆盖 exports["."].import / main / module）。
pub fn resolve_plugin_package(spec: &str, dirs: &[String]) -> Option<String> {
    let parts: Vec<&str> = spec.split('/').collect();
    let name_len = if spec.starts_with('@') { 2 } else { 1 };
    if parts.len() < name_len {
        return None;
    }
    let name = parts[..name_len].join("/");
    let subpath = parts[name_len..].join("/");
    for start in dirs {
        let mut dir = PathBuf::from(start);
        loop {
            let pkg_dir = dir.join("node_modules").join(&name);
            let pkg_json = pkg_dir.join("package.json");
            if pkg_json.exists() {
                if let Ok(text) = std::fs::read_to_string(&pkg_json) {
                    if let Ok(pkg) = serde_json::from_str::<Value>(&text) {
                        let entry = if let Some(exports) = pkg.get("exports") {
                            let key = if subpath.is_empty() {
                                "."
                            } else {
                                &format!("./{}", subpath)
                            };
                            let target = exports.get(key).or_else(|| {
                                if key == "." {
                                    Some(exports)
                                } else {
                                    None
                                }
                            });
                            target
                                .and_then(|t| t.get("import").or_else(|| t.get("default")))
                                .and_then(|v| v.as_str())
                                .map(String::from)
                        } else if !subpath.is_empty() {
                            Some(subpath.clone())
                        } else {
                            pkg.get("module")
                                .or_else(|| pkg.get("main"))
                                .and_then(|v| v.as_str())
                                .map(String::from)
                        };
                        if let Some(rel) = entry {
                            return Some(normalize(&pkg_dir.join(rel)).display().to_string());
                        }
                    }
                }
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}
