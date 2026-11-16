//! `leo models` / 交互命令 /models、/think、/effort 的公共部分。

use crate::llm::service::LlmService;
use crate::llm::types::{ModelInfo, ReasoningEffort, ReasoningOptions};

#[derive(Clone)]
pub struct ModelChoice {
    pub reference: String,
    pub provider: String,
    pub info: ModelInfo,
}

fn tokens(n: u64) -> String {
    if n >= 1024 * 1024 && n % (1024 * 1024) == 0 {
        format!("{}M", n / 1024 / 1024)
    } else if n >= 1024 && n % 1024 == 0 {
        format!("{}K", n / 1024)
    } else if n >= 1000 {
        format!("{}K", (n as f64 / 1000.0).round() as u64)
    } else {
        n.to_string()
    }
}

pub fn describe_model(m: &ModelInfo) -> String {
    let mut parts = Vec::new();
    if let Some(name) = &m.name {
        if name != &m.id {
            parts.push(name.clone());
        }
    }
    parts.push(format!("上下文 {}", tokens(m.context_window)));
    if let Some(max) = m.max_output_tokens {
        parts.push(format!("最大输出 {}", tokens(max)));
    }
    if let Some(modalities) = &m.input_modalities {
        if !modalities.is_empty() {
            parts.push(format!("输入 {}", modalities.join("+")));
        }
    }
    if let Some(r) = &m.reasoning {
        if r.supported {
            let efforts = r
                .efforts
                .as_ref()
                .map(|v| {
                    v.iter()
                        .map(|e| {
                            if Some(*e) == r.default_effort {
                                format!("{}*", e.as_str())
                            } else {
                                e.as_str().to_string()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_default();
            let suffix = if efforts.is_empty() {
                String::new()
            } else {
                format!("，强度 {}", efforts)
            };
            parts.push(format!(
                "思考（默认{}）{}",
                if r.default_enabled == Some(false) {
                    "关"
                } else {
                    "开"
                },
                suffix
            ));
        } else {
            parts.push("不支持思考".into());
        }
    }
    parts.join(" · ")
}

pub async fn collect_models(
    llm: &LlmService,
    refresh: bool,
    provider: Option<&str>,
) -> Result<Vec<crate::llm::types::ProviderModels>, crate::errors::LeoError> {
    llm.models(refresh, provider, None).await
}

pub fn parse_switch(v: Option<&str>) -> Option<bool> {
    let s = v?.to_lowercase();
    match s.as_str() {
        "on" | "true" | "1" | "yes" | "enabled" | "enable" | "开" | "开启" => Some(true),
        "off" | "false" | "0" | "no" | "disabled" | "disable" | "关" | "关闭" => Some(false),
        _ => None,
    }
}

pub fn parse_effort(v: Option<&str>) -> Option<ReasoningEffort> {
    ReasoningEffort::parse(v?)
}

pub fn with_thinking(r: &ReasoningOptions, enabled: bool) -> ReasoningOptions {
    if !enabled {
        return ReasoningOptions {
            enabled: Some(false),
            effort: None,
        };
    }
    match &r.effort {
        Some(e) if *e != ReasoningEffort::None => ReasoningOptions {
            enabled: Some(true),
            effort: Some(*e),
        },
        _ => ReasoningOptions {
            enabled: Some(true),
            effort: None,
        },
    }
}

pub fn with_effort(effort: ReasoningEffort) -> ReasoningOptions {
    if effort == ReasoningEffort::None {
        ReasoningOptions {
            enabled: Some(false),
            effort: None,
        }
    } else {
        ReasoningOptions {
            enabled: Some(true),
            effort: Some(effort),
        }
    }
}

pub fn describe_reasoning(r: Option<&ReasoningOptions>, info: Option<&ModelInfo>) -> String {
    if let Some(info) = info {
        if let Some(rinfo) = &info.reasoning {
            if !rinfo.supported {
                return "不支持思考".into();
            }
        }
    }
    if r.and_then(|x| x.enabled) == Some(false)
        || r.and_then(|x| x.effort) == Some(ReasoningEffort::None)
    {
        return "思考关".into();
    }
    let effort = r.and_then(|x| x.effort).or_else(|| {
        info.and_then(|i| i.reasoning.as_ref())
            .and_then(|x| x.default_effort)
    });
    let on = if r.and_then(|x| x.enabled) == Some(true) {
        "思考开"
    } else if info
        .and_then(|i| i.reasoning.as_ref())
        .and_then(|x| x.default_enabled)
        == Some(false)
    {
        "思考关（默认）"
    } else {
        "思考开（默认）"
    };
    match effort {
        Some(e) => format!(
            "{} · 强度 {}{}",
            on,
            e.as_str(),
            if r.and_then(|x| x.effort).is_some() {
                ""
            } else {
                "（默认）"
            }
        ),
        None => on.to_string(),
    }
}
