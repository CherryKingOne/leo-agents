//! 零依赖参数解析。

#[derive(Debug, Clone)]
pub struct CliArgs {
    pub command: Option<String>,
    pub positionals: Vec<String>,
    pub model: Option<String>,
    pub print: bool,
    pub yes: bool,
    pub continue_session: bool,
    pub session: Option<String>,
    pub cwd: Option<String>,
    pub api_key: Option<String>,
    pub provider: Option<String>,
    pub json: bool,
    pub no_tools: bool,
    pub project: bool,
    pub reasoning: bool,
    pub thinking: Option<String>,
    pub effort: Option<String>,
    pub offline: bool,
    pub help: bool,
    pub version: bool,
    pub max_steps: Option<u32>,
    pub global: bool,
    pub npm: bool,
    pub registry: Option<String>,
    pub no_init: bool,
    pub init_from: Option<String>,
    pub force: bool,
    pub all: bool,
    pub purge: bool,
}

impl Default for CliArgs {
    fn default() -> Self {
        Self {
            command: None,
            positionals: Vec::new(),
            model: None,
            print: false,
            yes: false,
            continue_session: false,
            session: None,
            cwd: None,
            api_key: None,
            provider: None,
            json: false,
            no_tools: false,
            project: false,
            reasoning: true,
            thinking: None,
            effort: None,
            offline: false,
            help: false,
            version: false,
            max_steps: None,
            global: false,
            npm: false,
            registry: None,
            no_init: false,
            init_from: None,
            force: false,
            all: false,
            purge: false,
        }
    }
}

const COMMANDS: &[&str] = &[
    "run", "chat", "init", "auth", "models", "doctor", "plugin", "plugins", "serve", "help",
    "version",
];

pub fn parse_args(argv: &[String]) -> Result<CliArgs, String> {
    let mut a = CliArgs::default();
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let t = argv[i].clone();
        let mut val = || -> Result<String, String> {
            i += 1;
            argv.get(i)
                .cloned()
                .ok_or_else(|| format!("Missing value for {}", t))
        };
        match t.as_str() {
            "-m" | "--model" => a.model = Some(val()?),
            "-p" | "--print" => a.print = true,
            "-y" | "--yes" => a.yes = true,
            "-c" | "--continue" => a.continue_session = true,
            "-s" | "--session" => a.session = Some(val()?),
            "--cwd" => a.cwd = Some(val()?),
            "--api-key" => a.api_key = Some(val()?),
            "--provider" => a.provider = Some(val()?),
            "--json" => a.json = true,
            "--no-tools" => a.no_tools = true,
            "--project" | "--local" | "-l" => a.project = true,
            "--reasoning" | "--show-thinking" => a.reasoning = true,
            "--no-reasoning" | "--hide-thinking" => a.reasoning = false,
            "--thinking" | "--think" => a.thinking = Some(val()?),
            "--no-thinking" => a.thinking = Some("off".into()),
            "--effort" | "--reasoning-effort" => a.effort = Some(val()?),
            "--offline" => a.offline = true,
            "--max-steps" => {
                a.max_steps = Some(
                    val()?
                        .parse()
                        .map_err(|_| "Invalid --max-steps".to_string())?,
                )
            }
            "-g" | "--global" => a.global = true,
            "--npm" => a.npm = true,
            "--registry" => a.registry = Some(val()?),
            "--init" => {}
            "--no-init" => a.no_init = true,
            "--init-from" => a.init_from = Some(val()?),
            "--force" => a.force = true,
            "--all" => a.all = true,
            "--purge" => a.purge = true,
            "-h" | "--help" => a.help = true,
            "-v" | "--version" => a.version = true,
            "--" => {
                rest.extend(argv[i + 1..].iter().cloned());
                i = argv.len();
            }
            _ => {
                if t.starts_with('-') && t.len() > 1 {
                    return Err(format!("Unknown option: {}", t));
                }
                rest.push(t);
            }
        }
        i += 1;
    }
    if let Some(first) = rest.first() {
        if COMMANDS.contains(&first.as_str()) {
            a.command = Some(rest.remove(0));
        }
    }
    a.positionals = rest;
    Ok(a)
}

pub const HELP: &str = include_str!("help.txt");
