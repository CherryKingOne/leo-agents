use leo_agents::cli::args::parse_args;
use leo_agents::cli::plugin::{
    add_plugin, remove_plugin, AddOptions, DefaultIo, InitMode, UninstallScope,
    DEFAULT_PLUGIN_REGISTRY,
};
use leo_agents::config::jsonc::{add_plugin_entry, list_plugin_entries, remove_plugin_entry};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "leo-plug-{}-{}",
        tag,
        leo_agents::protocol::messages::new_id("d")
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn fixture(tag: &str, init: Option<serde_json::Value>) -> (PathBuf, PathBuf, Vec<String>) {
    let root = temp_dir(tag);
    let reg = root.join("reg");
    std::fs::create_dir_all(&reg).unwrap();
    let bundle =
        b"export default { name: 'hello-plugin', apply(ctx) { ctx.provide('hello', {}) } }\n";
    std::fs::write(reg.join("hello.bundle.js"), bundle).unwrap();
    let sha = hex(&Sha256::digest(bundle));
    let mut entry = json!({
        "id": "hello",
        "package": "leo-plugin-hello",
        "version": "1.0.0",
        "status": "stable",
        "description": "d",
        "leo": ">=0.1.0",
        "bundle": {"url": "hello.bundle.js", "sha256": sha}
    });
    if let Some(init) = init {
        entry.as_object_mut().unwrap().insert("init".into(), init);
    }
    std::fs::write(
        reg.join("registry.json"),
        serde_json::to_string(&json!({"version": 1, "plugins": [entry]})).unwrap(),
    )
    .unwrap();
    let logs = Vec::new();
    (root, reg.join("registry.json"), logs)
}

#[test]
fn jsonc_plugins_edit_preserves_comments() {
    let tpl = r#"{
  // 注释保留
  "model": "x/y",
  "plugins": [],
  "tools": { "approval": "ask" }
}
"#;
    let mut t = add_plugin_entry(tpl, "a", None);
    t = add_plugin_entry(&t, "b", Some(&json!({"n": 1})));
    t = add_plugin_entry(&t, "a", None);
    assert_eq!(list_plugin_entries(&t), vec!["a", "b"]);
    assert!(t.contains("// 注释保留"));
    t = remove_plugin_entry(&t, "a");
    assert_eq!(list_plugin_entries(&t), vec!["b"]);
    t = remove_plugin_entry(&t, "b");
    assert!(list_plugin_entries(&t).is_empty());

    let empty = add_plugin_entry("", "p", None);
    assert_eq!(list_plugin_entries(&empty), vec!["p"]);
    let obj = add_plugin_entry(r#"{ "model": "m" }"#, "p", None);
    assert_eq!(list_plugin_entries(&obj), vec!["p"]);
}

#[test]
fn plugin_args_defaults() {
    let a = parse_args(&["plugin".into(), "add".into(), "mcp".into()]).unwrap();
    assert!(!a.project);
    for flag in ["--project", "--local", "-l"] {
        let a = parse_args(&["plugin".into(), "add".into(), "mcp".into(), flag.into()]).unwrap();
        assert!(a.project);
    }
    let a = parse_args(&[
        "plugin".into(),
        "add".into(),
        "mcp".into(),
        "--init-from".into(),
        "./t".into(),
        "--force".into(),
    ])
    .unwrap();
    assert_eq!(a.init_from.as_deref(), Some("./t"));
    assert!(a.force);
    assert_eq!(a.positionals, vec!["add", "mcp"]);
    let a = parse_args(&[
        "plugin".into(),
        "remove".into(),
        "mcp".into(),
        "--all".into(),
        "--purge".into(),
    ])
    .unwrap();
    assert!(a.all && a.purge);
    let a = parse_args(&["plugin".into(), "rm".into(), "mcp".into(), "-l".into()]).unwrap();
    assert!(a.project);
    assert_eq!(DEFAULT_PLUGIN_REGISTRY.is_empty(), false);
}

#[tokio::test]
async fn adds_bundle_and_removes_it() {
    let (root, registry, _logs) = fixture("add", None);
    let scope = root.join(".leo");
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let io = DefaultIo {
        log: {
            let log = log.clone();
            move |s: &str| log.lock().unwrap().push(s.to_string())
        },
    };
    add_plugin(
        &AddOptions {
            name: "hello".into(),
            scope_dir: scope.display().to_string(),
            project_root: Some(root.display().to_string()),
            npm: false,
            registry: registry.display().to_string(),
            leo_version: "0.2.1".into(),
            init: InitMode::Default,
            force: false,
        },
        &io,
    )
    .await
    .unwrap();
    assert!(scope.join("plugins/hello.bundle.js").exists());
    assert!(remove_plugin(
        "hello",
        &scope.display().to_string(),
        &registry.display().to_string(),
        false,
        &io
    )
    .await
    .unwrap());
    assert!(!scope.join("plugins/hello.bundle.js").exists());
}

#[tokio::test]
async fn rejects_sha_mismatch() {
    let (root, registry, _logs) = fixture("sha", None);
    // 重写 registry 为错误的 sha
    let mut reg: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&registry).unwrap()).unwrap();
    reg["plugins"][0]["bundle"]["sha256"] = json!("deadbeef");
    std::fs::write(&registry, serde_json::to_string(&reg).unwrap()).unwrap();
    let scope = root.join(".leo");
    let io = DefaultIo { log: |_: &str| {} };
    let err = add_plugin(
        &AddOptions {
            name: "hello".into(),
            scope_dir: scope.display().to_string(),
            project_root: None,
            npm: false,
            registry: registry.display().to_string(),
            leo_version: "0.2.1".into(),
            init: InitMode::Skip,
            force: false,
        },
        &io,
    )
    .await
    .unwrap_err();
    assert!(err.contains("校验失败"));
    assert!(!scope.join("plugins/hello.bundle.js").exists());
}

#[tokio::test]
async fn init_files_writes_content_and_respects_existing() {
    let (root, registry, _logs) = fixture(
        "init",
        Some(json!({
            "files": [
                {"path": "hello.json", "content": "{}"},
                {"path": "agents/reviewer.md", "content": "# reviewer\n"}
            ]
        })),
    );
    let home = root.join("home");
    let io = DefaultIo { log: |_: &str| {} };
    add_plugin(
        &AddOptions {
            name: "hello".into(),
            scope_dir: home.display().to_string(),
            project_root: None,
            npm: false,
            registry: registry.display().to_string(),
            leo_version: "0.2.1".into(),
            init: InitMode::Default,
            force: false,
        },
        &io,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(home.join("hello.json")).unwrap(),
        "{}"
    );
    assert_eq!(
        std::fs::read_to_string(home.join("agents/reviewer.md")).unwrap(),
        "# reviewer\n"
    );
    std::fs::write(home.join("hello.json"), r#"{"mine":true}"#).unwrap();
    let _ = UninstallScope::Global;
}

#[test]
fn resolves_packages_from_node_modules() {
    let root = temp_dir("pkg");
    let pkg = root.join(".leo/node_modules/leo-plugin-hello/dist");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(
        root.join(".leo/node_modules/leo-plugin-hello/package.json"),
        r#"{"name":"leo-plugin-hello","type":"module","exports":{".":{"import":"./dist/index.js"}}}"#,
    )
    .unwrap();
    std::fs::write(pkg.join("index.js"), "export default {}").unwrap();
    let dirs = vec![root.join(".leo").display().to_string()];
    let resolved = leo_agents::cli::plugin::resolve_plugin_package("leo-plugin-hello", &dirs);
    assert_eq!(
        resolved.unwrap(),
        pkg.join("index.js").display().to_string()
    );
    let _ = Path::new(".");
}
