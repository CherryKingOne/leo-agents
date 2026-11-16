//! 极简结构化日志接口。生产环境可通过 `create_Leo({ logger })` 换成 pino 等实现。

use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Silent,
}

impl LogLevel {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "debug" => Self::Debug,
            "info" => Self::Info,
            "warn" => Self::Warn,
            "error" => Self::Error,
            "silent" => Self::Silent,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Silent => "silent",
        }
    }
}

#[derive(Clone)]
pub struct Logger {
    inner: Arc<LoggerInner>,
}

struct LoggerInner {
    level: LogLevel,
    bindings: Value,
}

impl std::fmt::Debug for Logger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Logger")
            .field("level", &self.inner.level)
            .finish()
    }
}

impl Logger {
    pub fn new(level: LogLevel, bindings: Value) -> Self {
        Self {
            inner: Arc::new(LoggerInner { level, bindings }),
        }
    }

    pub fn silent() -> Self {
        Self::new(LogLevel::Silent, Value::Object(Default::default()))
    }

    pub fn child(&self, bindings: Value) -> Self {
        let merged = merge_objects(&self.inner.bindings, &bindings);
        Self::new(self.inner.level, merged)
    }

    pub fn level(&self) -> LogLevel {
        self.inner.level
    }

    pub fn log(&self, level: LogLevel, payload: Value) {
        if self.inner.level == LogLevel::Silent || level < self.inner.level {
            return;
        }
        let mut map = match payload {
            Value::Object(m) => m,
            other => {
                let mut m = serde_json::Map::new();
                m.insert("msg".into(), other);
                m
            }
        };
        let mut full = serde_json::Map::new();
        full.insert("level".into(), level.as_str().into());
        full.insert("time".into(), chrono_like_now().into());
        if let Value::Object(b) = &self.inner.bindings {
            for (k, v) in b {
                full.insert(k.clone(), v.clone());
            }
        }
        for (k, v) in std::mem::take(&mut map) {
            full.insert(k, v);
        }
        eprintln!("{}", Value::Object(full));
    }

    pub fn debug(&self, msg: impl Into<String>) {
        self.log(LogLevel::Debug, msg.into().into());
    }

    pub fn info(&self, msg: impl Into<String>) {
        self.log(LogLevel::Info, msg.into().into());
    }

    pub fn warn(&self, msg: impl Into<String>) {
        self.log(LogLevel::Warn, msg.into().into());
    }

    pub fn error(&self, msg: impl Into<String>) {
        self.log(LogLevel::Error, msg.into().into());
    }

    pub fn debug_fields(&self, fields: Value) {
        self.log(LogLevel::Debug, fields);
    }

    pub fn info_fields(&self, fields: Value) {
        self.log(LogLevel::Info, fields);
    }

    pub fn warn_fields(&self, fields: Value) {
        self.log(LogLevel::Warn, fields);
    }

    pub fn error_fields(&self, fields: Value) {
        self.log(LogLevel::Error, fields);
    }

    /// 记录一个错误（`err` 字段）。
    pub fn error_err(&self, err: &dyn std::error::Error, msg: impl Into<String>) {
        self.log(
            LogLevel::Error,
            serde_json::json!({ "err": err.to_string(), "msg": msg.into() }),
        );
    }
}

fn merge_objects(base: &Value, extra: &Value) -> Value {
    let mut map = match base {
        Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };
    if let Value::Object(m) = extra {
        for (k, v) in m {
            map.insert(k.clone(), v.clone());
        }
    }
    Value::Object(map)
}

fn chrono_like_now() -> String {
    // 不引入 chrono：用 RFC3339 风格的 UTC 时间（秒级）。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 默认日志：输出单行 JSON 到 stderr。
pub fn create_console_logger(level: LogLevel) -> Logger {
    Logger::new(level, Value::Object(Default::default()))
}

#[allow(dead_code)]
fn _assert_serialize<T: Serialize>() {}
