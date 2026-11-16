use leo_agents::config::{
    create_Leo_from_config, load_config, resolve_secret, CreateFromConfigOptions, CredentialLookup,
    DefaultCredentialService, LoadConfigOptions,
};
use leo_agents::llm::{provider_plugin, MockProvider, MockResponse, MockStep, MockToolCall};
use leo_agents::protocol::messages::UserInput;
use leo_agents::r#loop::{AgentOptions, RunOptions};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "leo-test-{}-{}",
        tag,
        leo_agents::protocol::messages::new_id("d")
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn resolves_env_command_and_escapes() {
    let mut env = BTreeMap::new();
    env.insert("FOO".to_string(), "bar".to_string());
    assert_eq!(resolve_secret(Some("$FOO"), &env).as_deref(), Some("bar"));
    assert_eq!(resolve_secret(Some("${FOO}"), &env).as_deref(), Some("bar"));
    assert_eq!(resolve_secret(Some("$MISSING"), &env), None);
    assert_eq!(
        resolve_secret(Some("!echo hi"), &env).as_deref(),
        Some("hi")
    );
    assert_eq!(resolve_secret(Some("$$lit"), &env).as_deref(), Some("$lit"));
    assert_eq!(
        resolve_secret(Some("sk-plain"), &env).as_deref(),
        Some("sk-plain")
    );
}

#[test]
fn credential_priority_is_override_project_user_config_env() {
    let mut project = BTreeMap::new();
    project.insert("a".to_string(), "P".to_string());
    let mut user = BTreeMap::new();
    user.insert("a".to_string(), "U".to_string());
    user.insert("b".to_string(), "U".to_string());
    let mut env = BTreeMap::new();
    env.insert("B_KEY".to_string(), "E".to_string());
    env.insert("C_KEY".to_string(), "E".to_string());
    let svc = DefaultCredentialService::new(None, project, user, env);
    assert_eq!(
        svc.get(&CredentialLookup {
            id: "a".into(),
            configured: None,
            env_keys: vec![]
        })
        .as_deref(),
        Some("P")
    );
    assert_eq!(
        svc.get(&CredentialLookup {
            id: "b".into(),
            configured: None,
            env_keys: vec!["B_KEY".into()]
        })
        .as_deref(),
        Some("U")
    );
    assert_eq!(
        svc.get(&CredentialLookup {
            id: "c".into(),
            configured: Some("$C_KEY".into()),
            env_keys: vec!["NOPE".into()]
        })
        .as_deref(),
        Some("E")
    );
}

#[tokio::test]
async fn merges_user_and_project_config_and_resolves_plugin_paths() {
    let root = temp_dir("load");
    let home = temp_dir("home");
    std::fs::create_dir_all(root.join(".leo")).unwrap();
    std::fs::write(
        root.join(".leo/config.json"),
        r#"{
  "model": "x/y",
  "plugins": ["./p.mjs"],
  "tools": { "approval": "auto" }
}"#,
    )
    .unwrap();
    std::fs::write(
        home.join("config.json"),
        r#"{"model":"u/v","agent":{"maxSteps":7},"plugins":["user-plugin"]}"#,
    )
    .unwrap();
    let r = load_config(&LoadConfigOptions {
        cwd: Some(root.display().to_string()),
        user_dir: Some(home.display().to_string()),
        env: Some(BTreeMap::new()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(r.config.model.as_deref(), Some("x/y"));
    assert_eq!(r.config.agent.max_steps, Some(7));
    assert_eq!(
        r.config.tools.approval,
        leo_agents::config::ApprovalMode::Auto
    );
    let specs: Vec<&str> = r.plugins.iter().map(|p| p.spec.as_str()).collect();
    assert_eq!(
        specs,
        vec![
            "user-plugin",
            root.join("p.mjs").display().to_string().as_str()
        ]
    );
    assert_eq!(
        r.paths.project_root.as_deref(),
        Some(root.display().to_string().as_str())
    );
}

#[tokio::test]
async fn runs_agent_against_configured_native_provider_with_builtin_tools() {
    let root = temp_dir("run");
    let home = temp_dir("home-run");
    std::fs::create_dir_all(root.join(".leo")).unwrap();
    std::fs::write(
        root.join(".leo/config.json"),
        r#"{"model":"mock/m","tools":{"approval":"auto"},"sessions":{"persist":false}}"#,
    )
    .unwrap();
    let mock = Arc::new(MockProvider::new(
        "mock",
        vec![
            MockStep::Response(MockResponse {
                tool_calls: vec![MockToolCall {
                    id: Some("c1".into()),
                    name: "write_file".into(),
                    arguments: json!({"path":"out.txt","content":"ok"}),
                }],
                ..Default::default()
            }),
            MockStep::Response(MockResponse {
                text: Some("Wrote 2 bytes".into()),
                ..Default::default()
            }),
        ],
        vec![leo_agents::llm::ModelInfo {
            id: "m".into(),
            context_window: 32_000,
            ..Default::default()
        }],
    ));
    let app = create_Leo_from_config(CreateFromConfigOptions {
        cwd: Some(root.display().to_string()),
        user_dir: Some(home.display().to_string()),
        env: Some(BTreeMap::new()),
        plugins: vec![provider_plugin(mock, true)],
        watch_plugins: false,
        ..Default::default()
    })
    .await
    .unwrap();
    assert_eq!(app.model().as_deref(), Some("mock/m"));
    let agent = app.create_agent(AgentOptions::new("mock/m")).unwrap();
    let result = agent
        .run(UserInput::text("write it"), RunOptions::default())
        .await
        .unwrap();
    assert_eq!(result.reason, leo_agents::r#loop::StopReason::Completed);
    assert_eq!(std::fs::read_to_string(root.join("out.txt")).unwrap(), "ok");
    assert!(result.text.contains("Wrote 2 bytes"));
    app.dispose().await.unwrap();
}

#[tokio::test]
async fn denies_side_effect_tools_when_approval_ask_and_nobody_approves() {
    let root = temp_dir("deny");
    let home = temp_dir("home-deny");
    std::fs::create_dir_all(root.join(".leo")).unwrap();
    std::fs::write(
        root.join(".leo/config.json"),
        r#"{"model":"mock/m","sessions":{"persist":false}}"#,
    )
    .unwrap();
    let mock = Arc::new(MockProvider::new(
        "mock",
        vec![
            MockStep::Response(MockResponse {
                tool_calls: vec![MockToolCall {
                    id: Some("c1".into()),
                    name: "write_file".into(),
                    arguments: json!({"path":"out.txt","content":"ok"}),
                }],
                ..Default::default()
            }),
            MockStep::Response(MockResponse {
                text: Some("done".into()),
                ..Default::default()
            }),
        ],
        vec![leo_agents::llm::ModelInfo {
            id: "m".into(),
            context_window: 32_000,
            ..Default::default()
        }],
    ));
    let app = create_Leo_from_config(CreateFromConfigOptions {
        cwd: Some(root.display().to_string()),
        user_dir: Some(home.display().to_string()),
        env: Some(BTreeMap::new()),
        plugins: vec![provider_plugin(mock, true)],
        watch_plugins: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let agent = app.create_agent(AgentOptions::new("mock/m")).unwrap();
    let r = agent
        .run(UserInput::text("write it"), RunOptions::default())
        .await
        .unwrap();
    let tool = r.messages.iter().find(|m| m.role == "tool").unwrap();
    assert_eq!(tool.is_error, Some(true));
    let text = leo_agents::protocol::messages::text_of(&tool.content);
    assert!(text.contains("-y"));
    assert!(!root.join("out.txt").exists());
    app.dispose().await.unwrap();
}

#[tokio::test]
async fn exposes_merged_config_to_plugins() {
    let root = temp_dir("cfg");
    let home = temp_dir("home-cfg");
    std::fs::create_dir_all(root.join(".leo")).unwrap();
    std::fs::write(
        root.join(".leo/config.json"),
        r#"{"model":"x/y","providers":{"deepseek":{"baseURL":"https://example.invalid/v1","models":["m"]}}}"#,
    )
    .unwrap();
    let app = create_Leo_from_config(CreateFromConfigOptions {
        cwd: Some(root.display().to_string()),
        user_dir: Some(home.display().to_string()),
        env: Some(BTreeMap::new()),
        watch_plugins: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let cfg = app
        .leo
        .ctx
        .get::<leo_agents::config::LeoConfig>("leoConfig")
        .unwrap();
    assert_eq!(cfg.model.as_deref(), Some("x/y"));
    assert_eq!(
        cfg.providers
            .get("deepseek")
            .unwrap()
            .get("baseURL")
            .unwrap()
            .as_str(),
        Some("https://example.invalid/v1")
    );
    assert_eq!(app.model().as_deref(), Some("x/y"));
    app.dispose().await.unwrap();
}
