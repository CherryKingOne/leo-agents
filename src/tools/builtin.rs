//! 内置通用工具：读写文件、搜索、执行命令、抓取网页。

use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use crate::kernel::plugin::{plugin_fn, plugin_fn_injected, PluginRef};
use crate::tools::types::{ExecuteFn, ToolDefinition, ToolExecContext, ToolOutput};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const BUILTIN_TOOL_NAMES: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "grep",
    "bash",
    "web_fetch",
];

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".leo",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
];
const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_OUTPUT_CHARS: usize = 30_000;

#[derive(Clone)]
pub struct BuiltinToolsOptions {
    pub workspace: Option<String>,
    pub tools: Option<Vec<String>>,
    pub allow_outside_workspace: bool,
    pub bash_timeout_ms: Option<u64>,
}

impl Default for BuiltinToolsOptions {
    fn default() -> Self {
        Self {
            workspace: None,
            tools: None,
            allow_outside_workspace: false,
            bash_timeout_ms: None,
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let half = max / 2;
    let head: String = chars[..half].iter().collect();
    let tail: String = chars[chars.len() - half..].iter().collect();
    format!(
        "{}\n\n…[{} characters omitted]…\n\n{}",
        head,
        chars.len() - max,
        tail
    )
}

fn normalize_path(base: &Path, p: &str) -> PathBuf {
    let path = Path::new(p);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut out = PathBuf::new();
    for comp in joined.components() {
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

fn path_of(root: &Path, p: &str, allow_outside: bool) -> LeoResult<PathBuf> {
    let abs = normalize_path(root, p);
    if !allow_outside && abs != root && !abs.starts_with(root) {
        return Err(LeoError::new(
            LeoErrorCode::ToolDenied,
            format!("Path is outside the workspace ({}): {}", root.display(), p),
        ));
    }
    Ok(abs)
}

fn rel_of(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| ".".into())
}

fn err(msg: impl Into<String>) -> LeoResult<ToolOutput> {
    Ok(ToolOutput::error(msg))
}

pub fn create_builtin_tools(opts: &BuiltinToolsOptions) -> Vec<Arc<ToolDefinition>> {
    let root = opts
        .workspace
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root = normalize_path(&root, ".");
    let allow_outside = opts.allow_outside_workspace;
    let root_clone = root.clone();

    let read_file = ToolDefinition::new(
        "read_file",
        "Read a UTF-8 text file. Returns lines prefixed with line numbers. Use offset/limit (1-based lines) for large files.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path, relative to the workspace or absolute"},
                "offset": {"type": "integer", "minimum": 1},
                "limit": {"type": "integer", "minimum": 1}
            },
            "required": ["path"]
        }),
        Arc::new(move |args: Value, _exec: ToolExecContext| {
            let root = root_clone.clone();
            Box::pin(async move {
                let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;
                let abs = path_of(&root, path, allow_outside)?;
                let meta = tokio::fs::metadata(&abs).await.map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
                if meta.is_dir() {
                    return err(format!("{} is a directory; use list_dir", path));
                }
                let buf = tokio::fs::read(&abs).await.map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
                if buf.iter().take(8000).any(|b| *b == 0) {
                    return err(format!("{} looks like a binary file", path));
                }
                let text = String::from_utf8_lossy(&buf[..buf.len().min(MAX_READ_BYTES)]).to_string();
                let lines: Vec<&str> = text.split('\n').collect();
                let start = offset.saturating_sub(1);
                let slice: Vec<&str> = lines.iter().skip(start).take(limit).copied().collect();
                let body = slice
                    .iter()
                    .enumerate()
                    .map(|(i, l)| format!("{:>5}\t{}", start + i + 1, l))
                    .collect::<Vec<_>>()
                    .join("\n");
                let more = start + slice.len() < lines.len() || buf.len() > MAX_READ_BYTES;
                let out = if more {
                    format!(
                        "{}\n\n[file continues; {} lines read so far, use offset to read more]",
                        body,
                        lines.len()
                    )
                } else if body.is_empty() {
                    "(empty file)".into()
                } else {
                    body
                };
                Ok(ToolOutput::text(out))
            })
        }),
    );

    let write_file = ToolDefinition::new(
        "write_file",
        "Create or overwrite a text file with the given content. Parent directories are created automatically.",
        json!({
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"]
        }),
        {
            let root = root.clone();
            Arc::new(move |args: Value, _exec: ToolExecContext| {
                let root = root.clone();
                Box::pin(async move {
                    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let abs = path_of(&root, path, allow_outside)?;
                    if let Some(parent) = abs.parent() {
                        tokio::fs::create_dir_all(parent).await.map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
                    }
                    tokio::fs::write(&abs, content).await.map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
                    Ok(ToolOutput::text(format!(
                        "Wrote {} bytes to {}",
                        content.len(),
                        rel_of(&root, &abs)
                    )))
                })
            })
        },
    )
    .permissions(vec![crate::tools::types::Permission {
        kind: "fs.write".into(),
        side_effect: None,
        extra: Default::default(),
    }])
    .sequential();

    let edit_file = ToolDefinition::new(
        "edit_file",
        "Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string", "minLength": 1},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"}
            },
            "required": ["path", "old_string", "new_string"]
        }),
        {
            let root = root.clone();
            Arc::new(move |args: Value, _exec: ToolExecContext| {
                let root = root.clone();
                Box::pin(async move {
                    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let old = args.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                    let new = args.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                    let replace_all = args.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
                    let abs = path_of(&root, path, allow_outside)?;
                    let text = tokio::fs::read_to_string(&abs).await.map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
                    let count = text.matches(old).count();
                    if count == 0 {
                        return err(format!("old_string not found in {}", path));
                    }
                    if count > 1 && !replace_all {
                        return err(format!(
                            "old_string occurs {} times in {}; add more context or set replace_all",
                            count, path
                        ));
                    }
                    let next = if replace_all { text.replace(old, new) } else { text.replacen(old, new, 1) };
                    tokio::fs::write(&abs, next).await.map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
                    Ok(ToolOutput::text(format!("Edited {} ({} replacements)", rel_of(&root, &abs), if replace_all { count } else { 1 })))
                })
            })
        },
    )
    .permissions(vec![crate::tools::types::Permission {
        kind: "fs.write".into(),
        side_effect: None,
        extra: Default::default(),
    }])
    .sequential();

    let list_dir = ToolDefinition::new(
        "list_dir",
        "List files and directories (directories end with /). Skips .git, node_modules and similar.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "depth": {"type": "integer", "minimum": 1, "maximum": 5}
            }
        }),
        {
            let root = root.clone();
            Arc::new(move |args: Value, _exec: ToolExecContext| {
                let root = root.clone();
                Box::pin(async move {
                    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                    let depth = args.get("depth").and_then(|v| v.as_u64()).unwrap_or(2) as usize;
                    let base = path_of(&root, path, allow_outside)?;
                    let mut out = Vec::new();
                    walk(&base, depth, 0, &mut out).await?;
                    if out.is_empty() {
                        Ok(ToolOutput::text("(empty directory)"))
                    } else {
                        let mut s = out.join("\n");
                        if out.len() >= 500 {
                            s.push_str("\n…(truncated)");
                        }
                        Ok(ToolOutput::text(s))
                    }
                })
            })
        },
    );

    let grep = ToolDefinition::new(
        "grep",
        "Search file contents with a regular expression. Returns path:line: text (max 200 matches).",
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "glob": {"type": "string"},
                "ignore_case": {"type": "boolean"}
            },
            "required": ["pattern"]
        }),
        {
            let root = root.clone();
            Arc::new(move |args: Value, _exec: ToolExecContext| {
                let root = root.clone();
                Box::pin(async move {
                    let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
                    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                    let glob = args.get("glob").and_then(|v| v.as_str());
                    let ignore_case = args.get("ignore_case").and_then(|v| v.as_bool()).unwrap_or(false);
                    let re = regex::RegexBuilder::new(pattern)
                        .case_insensitive(ignore_case)
                        .build()
                        .map_err(|e| LeoError::new(LeoErrorCode::ToolInvalidArgs, e.to_string()))?;
                    let base = path_of(&root, path, allow_outside)?;
                    let mut out = Vec::new();
                    grep_visit(&base, &re, glob, &root, &mut out).await?;
                    if out.is_empty() {
                        Ok(ToolOutput::text("No matches"))
                    } else {
                        let mut s = out.join("\n");
                        if out.len() >= 200 {
                            s.push_str("\n…(more matches omitted)");
                        }
                        Ok(ToolOutput::text(s))
                    }
                })
            })
        },
    );

    let bash = ToolDefinition::new(
        "bash",
        "Run a shell command in the workspace directory and return its combined stdout/stderr and exit code. Avoid interactive commands.",
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout_ms": {"type": "integer", "minimum": 1}
            },
            "required": ["command"]
        }),
        {
            let root = root.clone();
            let bash_timeout = opts.bash_timeout_ms.unwrap_or(120_000);
            Arc::new(move |args: Value, exec: ToolExecContext| {
                let root = root.clone();
                Box::pin(async move {
                    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(bash_timeout);
                    let mut cmd = tokio::process::Command::new("bash");
                    cmd.arg("-lc").arg(command).current_dir(&root);
                    cmd.stdin(std::process::Stdio::null());
                    cmd.stdout(std::process::Stdio::piped());
                    cmd.stderr(std::process::Stdio::piped());
                    cmd.kill_on_drop(true);
                    let child = cmd.spawn().map_err(|e| LeoError::new(LeoErrorCode::ToolError, format!("Failed to start shell: {}", e)))?;
                    let id = child.id();
                    let mut handle = tokio::spawn(async move { child.wait_with_output().await });
                    let output = tokio::select! {
                        _ = exec.signal.cancelled() => {
                            if let Some(id) = id { let _ = tokio::process::Command::new("kill").args(["-TERM", &id.to_string()]).status().await; }
                            handle.abort();
                            return Ok(ToolOutput {
                                content: crate::tools::types::ToolContent::Text("".into()),
                                is_error: Some(true),
                                terminate: None,
                                details: None,
                                display: None,
                            });
                        }
                        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                            if let Some(id) = id { let _ = tokio::process::Command::new("kill").args(["-KILL", &id.to_string()]).status().await; }
                            handle.abort();
                            return err("[command timed out]");
                        }
                        res = &mut handle => { res }
                    };
                    match output {
                        Ok(Ok(out)) => {
                            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
                            text.push_str(&String::from_utf8_lossy(&out.stderr));
                            let tail = format!("\n[exit code {}]", out.status.code().unwrap_or(-1));
                            Ok(ToolOutput {
                                content: crate::tools::types::ToolContent::Text(format!("{}{}", clip(text.trim_end(), MAX_OUTPUT_CHARS), tail)),
                                is_error: Some(!out.status.success()),
                                terminate: None,
                                details: None,
                                display: None,
                            })
                        }
                        Ok(Err(e)) => err(format!("Failed to run shell: {}", e)),
                        Err(e) => err(format!("Failed to run shell: {}", e)),
                    }
                })
            })
        },
    )
    .permissions(vec![crate::tools::types::Permission {
        kind: "process.exec".into(),
        side_effect: None,
        extra: Default::default(),
    }])
    .timeout_ms(30 * 60_000)
    .sequential();

    let web_fetch = ToolDefinition::new(
        "web_fetch",
        "Fetch a URL over HTTP(S) and return its text (HTML is converted to plain text).",
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "max_chars": {"type": "integer", "minimum": 1}
            },
            "required": ["url"]
        }),
        Arc::new(move |args: Value, _exec: ToolExecContext| {
            Box::pin(async move {
                let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let max_chars = args
                    .get("max_chars")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(20_000) as usize;
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    return err("Only http(s) URLs are supported");
                }
                let url = url.to_string();
                let fetch_url = url.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let agent = ureq::AgentBuilder::new()
                        .timeout(Duration::from_secs(30))
                        .user_agent("leo-agents/0.1")
                        .build();
                    agent.get(&fetch_url).call()
                })
                .await;
                match result {
                    Ok(Ok(resp)) => {
                        let status = resp.status();
                        let content_type = resp.header("content-type").unwrap_or("").to_string();
                        let mut text = resp.into_string().unwrap_or_default();
                        if content_type.contains("html") {
                            text = html_to_text(&text);
                        }
                        let body = clip(text.trim(), max_chars);
                        Ok(ToolOutput {
                            content: crate::tools::types::ToolContent::Text(format!(
                                "HTTP {} {}\n\n{}",
                                status, url, body
                            )),
                            is_error: Some(status >= 400),
                            terminate: None,
                            details: None,
                            display: None,
                        })
                    }
                    Ok(Err(e)) => err(e.to_string()),
                    Err(e) => err(e.to_string()),
                }
            })
        }),
    )
    .idempotent(None)
    .permissions(vec![crate::tools::types::Permission {
        kind: "net.fetch".into(),
        side_effect: None,
        extra: Default::default(),
    }]);

    let all = vec![
        Arc::new(read_file),
        Arc::new(write_file),
        Arc::new(edit_file),
        Arc::new(list_dir),
        Arc::new(grep),
        Arc::new(bash),
        Arc::new(web_fetch),
    ];
    match &opts.tools {
        Some(names) => all
            .into_iter()
            .filter(|t| names.iter().any(|n| n == &t.name))
            .collect(),
        None => all,
    }
}

async fn walk(dir: &Path, depth: usize, level: usize, out: &mut Vec<String>) -> LeoResult<()> {
    if out.len() >= 500 {
        return Ok(());
    }
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    let mut names: Vec<(String, bool)> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        names.push((name, is_dir));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, is_dir) in names {
        if out.len() >= 500 {
            break;
        }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        out.push(format!(
            "{}{}{}",
            "  ".repeat(depth.saturating_sub(level + 1)),
            name,
            if is_dir { "/" } else { "" }
        ));
        if is_dir && level + 1 < depth {
            Box::pin(walk(&dir.join(&name), depth, level + 1, out)).await?;
        }
    }
    Ok(())
}

async fn grep_visit(
    path: &Path,
    re: &regex::Regex,
    glob: Option<&str>,
    root: &Path,
    out: &mut Vec<String>,
) -> LeoResult<()> {
    if out.len() >= 200 {
        return Ok(());
    }
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if meta.is_dir() {
        let mut entries = tokio::fs::read_dir(path)
            .await
            .map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false)
                && SKIP_DIRS.contains(&name.as_str())
            {
                continue;
            }
            Box::pin(grep_visit(&entry.path(), re, glob, root, out)).await?;
        }
        return Ok(());
    }
    if let Some(g) = glob {
        if !path.to_string_lossy().ends_with(g) {
            return Ok(());
        }
    }
    if meta.len() > 1024 * 1024 {
        return Ok(());
    }
    let buf = tokio::fs::read(path)
        .await
        .map_err(|e| LeoError::new(LeoErrorCode::ToolError, e.to_string()))?;
    if buf.iter().take(8000).any(|b| *b == 0) {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&buf);
    for (i, line) in text.split('\n').enumerate() {
        if out.len() >= 200 {
            break;
        }
        if re.is_match(line) {
            out.push(format!(
                "{}:{}: {}",
                rel_of(root, path),
                i + 1,
                line.chars().take(300).collect::<String>()
            ));
        }
    }
    Ok(())
}

/// 极简 HTML → 文本
pub fn html_to_text(html: &str) -> String {
    let re_script = regex::Regex::new(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>").unwrap();
    let re_br = regex::Regex::new(r"(?i)<br\s*/?>").unwrap();
    let re_block = regex::Regex::new(r"(?i)</(p|div|li|h[1-6]|tr|section|article)>").unwrap();
    let re_tag = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let re_space = regex::Regex::new(r"[ \t]+").unwrap();
    let re_nl = regex::Regex::new(r"\n\s*\n\s*\n+").unwrap();
    let s = re_script.replace_all(html, "");
    let s = re_br.replace_all(&s, "\n");
    let s = re_block.replace_all(&s, "\n");
    let s = re_tag.replace_all(&s, "");
    let s = s
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let s = re_space.replace_all(&s, " ");
    re_nl.replace_all(&s, "\n\n").to_string()
}

/// 内置工具插件
pub fn builtin_tools_plugin(opts: BuiltinToolsOptions) -> PluginRef {
    plugin_fn_injected(
        "leo:builtin-tools",
        vec!["tools".into()],
        move |ctx, _cfg| {
            let opts = opts.clone();
            async move {
                for tool in create_builtin_tools(&opts) {
                    let tools = ctx.get::<crate::tools::types::ToolRegistryHandle>("tools")?;
                    let d = tools.register(tool);
                    let _ = ctx.effect(|| async { Ok(d) }).await?;
                }
                Ok(())
            }
        },
    )
}

#[derive(Clone)]
pub struct ApprovalPolicyOptions {
    pub mode: String,
    pub side_effect_kinds: Vec<String>,
}

impl Default for ApprovalPolicyOptions {
    fn default() -> Self {
        Self {
            mode: "ask".into(),
            side_effect_kinds: vec!["fs.write".into(), "process.exec".into()],
        }
    }
}

/// 审批策略插件。
pub fn approval_policy(opts: ApprovalPolicyOptions) -> PluginRef {
    plugin_fn("leo:approval-policy", move |ctx, _cfg| {
        let opts = opts.clone();
        async move {
            let handler_ctx = ctx.clone();
            ctx.on("tools/pre-execute", "leo:approval-policy", false, move |payload: Value, next| {
                let opts = opts.clone();
                let ctx = handler_ctx.clone();
                Box::pin(async move {
                    let tool_name = payload.get("toolName").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let permissions = payload.get("permissions").cloned().unwrap_or(Value::Null);
                    let risky = permissions.as_array().is_some_and(|arr| {
                        arr.iter().any(|p| {
                            p.get("sideEffect").and_then(|v| v.as_bool()).unwrap_or(false)
                                || p.get("kind")
                                    .and_then(|k| k.as_str())
                                    .is_some_and(|k| opts.side_effect_kinds.iter().any(|s| s == k))
                        })
                    });
                    if !risky || opts.mode == "auto" {
                        return next(payload).await;
                    }
                    if opts.mode == "deny" {
                        return Ok(json!({"action": "deny", "reason": format!("Tool \"{}\" is disabled by approval policy (deny)", tool_name)}));
                    }
                    if !ctx.has("approval") {
                        return Ok(json!({"action": "deny", "reason": format!("Tool \"{}\" needs user approval, but no one can approve in this mode. Tell the user to rerun with -y (or set tools.approval to \"auto\").", tool_name)}));
                    }
                    Ok(json!({"action": "ask", "reason": format!("{} has side effects", tool_name)}))
                }) as crate::kernel::types::BoxFuture<_>
            });
            Ok(())
        }
    })
}

pub fn create_builtin_tools_plugin(opts: BuiltinToolsOptions) -> PluginRef {
    builtin_tools_plugin(opts)
}

#[allow(dead_code)]
fn _execute(_: ExecuteFn) {}
