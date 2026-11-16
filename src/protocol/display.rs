//! 展示块：给人看、不发给模型的内容（终端、聊天平台、Web 等前端各自渲染）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DisplayBlock {
    Text {
        text: String,
    },
    /// 终端字符画：每个元素一行，可含 ANSI 颜色转义；不支持颜色的终端显示 fallback
    Ansi {
        lines: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<String>,
    },
    /// 图片：http(s) / data URL，或本机文件路径（`file://` / 绝对路径）
    Image {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        alt: Option<String>,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
}

/// 宽松校验：插件运行时传进来的是普通 JSON 值。
pub fn is_display_blocks(v: &serde_json::Value) -> bool {
    let Some(arr) = v.as_array() else {
        return false;
    };
    arr.iter().all(|b| {
        let Some(obj) = b.as_object() else {
            return false;
        };
        match obj.get("type").and_then(|t| t.as_str()) {
            Some("text") => obj.get("text").and_then(|t| t.as_str()).is_some(),
            Some("ansi") => obj.get("lines").map(|l| l.is_array()).unwrap_or(false),
            Some("image") => obj.get("url").and_then(|u| u.as_str()).is_some(),
            _ => false,
        }
    })
}
