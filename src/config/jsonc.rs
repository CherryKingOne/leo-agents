//! 最小的 JSONC 编辑：只改 `.leo/config.json` 顶层的 `plugins` 数组，保留其余文本（注释、格式）不动。

use serde_json::Value;

#[derive(Debug, Clone)]
struct Element {
    start: usize,
    end: usize,
    spec: Option<String>,
}

#[derive(Debug, Clone)]
struct PluginsArray {
    open: usize,
    close: usize,
    elements: Vec<Element>,
}

fn skip(text: &str, mut i: usize) -> usize {
    let b = text.as_bytes();
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
        } else if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'/' {
            i += 2;
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
        } else {
            break;
        }
    }
    i
}

fn read_string(text: &str, i: usize) -> Option<(usize, String)> {
    let b = text.as_bytes();
    let mut j = i + 1;
    while j < b.len() {
        if b[j] == b'\\' {
            j += 2;
        } else if b[j] == b'"' {
            let raw = &text[i..j + 1];
            let value = serde_json::from_str::<String>(raw).ok()?;
            return Some((j + 1, value));
        } else {
            j += 1;
        }
    }
    None
}

fn skip_value(text: &str, i: usize) -> usize {
    let b = text.as_bytes();
    if i >= b.len() {
        return i;
    }
    match b[i] {
        b'"' => read_string(text, i).map(|(e, _)| e).unwrap_or(i + 1),
        b'{' | b'[' => {
            let close = if b[i] == b'{' { b'}' } else { b']' };
            let mut j = skip(text, i + 1);
            while j < b.len() && b[j] != close {
                if b[i] == b'{' {
                    let Some((after_key, _)) = read_string(text, j) else {
                        break;
                    };
                    j = skip(text, after_key);
                    if j < b.len() && b[j] == b':' {
                        j = skip(text, j + 1);
                    }
                }
                j = skip(text, skip_value(text, j));
                if j < b.len() && b[j] == b',' {
                    j = skip(text, j + 1);
                }
            }
            (j + 1).min(b.len())
        }
        _ => {
            let mut j = i;
            while j < b.len()
                && !matches!(
                    b[j],
                    b' ' | b'\t' | b'\n' | b'\r' | b',' | b']' | b'}' | b'/'
                )
            {
                j += 1;
            }
            j
        }
    }
}

fn find_plugins(text: &str) -> Option<PluginsArray> {
    let b = text.as_bytes();
    let mut i = skip(text, 0);
    if i >= b.len() || b[i] != b'{' {
        return None;
    }
    i = skip(text, i + 1);
    while i < b.len() && b[i] != b'}' {
        let (after_key, key) = read_string(text, i)?;
        i = skip(text, after_key);
        if i < b.len() && b[i] == b':' {
            i = skip(text, i + 1);
        }
        if key == "plugins" {
            if i >= b.len() || b[i] != b'[' {
                return None;
            }
            let open = i;
            let mut elements = Vec::new();
            i = skip(text, i + 1);
            while i < b.len() && b[i] != b']' {
                let start = i;
                let mut spec = None;
                if b[i] == b'"' {
                    if let Some((_, s)) = read_string(text, i) {
                        spec = Some(s);
                    }
                } else if b[i] == b'[' {
                    let k = skip(text, i + 1);
                    if k < b.len() && b[k] == b'"' {
                        if let Some((_, s)) = read_string(text, k) {
                            spec = Some(s);
                        }
                    }
                }
                let end = skip_value(text, i);
                elements.push(Element { start, end, spec });
                i = skip(text, end);
                if i < b.len() && b[i] == b',' {
                    i = skip(text, i + 1);
                }
            }
            return Some(PluginsArray {
                open,
                close: i,
                elements,
            });
        }
        i = skip(text, skip_value(text, i));
        if i < b.len() && b[i] == b',' {
            i = skip(text, i + 1);
        }
    }
    None
}

/// 列出 plugins 数组中的 spec
pub fn list_plugin_entries(text: &str) -> Vec<String> {
    find_plugins(text)
        .map(|arr| arr.elements.into_iter().filter_map(|e| e.spec).collect())
        .unwrap_or_default()
}

/// 追加一项（已存在则原样返回）
pub fn add_plugin_entry(text: &str, spec: &str, config: Option<&Value>) -> String {
    let entry = match config {
        Some(c) => serde_json::json!([spec, c]).to_string(),
        None => serde_json::Value::String(spec.to_string()).to_string(),
    };
    if text.trim().is_empty() {
        return format!("{{\n  \"plugins\": [{}]\n}}\n", entry);
    }
    let Some(arr) = find_plugins(text) else {
        let brace = skip(text, 0);
        let rest = skip(text, brace + 1);
        let b = text.as_bytes();
        let sep = if rest < b.len() && b[rest] == b'}' {
            ""
        } else {
            ","
        };
        return format!(
            "{}\n  \"plugins\": [{}]{}{}",
            &text[..brace + 1],
            entry,
            sep,
            &text[brace + 1..]
        );
    };
    if arr.elements.iter().any(|e| e.spec.as_deref() == Some(spec)) {
        return text.to_string();
    }
    let Some(last) = arr.elements.last() else {
        return format!(
            "{}{}{}",
            &text[..arr.open + 1],
            entry,
            &text[arr.open + 1..]
        );
    };
    format!("{}{}, {}", &text[..last.end], entry, &text[last.end..])
}

/// 删除 spec 对应的项（字符串或 `[spec, config]`），找不到则原样返回
pub fn remove_plugin_entry(text: &str, spec: &str) -> String {
    let Some(arr) = find_plugins(text) else {
        return text.to_string();
    };
    let Some(idx) = arr
        .elements
        .iter()
        .position(|e| e.spec.as_deref() == Some(spec))
    else {
        return text.to_string();
    };
    let el = &arr.elements[idx];
    let next = arr.elements.get(idx + 1);
    let prev = idx.checked_sub(1).and_then(|i| arr.elements.get(i));
    if let Some(next) = next {
        return format!("{}{}", &text[..el.start], &text[next.start..]);
    }
    if let Some(prev) = prev {
        return format!("{}{}", &text[..prev.end], &text[el.end..]);
    }
    format!("{}{}", &text[..arr.open + 1], &text[arr.close..])
}
