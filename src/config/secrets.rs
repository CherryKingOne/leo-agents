//! 密钥解析与本地凭据存储。

use crate::errors::{LeoError, LeoErrorCode, LeoResult};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

pub type CredentialMap = BTreeMap<String, String>;

/// 解析一个可能引用环境变量或命令的密钥值；解析结果为空返回 None。
pub fn resolve_secret(value: Option<&str>, env: &BTreeMap<String, String>) -> Option<String> {
    let v = value?.trim();
    if v.is_empty() {
        return None;
    }
    if let Some(rest) = v.strip_prefix("$$") {
        return Some(format!("${}", rest));
    }
    if let Some(rest) = v.strip_prefix("$!") {
        return Some(format!("!{}", rest));
    }
    if let Some(rest) = v.strip_prefix('!') {
        let cmd = rest.trim();
        if let Some(cached) = command_cache().lock().unwrap().get(cmd) {
            return Some(cached.clone());
        }
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        match output {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !text.is_empty() {
                    command_cache()
                        .lock()
                        .unwrap()
                        .insert(cmd.to_string(), text.clone());
                }
                if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            }
            _ => None,
        }
    } else {
        let re = regex::Regex::new(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$").unwrap();
        if let Some(caps) = re.captures(v) {
            let key = caps.get(1).unwrap().as_str();
            return env
                .get(key)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        Some(v.to_string())
    }
}

fn command_cache() -> &'static Mutex<BTreeMap<String, String>> {
    static CACHE: std::sync::OnceLock<Mutex<BTreeMap<String, String>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 掩码显示：sk-abc…wxyz
pub fn mask_secret(v: Option<&str>) -> String {
    let Some(v) = v else { return "(none)".into() };
    if v.chars().count() <= 8 {
        return "****".into();
    }
    let chars: Vec<char> = v.chars().collect();
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}…{}", head, tail)
}

pub fn read_credential_file(path: &Path) -> LeoResult<CredentialMap> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(LeoError::new(LeoErrorCode::Internal, e.to_string())),
    };
    let data: Value = serde_json::from_str(&text).map_err(|e| {
        LeoError::new(
            LeoErrorCode::PluginConfigInvalid,
            format!("Invalid credentials file {}: {}", path.display(), e),
        )
    })?;
    let obj = data.as_object().ok_or_else(|| {
        LeoError::new(
            LeoErrorCode::PluginConfigInvalid,
            format!(
                "Invalid credentials file {}: must be a JSON object",
                path.display()
            ),
        )
    })?;
    let mut out = BTreeMap::new();
    for (k, v) in obj {
        if let Some(s) = v.as_str() {
            out.insert(k.clone(), s.to_string());
        } else if let Some(s) = v.get("apiKey").and_then(|x| x.as_str()) {
            out.insert(k.clone(), s.to_string());
        }
    }
    Ok(out)
}

use serde_json::Value;

/// 写入/删除一个凭据（value 为 None 表示删除），文件权限 0600。
pub fn write_credential(path: &Path, provider_id: &str, value: Option<&str>) -> LeoResult<()> {
    let mut data = read_credential_file(path)?;
    match value {
        Some(v) => {
            data.insert(provider_id.to_string(), v.to_string());
        }
        None => {
            data.remove(provider_id);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
    }
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let text = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into()) + "\n";
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
    f.write_all(text.as_bytes())
        .map_err(|e| LeoError::new(LeoErrorCode::Internal, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSource {
    Override,
    Project,
    User,
    Config,
    Env,
}

impl CredentialSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Override => "override",
            Self::Project => "project",
            Self::User => "user",
            Self::Config => "config",
            Self::Env => "env",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CredentialLookup {
    pub id: String,
    pub configured: Option<String>,
    pub env_keys: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CredentialDescription {
    pub configured: bool,
    pub source: Option<CredentialSource>,
    pub masked: String,
}

pub struct DefaultCredentialService {
    overrides: Option<CredentialMap>,
    project: CredentialMap,
    user: CredentialMap,
    env: BTreeMap<String, String>,
}

impl DefaultCredentialService {
    pub fn new(
        overrides: Option<CredentialMap>,
        project: CredentialMap,
        user: CredentialMap,
        env: BTreeMap<String, String>,
    ) -> Self {
        Self {
            overrides,
            project,
            user,
            env,
        }
    }

    fn find(&self, lookup: &CredentialLookup) -> Option<(String, CredentialSource)> {
        if let Some(v) = self
            .overrides
            .as_ref()
            .and_then(|m| m.get(&lookup.id))
            .and_then(|raw| resolve_secret(Some(raw), &self.env))
            .filter(|s| !s.is_empty())
        {
            return Some((v, CredentialSource::Override));
        }
        if let Some(v) = self
            .project
            .get(&lookup.id)
            .and_then(|raw| resolve_secret(Some(raw), &self.env))
            .filter(|s| !s.is_empty())
        {
            return Some((v, CredentialSource::Project));
        }
        if let Some(v) = self
            .user
            .get(&lookup.id)
            .and_then(|raw| resolve_secret(Some(raw), &self.env))
            .filter(|s| !s.is_empty())
        {
            return Some((v, CredentialSource::User));
        }
        if let Some(v) = lookup
            .configured
            .as_deref()
            .and_then(|raw| resolve_secret(Some(raw), &self.env))
            .filter(|s| !s.is_empty())
        {
            return Some((v, CredentialSource::Config));
        }
        for key in &lookup.env_keys {
            if let Some(v) =
                resolve_secret(Some(&format!("${}", key)), &self.env).filter(|s| !s.is_empty())
            {
                return Some((v, CredentialSource::Env));
            }
        }
        None
    }

    pub fn get(&self, lookup: &CredentialLookup) -> Option<String> {
        self.find(lookup).map(|(v, _)| v)
    }

    pub fn describe(&self, lookup: &CredentialLookup) -> CredentialDescription {
        match self.find(lookup) {
            Some((v, source)) => CredentialDescription {
                configured: true,
                source: Some(source),
                masked: mask_secret(Some(&v)),
            },
            None => CredentialDescription {
                configured: false,
                source: None,
                masked: "(none)".into(),
            },
        }
    }
}

#[allow(dead_code)]
fn _timeout() -> Duration {
    Duration::from_secs(10)
}
