//! leo 命令行。

use leo_agents::cli::args::{parse_args, CliArgs, HELP};
use leo_agents::cli::models::{
    collect_models, describe_model, describe_reasoning, parse_effort, parse_switch, with_effort,
    with_thinking,
};
use leo_agents::cli::plugin::{
    add_plugin, init_plugin, load_registry, uninstall_plugin, AddOptions, DefaultIo,
    InitMode, PluginIo, UninstallScope, DEFAULT_PLUGIN_REGISTRY,
};
use leo_agents::cli::ui::{
    ask_secret, bold, cyan, gray, green, magenta, one_line, read_stdin, red, render_display, yellow,
};
use leo_agents::config::create::{
    create_Leo_from_config, CreateFromConfigOptions, LeoApp, PluginNotice,
};
use leo_agents::config::load::{load_config, LoadConfigOptions};
use leo_agents::config::secrets::{mask_secret, read_credential_file, write_credential};
use leo_agents::errors::{LeoError, LeoErrorCode};
use leo_agents::kernel::logger::Logger;
use leo_agents::llm::types::ReasoningOptions;
use leo_agents::protocol::messages::{text_of, UserInput};
use leo_agents::r#loop::{Agent, AgentEvent, AgentOptions, RunOptions, StopReason, TurnResult};
use leo_agents::tools::types::{
    ApprovalRequest, ApprovalResponse, ApprovalService, ApprovalServiceHandle,
};
use serde_json::Value;
use std::collections::HashSet;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio_util::sync::CancellationToken;

fn log(s: &str) {
    eprintln!("{}", s);
}

fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let code = run(argv).await;
    std::process::exit(code);
}

async fn run(argv: Vec<String>) -> i32 {
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            log(&red(&e));
            log("运行 leo --help 查看用法");
            return 2;
        }
    };
    if args.help || args.command.as_deref() == Some("help") {
        println!("{}", HELP);
        return 0;
    }
    if args.version || args.command.as_deref() == Some("version") {
        println!("{}", version());
        return 0;
    }
    let cwd = args.cwd.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| ".".into())
    });
    match args.command.as_deref() {
        Some("init") => cmd_init(&cwd).await,
        Some("auth") => cmd_auth(&cwd, &args).await,
        Some("models") => cmd_models(&cwd, &args).await,
        Some("doctor") => cmd_doctor(&cwd, &args).await,
        Some("plugin") | Some("plugins") => cmd_plugin(&cwd, &args).await,
        Some("serve") => cmd_serve(&cwd, &args).await,
        _ => cmd_run(&cwd, &args).await,
    }
}

const CONFIG_TEMPLATE: &str = r#"{
  // leo 项目配置。完整说明见 docs/development-guide.md「.leo 配置」一节
  // "model": "deepseek/deepseek-flash",
  "plugins": [],
  "tools": {
    "approval": "ask"
  },
  "agent": {
    "maxSteps": 50
  }
}
"#;

async fn cmd_init(cwd: &str) -> i32 {
    let dir = Path::new(cwd).join(".leo");
    let _ = std::fs::create_dir_all(dir.join("plugins"));
    let cfg = dir.join("config.json");
    let exists = cfg.exists();
    if !exists {
        let _ = std::fs::write(&cfg, CONFIG_TEMPLATE);
    }
    let gi = Path::new(cwd).join(".gitignore");
    let current = std::fs::read_to_string(&gi).unwrap_or_default();
    let need: Vec<&str> = [".leo/credentials.json", ".leo/sessions/"]
        .into_iter()
        .filter(|l| !current.lines().any(|x| x == *l))
        .collect();
    if !need.is_empty() {
        let mut text = current;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("# leo\n");
        text.push_str(&need.join("\n"));
        text.push('\n');
        let _ = std::fs::write(&gi, text);
    }
    log(&format!(
        "{} {}",
        if exists {
            yellow("已存在")
        } else {
            green("已创建")
        },
        cfg.display()
    ));
    if !need.is_empty() {
        log(&format!(
            "{} .gitignore（{}）",
            green("已更新"),
            need.join(", ")
        ));
    }
    log(&format!(
        "\n下一步：运行 {} 开始对话，或 {} 检查配置",
        bold("leo"),
        bold("leo doctor")
    ));
    0
}

async fn cmd_auth(cwd: &str, args: &CliArgs) -> i32 {
    let load_opts = LoadConfigOptions {
        cwd: Some(cwd.into()),
        ..Default::default()
    };
    let resolved = match load_config(&load_opts) {
        Ok(r) => r,
        Err(e) => {
            log(&red(&format!("✗ {}", e.message)));
            return 1;
        }
    };
    let sub = args.positionals.first().map(|s| s.as_str());
    let provider = args.positionals.get(1).cloned();
    let target = if args.project {
        resolved
            .paths
            .project_credentials
            .clone()
            .unwrap_or_else(|| {
                Path::new(cwd)
                    .join(".leo/credentials.json")
                    .display()
                    .to_string()
            })
    } else {
        resolved.paths.user_credentials.clone()
    };
    match sub {
        None | Some("list") => {
            for (label, file) in [
                ("项目", resolved.paths.project_credentials.clone()),
                ("用户", Some(resolved.paths.user_credentials.clone())),
            ] {
                let Some(file) = file else { continue };
                match read_credential_file(Path::new(&file)) {
                    Ok(creds) => {
                        log(&format!("{} {}", bold(label), gray(&file)));
                        if creds.is_empty() {
                            log(&gray("  (空)"));
                        }
                        for (id, v) in creds {
                            let shown = if v.starts_with('$') || v.starts_with('!') {
                                v
                            } else {
                                mask_secret(Some(&v))
                            };
                            log(&format!("  {:<14} {}", id, shown));
                        }
                    }
                    Err(e) => log(&red(&e.message)),
                }
            }
            0
        }
        Some("remove") | Some("rm") | Some("logout") => {
            let Some(provider) = provider else {
                log(&red("用法：leo auth remove <provider>"));
                return 2;
            };
            if let Err(e) = write_credential(Path::new(&target), &provider, None) {
                log(&red(&e.message));
                return 1;
            }
            log(&format!("{} {}（{}）", green("已删除"), provider, target));
            0
        }
        Some("set") | Some("login") => {
            let Some(provider) = provider else {
                log(&red("用法：leo auth set <provider> [key]"));
                return 2;
            };
            let key = match args.positionals.get(2) {
                Some(k) => k.clone(),
                None => {
                    if std::io::stdin().is_terminal() {
                        match ask_secret(&format!("{} API Key: ", provider)) {
                            Ok(k) => k.trim().to_string(),
                            Err(e) => {
                                log(&red(&e));
                                return 2;
                            }
                        }
                    } else {
                        read_stdin().trim().to_string()
                    }
                }
            };
            if key.is_empty() {
                log(&red("未输入密钥"));
                return 2;
            }
            if let Err(e) = write_credential(Path::new(&target), &provider, Some(&key)) {
                log(&red(&e.message));
                return 1;
            }
            log(&format!(
                "{} {} → {}（权限 600）",
                green("已保存"),
                provider,
                target
            ));
            0
        }
        Some(other) => {
            log(&red(&format!("未知子命令：{}", other)));
            2
        }
    }
}

fn no_provider_hint(app: &LeoApp) -> String {
    if app.leo.ctx.has("providers") {
        "还没有可用的模型：安装厂商子插件（如 leo plugin add provider-deepseek），或在 .leo/provider.json 里配置 OpenAI 兼容端点".into()
    } else {
        "没有模型供应商插件。运行 leo plugin add provider && leo plugin add provider-deepseek，再 leo auth set deepseek".into()
    }
}

async fn cmd_models(cwd: &str, args: &CliArgs) -> i32 {
    let app = match create_Leo_from_config(CreateFromConfigOptions {
        cwd: Some(cwd.into()),
        overrides: args
            .model
            .clone()
            .map(|m| serde_json::json!({ "model": m })),
        watch_plugins: false,
        ..Default::default()
    })
    .await
    {
        Ok(a) => a,
        Err(e) => {
            log(&red(&format!("✗ {}", e.message)));
            return 1;
        }
    };
    if app.providers().is_empty() {
        log(&yellow(&no_provider_hint(&app)));
    }
    let only = args.positionals.first().cloned();
    if let Some(only) = &only {
        if !app.providers().iter().any(|p| &p.id == only) {
            log(&red(&format!("没有提供方 \"{}\"", only)));
            return 1;
        }
    }
    let llm = app
        .leo
        .ctx
        .get::<leo_agents::llm::LlmService>("llm")
        .unwrap();
    match collect_models(&llm, !args.offline, only.as_deref()).await {
        Ok(groups) => {
            for g in groups {
                let p = app
                    .providers()
                    .into_iter()
                    .find(|p| p.id == g.provider.id());
                let Some(p) = p else { continue };
                log(&format!(
                    "{} {} {} {}",
                    if p.loaded { green("●") } else { gray("○") },
                    bold(&p.id),
                    gray(&p.name),
                    if p.loaded {
                        String::new()
                    } else {
                        yellow(&format!("{} ", p.reason.clone().unwrap_or_default()))
                    }
                ));
                if let Some(err) = g.error {
                    log(&yellow(&format!(
                        "    实时获取模型失败（{}），以下为插件内置列表",
                        err
                    )));
                }
                for m in &g.models {
                    let is_default = p.default_model.as_deref() == Some(m.id.as_str());
                    log(&format!(
                        "    {} {:<28} {}",
                        if is_default { green("*") } else { " ".into() },
                        format!("{}/{}", p.id, m.id),
                        gray(&describe_model(m))
                    ));
                }
            }
            log(&format!(
                "\n当前默认：{}{}",
                app.model()
                    .map(|m| bold(&m))
                    .unwrap_or_else(|| yellow("(无)")),
                gray("（* 为各提供方默认模型；切换：leo -m <provider/model>，或交互中 /model）")
            ));
        }
        Err(e) => log(&red(&e.message)),
    }
    let _ = app.dispose().await;
    0
}

async fn cmd_doctor(cwd: &str, args: &CliArgs) -> i32 {
    let app = match create_Leo_from_config(CreateFromConfigOptions {
        cwd: Some(cwd.into()),
        overrides: args
            .model
            .clone()
            .map(|m| serde_json::json!({ "model": m })),
        watch_plugins: false,
        ..Default::default()
    })
    .await
    {
        Ok(a) => a,
        Err(e) => {
            log(&red(&format!("✗ 配置加载失败：{}", e.message)));
            return 1;
        }
    };
    let paths = &app.resolved.paths;
    log(&bold("配置"));
    log(&format!(
        "  项目根      {}",
        paths
            .project_root
            .clone()
            .unwrap_or_else(|| gray("(未找到 .leo，使用当前目录；运行 leo init 创建)"))
    ));
    log(&format!("  用户目录    {}", paths.user_dir));
    log(&format!(
        "  已读取      {}",
        if app.resolved.loaded_files.is_empty() {
            gray("(无配置文件，使用默认值)")
        } else {
            app.resolved.loaded_files.join(", ")
        }
    ));
    log(&bold("提供方"));
    if app.providers().is_empty() {
        log(&format!("  {} — {}", yellow("无"), no_provider_hint(&app)));
    }
    for p in app.providers() {
        log(&format!(
            "  {} {:<12} {} {} {}",
            if p.loaded { green("✓") } else { red("✗") },
            p.id,
            p.base_url.clone().unwrap_or_default(),
            gray(&format!(
                "key={}{}{}",
                p.credential.masked,
                p.credential
                    .source
                    .map(|s| format!(" from {}", s.as_str()))
                    .unwrap_or_default(),
                p.via.map(|v| format!(" · {}", v)).unwrap_or_default()
            )),
            p.reason.map(|r| yellow(&r)).unwrap_or_default()
        ));
    }
    log(&format!(
        "  默认模型    {}",
        app.model().unwrap_or_else(|| yellow("(无)"))
    ));
    log(&bold("插件"));
    let plugins = app.loaded_plugins();
    if plugins.is_empty() {
        log(&gray("  (无第三方插件)"));
    }
    for p in plugins {
        log(&format!("  {} {}", p.0, gray(&format!("({})", p.2))));
    }
    log(&bold("工具"));
    let names: Vec<String> = app
        .leo
        .ctx
        .get::<leo_agents::tools::ToolRegistryHandle>("tools")
        .map(|t| t.list(None).iter().map(|x| x.name.clone()).collect())
        .unwrap_or_default();
    log(&format!(
        "  {}",
        if names.is_empty() {
            gray("(无)")
        } else {
            names.join(", ")
        }
    ));
    let _ = app.dispose().await;
    if app.model().is_some() {
        0
    } else {
        1
    }
}

async fn cmd_plugin(cwd: &str, args: &CliArgs) -> i32 {
    let sub = args
        .positionals
        .first()
        .cloned()
        .unwrap_or_else(|| "list".into());
    let name = args.positionals.get(1).cloned();
    let resolved = match load_config(&LoadConfigOptions {
        cwd: Some(cwd.into()),
        ..Default::default()
    }) {
        Ok(r) => r,
        Err(e) => {
            log(&red(&e.message));
            return 1;
        }
    };
    let registry = args
        .registry
        .clone()
        .or_else(|| std::env::var("LEO_PLUGIN_REGISTRY").ok())
        .unwrap_or_else(|| DEFAULT_PLUGIN_REGISTRY.into());
    let io = DefaultIo {
        log: |s: &str| log(s),
    };
    let project = args.project;
    let scope_dir = if project {
        resolved
            .paths
            .project_dir
            .clone()
            .unwrap_or_else(|| Path::new(cwd).join(".leo").display().to_string())
    } else {
        resolved.paths.user_dir.clone()
    };
    let project_root = if project {
        resolved.paths.project_root.clone()
    } else {
        None
    };
    match sub.as_str() {
        "add" | "install" | "i" => {
            let Some(name) = name else {
                log(&red("用法：leo plugin add <id> [--project] [--no-init | --init-from <path>] [--npm]"));
                return 2;
            };
            let init = if let Some(from) = &args.init_from {
                InitMode::From(from.clone())
            } else if args.no_init {
                InitMode::Skip
            } else {
                InitMode::Default
            };
            match add_plugin(
                &AddOptions {
                    name,
                    scope_dir,
                    project_root,
                    npm: args.npm,
                    registry,
                    leo_version: version(),
                    init,
                    force: args.force,
                },
                &io,
            )
            .await
            {
                Ok(()) => 0,
                Err(e) => {
                    log(&red(&format!("✗ {}", e)));
                    1
                }
            }
        }
        "init" => {
            let Some(name) = name else {
                log(&red("用法：leo plugin init <id>"));
                return 2;
            };
            let from = args.init_from.clone();
            match init_plugin(&name, &scope_dir, &registry, from, args.force, &io).await {
                Ok(files) => {
                    if files.is_empty() {
                        log(&gray("没有写入新文件"));
                    }
                    0
                }
                Err(e) => {
                    log(&red(&format!("✗ {}", e)));
                    1
                }
            }
        }
        "remove" | "rm" | "uninstall" => {
            let Some(name) = name else {
                log(&red(
                    "用法：leo plugin remove <id> [--project | --all] [--purge]",
                ));
                return 2;
            };
            let scope = if args.all {
                UninstallScope::All
            } else if project {
                UninstallScope::Project
            } else {
                UninstallScope::Global
            };
            match uninstall_plugin(
                &name,
                &registry,
                &resolved.paths.user_dir,
                resolved.paths.project_dir.as_deref(),
                scope,
                args.purge,
                &io,
            )
            .await
            {
                Ok(true) => 0,
                Ok(false) => 1,
                Err(e) => {
                    log(&red(&e));
                    1
                }
            }
        }
        "list" | "ls" => {
            log(&bold("已安装"));
            if resolved.plugins.is_empty() {
                log(&gray("  （无）"));
            }
            for p in &resolved.plugins {
                log(&format!(
                    "  {} {} {}",
                    cyan(&format!("[{}]", p.from)),
                    p.spec,
                    gray(&format!("({})", p.from))
                ));
            }
            match load_registry(&registry, &io) {
                Ok(reg) => {
                    log(&format!("\n{} {}", bold("插件仓库"), gray(&registry)));
                    for e in reg.plugins {
                        let mark = resolved.plugins.iter().any(|p| {
                            p.spec == e.package || p.spec.ends_with(&format!("{}.bundle.js", e.id))
                        });
                        log(&format!(
                            "  {} {} {}{}{}  {}",
                            bold(&e.id),
                            e.version,
                            if e.status == "stable" {
                                String::new()
                            } else {
                                yellow(&format!(" [{}]", e.status))
                            },
                            e.init
                                .as_ref()
                                .map(|i| gray(&format!(
                                    " [配置: {}]",
                                    i.files
                                        .iter()
                                        .map(|f| f.path.clone())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                )))
                                .unwrap_or_default(),
                            if mark {
                                green(" 已安装")
                            } else {
                                String::new()
                            },
                            gray(&e.description)
                        ));
                    }
                }
                Err(e) => log(&yellow(&format!("\n{}", e))),
            }
            0
        }
        other => {
            log(&red(&format!("未知子命令：{}", other)));
            2
        }
    }
}

async fn cmd_serve(cwd: &str, args: &CliArgs) -> i32 {
    let early: Arc<std::sync::Mutex<Vec<PluginNotice>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let early2 = early.clone();
    let app = match create_Leo_from_config(CreateFromConfigOptions {
        cwd: Some(cwd.into()),
        overrides: args
            .model
            .clone()
            .map(|m| serde_json::json!({ "model": m })),
        on_notice: Some(Arc::new(move |n| early2.lock().unwrap().push(n))),
        watch_plugins: true,
        ..Default::default()
    })
    .await
    {
        Ok(a) => a,
        Err(e) => {
            log(&red(&format!("✗ {}", e.message)));
            return 1;
        }
    };
    log(&gray(&format!(
        "leo {} · serve · {} · 审批 {}",
        version(),
        app.model().unwrap_or_else(|| "(无默认模型)".into()),
        app.resolved.config.tools.approval.as_str()
    )));
    log(&format!(
        "插件：{}",
        app.loaded_plugins()
            .iter()
            .map(|p| p.1.clone())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    for n in early.lock().unwrap().drain(..) {
        log(&format!("[{}] {}", n.plugin, n.message));
    }
    log(&gray("运行中，Ctrl+C 停止"));
    let _ = tokio::signal::ctrl_c().await;
    log(&gray("正在停止…"));
    let _ = app.dispose().await;
    0
}

struct CliApproval {
    always: tokio::sync::Mutex<HashSet<String>>,
    label_of: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
}

#[async_trait::async_trait]
impl ApprovalService for CliApproval {
    async fn request(
        &self,
        req: ApprovalRequest,
        _signal: CancellationToken,
    ) -> leo_agents::errors::LeoResult<ApprovalResponse> {
        {
            let always = self.always.lock().await;
            if always.contains(&req.payload.tool_name) {
                return Ok(ApprovalResponse {
                    approved: true,
                    reason: None,
                });
            }
        }
        let args = &req.payload.args;
        let args_text = args.to_string();
        let preview = args
            .get("command")
            .and_then(|v| v.as_str())
            .or_else(|| args.get("path").and_then(|v| v.as_str()))
            .unwrap_or(args_text.as_str());
        let label = (self.label_of)(&req.payload.agent_id);
        log(&format!(
            "\n{} {}{} {}",
            yellow("?"),
            label
                .map(|l| magenta(&format!("[{}] ", l)))
                .unwrap_or_default(),
            bold(&req.payload.tool_name),
            one_line(preview, 300)
        ));
        print!("  允许执行？{} ", gray("[y]是 / [n]否 / [a]本次会话都允许"));
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
        let _ = tokio::io::AsyncBufReadExt::read_line(&mut stdin, &mut line).await;
        let a = line.trim().to_lowercase();
        if a == "a" || a == "always" {
            self.always
                .lock()
                .await
                .insert(req.payload.tool_name.clone());
            return Ok(ApprovalResponse {
                approved: true,
                reason: None,
            });
        }
        if a == "y" || a == "yes" || a == "是" {
            Ok(ApprovalResponse {
                approved: true,
                reason: None,
            })
        } else {
            Ok(ApprovalResponse {
                approved: false,
                reason: Some("User declined".into()),
            })
        }
    }
}

struct RenderState {
    mid_line: bool,
    reasoning: bool,
}

fn render_event(ev: &AgentEvent, args: &CliArgs, state: &mut RenderState) {
    if args.json {
        println!("{}", serde_json::to_string(ev).unwrap_or_default());
        return;
    }
    match ev {
        AgentEvent::ReasoningDelta { text, .. } => {
            if args.reasoning {
                if !state.reasoning {
                    if state.mid_line {
                        println!();
                    }
                    state.mid_line = false;
                    eprint!("{}", gray("💭 "));
                }
                state.reasoning = true;
                eprint!("{}", gray(text));
            }
        }
        AgentEvent::TextDelta { text, .. } => {
            if state.reasoning {
                eprintln!("\n");
                state.reasoning = false;
            }
            print!("{}", text);
            let _ = std::io::stdout().flush();
            state.mid_line = !text.ends_with('\n');
        }
        AgentEvent::ToolStart { call } => {
            if state.reasoning {
                eprintln!();
                state.reasoning = false;
            }
            let args = match call {
                leo_agents::protocol::messages::ContentBlock::ToolCall {
                    name, arguments, ..
                } => {
                    let preview = arguments
                        .get("command")
                        .or_else(|| arguments.get("path"))
                        .or_else(|| arguments.get("url"))
                        .or_else(|| arguments.get("pattern"))
                        .map(|v| v.to_string())
                        .unwrap_or_default();
                    format!("{} {}", name, one_line(&preview, 300))
                }
                _ => String::new(),
            };
            log(&cyan(&format!("⚙ {}", args)));
        }
        AgentEvent::ToolUpdate { partial, .. } => {
            if partial.get("type").and_then(|t| t.as_str()) == Some("progress") {
                if let Some(message) = partial.get("message").and_then(|m| m.as_str()) {
                    log(&gray(&format!("  … {}", one_line(message, 200))));
                }
            }
        }
        AgentEvent::ToolResult { result, .. } => {
            let text = one_line(&text_of(&result.content), 200);
            log(&if result.is_error {
                red(&format!("  ✗ {}", text))
            } else {
                gray(&format!("  ✓ {}", text))
            });
            if let Some(display) = &result.display {
                if !args.json {
                    render_display(display, std::io::stdout().is_terminal());
                }
            }
        }
        AgentEvent::Retry {
            attempt,
            delay_ms,
            error,
            ..
        } => {
            log(&yellow(&format!(
                "↻ {}，{}s 后重试（第 {} 次）",
                error.message,
                (delay_ms / 1000).max(1),
                attempt
            )));
        }
        AgentEvent::Compaction { strategy, .. } => {
            log(&gray(&format!("（上下文已压缩：{}）", strategy)));
        }
        AgentEvent::TurnEnd {
            reason,
            usage,
            steps,
            error,
            ..
        } => {
            if state.reasoning {
                eprintln!();
                state.reasoning = false;
            }
            let cost = if usage.cost_usd > 0.0 {
                format!(" · ${:.4}", usage.cost_usd)
            } else {
                String::new()
            };
            if *reason != StopReason::Completed {
                log(&yellow(&format!(
                    "[{}]{}",
                    reason.as_str(),
                    error
                        .as_ref()
                        .map(|e| format!(" {}", e.message))
                        .unwrap_or_default()
                )));
            }
            log(&gray(&format!(
                "{} 步 · {}↑ {}↓{} tokens{}",
                steps,
                usage.input_tokens,
                usage.output_tokens,
                if usage.reasoning_tokens > 0 {
                    format!("（思考 {}）", usage.reasoning_tokens)
                } else {
                    String::new()
                },
                cost
            )));
        }
        _ => {}
    }
}

async fn run_turn(
    agent: &Arc<dyn Agent>,
    input: UserInput,
    args: &CliArgs,
    approval: Option<Arc<dyn ApprovalService>>,
    _app: &LeoApp,
) -> bool {
    let _ = approval;
    let state = RenderState {
        mid_line: false,
        reasoning: false,
    };
    let opts = RunOptions {
        max_steps: args.max_steps,
        ..Default::default()
    };
    let mut stream = match agent.prompt(input, opts) {
        Ok(s) => s,
        Err(e) => {
            log(&red(&format!("✗ {}", e.message)));
            return false;
        }
    };
    let mut ok = true;
    let ctrl = tokio::signal::ctrl_c();
    tokio::pin!(ctrl);
    loop {
        tokio::select! {
            _ = &mut ctrl => {
                log(&yellow("\n已取消"));
                agent.abort(Some("user interrupt".into()));
            }
            item = futures::StreamExt::next(&mut stream) => {
                match item {
                    Some(Ok(ev)) => {
                        if let AgentEvent::TurnEnd { reason: StopReason::Error, .. } = &ev {
                            ok = false;
                        }
                        render_event(&ev, args, &mut RenderState { mid_line: state.mid_line, reasoning: state.reasoning });
                    }
                    Some(Err(e)) => {
                        log(&red(&format!("✗ {}", e.message)));
                        ok = false;
                        break;
                    }
                    None => break,
                }
            }
        }
    }
    ok
}

async fn latest_session(dir: &str) -> Option<String> {
    let mut files: Vec<(String, std::time::SystemTime)> = Vec::new();
    let rd = std::fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            if let Ok(meta) = std::fs::metadata(&p) {
                if let Ok(modified) = meta.modified() {
                    files.push((p.display().to_string(), modified));
                }
            }
        }
    }
    files.sort_by_key(|(_, t)| *t);
    files.pop().map(|(p, _)| {
        Path::new(&p)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    })
}

async fn cmd_run(cwd: &str, args: &CliArgs) -> i32 {
    let mut prompt = args.positionals.join(" ").trim().to_string();
    if !std::io::stdin().is_terminal() {
        let piped = read_stdin();
        let piped = piped.trim();
        if !piped.is_empty() {
            prompt = if prompt.is_empty() {
                piped.to_string()
            } else {
                format!("{}\n\n<stdin>\n{}\n</stdin>", prompt, piped)
            };
        }
    }
    let interactive = !args.print
        && !args.json
        && std::io::stdin().is_terminal()
        && std::io::stderr().is_terminal();
    let mut overrides = serde_json::Map::new();
    if let Some(model) = &args.model {
        overrides.insert("model".into(), Value::String(model.clone()));
    }
    if args.yes {
        overrides.insert("tools".into(), serde_json::json!({ "approval": "auto" }));
    }
    if args.no_tools {
        overrides.insert("tools".into(), serde_json::json!({ "builtin": false }));
    }

    let approval: Option<Arc<dyn ApprovalService>> = if interactive {
        Some(Arc::new(CliApproval {
            always: tokio::sync::Mutex::new(HashSet::new()),
            label_of: Arc::new(|_| None),
        }))
    } else {
        None
    };
    let app = match create_Leo_from_config(CreateFromConfigOptions {
        cwd: Some(cwd.into()),
        overrides: if overrides.is_empty() {
            None
        } else {
            Some(Value::Object(overrides))
        },
        approval,
        watch_plugins: interactive,
        ..Default::default()
    })
    .await
    {
        Ok(a) => a,
        Err(e) => {
            log(&red(&format!("✗ {}", e.message)));
            return 1;
        }
    };

    if app.model().is_none() {
        log(&yellow("还没有可用的模型："));
        if app.providers().is_empty() {
            log(&format!(
                "  1) {}            安装模型供应商注册层",
                bold("leo plugin add provider")
            ));
            log(&format!(
                "  2) {}   安装 DeepSeek 子插件",
                bold("leo plugin add provider-deepseek")
            ));
            log(&format!(
                "  3) {}              保存密钥（或 export DEEPSEEK_API_KEY=sk-...）",
                bold("leo auth set deepseek")
            ));
        } else {
            for p in app.providers() {
                log(&format!(
                    "  {}: {}",
                    p.id,
                    p.reason.unwrap_or_else(|| "不可用".into())
                ));
            }
        }
        let _ = app.dispose().await;
        return 1;
    }

    let mut model = app.model().unwrap();
    let mut reasoning = app
        .resolved
        .config
        .agent
        .reasoning
        .clone()
        .unwrap_or_default();
    if let Some(thinking) = &args.thinking {
        match parse_switch(Some(thinking)) {
            Some(on) => reasoning = with_thinking(&reasoning, on),
            None => {
                log(&red(&format!(
                    "--thinking 只能是 on / off，收到 \"{}\"",
                    thinking
                )));
                let _ = app.dispose().await;
                return 2;
            }
        }
    }
    if let Some(effort) = &args.effort {
        match parse_effort(Some(effort)) {
            Some(e) => {
                reasoning = if args.thinking.as_deref().and_then(|s| parse_switch(Some(s)))
                    == Some(false)
                {
                    ReasoningOptions {
                        enabled: Some(false),
                        effort: None,
                    }
                } else {
                    with_effort(e)
                };
            }
            None => {
                log(&red(&format!(
                    "--effort 只能是 none / minimal / low / medium / high / xhigh / max，收到 \"{}\"",
                    effort
                )));
                let _ = app.dispose().await;
                return 2;
            }
        }
    }

    let mut session_id = args.session.clone();
    if session_id.is_none() && args.continue_session {
        let dir = app
            .resolved
            .config
            .sessions
            .dir
            .clone()
            .map(|d| {
                Path::new(
                    &app.resolved
                        .paths
                        .project_root
                        .clone()
                        .unwrap_or_else(|| cwd.into()),
                )
                .join(d)
                .display()
                .to_string()
            })
            .unwrap_or_else(|| {
                Path::new(
                    app.resolved
                        .paths
                        .project_dir
                        .as_deref()
                        .unwrap_or(&app.resolved.paths.user_dir),
                )
                .join("sessions")
                .display()
                .to_string()
            });
        session_id = latest_session(&dir).await;
        if session_id.is_none() {
            log(&gray("没有找到历史会话，开始新会话"));
        }
    }

    let new_agent =
        |sid: Option<String>, model: &str, reasoning: &ReasoningOptions| -> Arc<dyn Agent> {
            app.create_agent(AgentOptions {
                session_id: sid,
                model: model.to_string(),
                reasoning: Some(reasoning.clone()),
                ..AgentOptions::new(model.to_string())
            })
            .expect("agent")
        };
    let mut agent = new_agent(session_id, &model, &reasoning);
    let approval_mode = app.resolved.config.tools.approval.as_str();
    if !interactive {
        if prompt.is_empty() {
            log(&red(
                "非交互模式需要任务描述：leo -p \"任务\"，或通过管道输入",
            ));
            return 2;
        }
        if !args.json {
            log(&gray(&format!(
                "leo {} · {} · {} · 会话 {} · 审批 {}",
                version(),
                model,
                describe_reasoning(Some(&reasoning), None),
                agent.session_id(),
                approval_mode
            )));
        }
        return if run_turn(&agent, UserInput::text(prompt), args, None, &app).await {
            0
        } else {
            1
        };
    }

    log(&gray(&format!(
        "leo {} · {} · {} · 会话 {} · 审批 {}",
        version(),
        model,
        describe_reasoning(Some(&reasoning), None),
        agent.session_id(),
        approval_mode
    )));
    log(&gray(
        "输入任务开始；/help 查看命令，Ctrl+C 取消当前任务，Ctrl+D 退出\n",
    ));
    if !prompt.is_empty() {
        log(&format!("{} {}", bold("›"), prompt));
        let _ = run_turn(&agent, UserInput::text(prompt.clone()), args, None, &app).await;
    }

    let stdin = tokio::io::stdin();
    let mut lines = tokio::io::BufReader::new(stdin).lines();
    loop {
        print!("\n{} ", bold("›"));
        let _ = std::io::stdout().flush();
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            _ => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('/') {
            let mut parts = rest.split_whitespace();
            let cmd = parts.next().unwrap_or("");
            let rest: Vec<&str> = parts.collect();
            match cmd {
                "exit" | "quit" => break,
                "help" => {
                    println!("{}", HELP);
                }
                "new" => {
                    agent = new_agent(None, &model, &reasoning);
                    log(&gray(&format!("新会话 {}", agent.session_id())));
                }
                "models" => {
                    let llm = app
                        .leo
                        .ctx
                        .get::<leo_agents::llm::LlmService>("llm")
                        .unwrap();
                    if let Ok(groups) =
                        collect_models(&llm, rest.first() != Some(&"offline"), None).await
                    {
                        for g in groups {
                            for m in g.models {
                                log(&format!(
                                    "  {}/{}  {}",
                                    g.provider.id(),
                                    m.id,
                                    gray(&describe_model(&m))
                                ));
                            }
                        }
                    }
                }
                "model" => {
                    if rest.is_empty() {
                        log(&format!("当前模型：{}", model));
                    } else if let Some(target) = rest.first() {
                        model = target.to_string();
                        let sid = agent.session_id().to_string();
                        agent = new_agent(Some(sid), &model, &reasoning);
                        log(&gray(&format!("已切换到 {}", model)));
                    }
                }
                "think" | "thinking" => {
                    if rest.is_empty() {
                        log(&format!(
                            "当前：{}",
                            describe_reasoning(Some(&reasoning), None)
                        ));
                    } else if rest[0] == "show" || rest[0] == "hide" {
                        log(&gray(&format!("思考过程{}", rest[0])));
                    } else if let Some(on) = parse_switch(rest.first().copied()) {
                        reasoning = with_thinking(&reasoning, on);
                        let sid = agent.session_id().to_string();
                        agent = new_agent(Some(sid), &model, &reasoning);
                        log(&gray(&describe_reasoning(Some(&reasoning), None)));
                    }
                }
                "effort" => {
                    if rest.is_empty() {
                        log(&format!(
                            "当前：{}",
                            describe_reasoning(Some(&reasoning), None)
                        ));
                    } else if let Some(e) = parse_effort(rest.first().copied()) {
                        reasoning = with_effort(e);
                        let sid = agent.session_id().to_string();
                        agent = new_agent(Some(sid), &model, &reasoning);
                        log(&gray(&describe_reasoning(Some(&reasoning), None)));
                    }
                }
                "plugins" => {
                    if rest.first() == Some(&"reload") {
                        match app.reload_plugins().await {
                            Ok(r) => log(&gray(&format!(
                                "新增 {} · 更新 {} · 移除 {}{}",
                                r.added.len(),
                                r.changed.len(),
                                r.removed.len(),
                                if r.failed.is_empty() {
                                    String::new()
                                } else {
                                    format!(" · 失败 {}", r.failed.len())
                                }
                            ))),
                            Err(e) => log(&red(&e.message)),
                        }
                    }
                    for p in app.loaded_plugins() {
                        log(&format!("  {} {}", p.1, gray(&p.0)));
                    }
                }
                "session" => log(&format!("会话 {}", agent.session_id())),
                other => log(&yellow(&format!("未知命令 /{}，输入 /help", other))),
            }
            continue;
        }
        let _ = run_turn(&agent, UserInput::text(line.to_string()), args, None, &app).await;
    }
    log(&gray(&format!(
        "\n再见。继续这次会话：leo -c 或 leo -s {}",
        agent.session_id()
    )));
    let _ = app.dispose().await;
    0
}

#[allow(dead_code)]
fn _io(_: &dyn PluginIo) {}

#[allow(dead_code)]
fn _value(_: Value) {}

#[allow(dead_code)]
fn _logger(_: Logger) {}

#[allow(dead_code)]
fn _error(_: LeoError, _: LeoErrorCode) {}

#[allow(dead_code)]
fn _turn(_: TurnResult) {}

#[allow(dead_code)]
fn _path(_: PathBuf) {}

#[allow(dead_code)]
fn _approval_handle(_: ApprovalServiceHandle) {}
