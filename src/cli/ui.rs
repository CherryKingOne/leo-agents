//! 终端 UI 辅助。

use crate::protocol::display::DisplayBlock;
use std::io::{IsTerminal, Read, Write};

fn use_color(is_tty: bool) -> bool {
    is_tty && std::env::var("NO_COLOR").is_err()
}

fn wrap(code: u8, close: u8, text: &str) -> String {
    if use_color(std::io::stderr().is_terminal()) {
        format!("\x1b[{}m{}\x1b[{}m", code, text, close)
    } else {
        text.to_string()
    }
}

pub fn dim(s: &str) -> String {
    wrap(2, 22, s)
}
pub fn bold(s: &str) -> String {
    wrap(1, 22, s)
}
pub fn red(s: &str) -> String {
    wrap(31, 39, s)
}
pub fn green(s: &str) -> String {
    wrap(32, 39, s)
}
pub fn yellow(s: &str) -> String {
    wrap(33, 39, s)
}
pub fn cyan(s: &str) -> String {
    wrap(36, 39, s)
}
pub fn magenta(s: &str) -> String {
    wrap(35, 39, s)
}
pub fn gray(s: &str) -> String {
    wrap(90, 39, s)
}

pub fn one_line(s: &str, max: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > max {
        let prefix: String = t.chars().take(max - 1).collect();
        format!("{}…", prefix)
    } else {
        t
    }
}

pub fn ask_secret(question: &str) -> Result<String, String> {
    print!("{}", question);
    let _ = std::io::stdout().flush();
    rpassword::read_password().map_err(|e| e.to_string())
}

pub fn read_stdin() -> String {
    let mut buf = String::new();
    let _ = std::io::stdin().read_to_string(&mut buf);
    buf
}

pub fn render_display(blocks: &[DisplayBlock], is_tty: bool) {
    let mut drawn = false;
    for b in blocks {
        match b {
            DisplayBlock::Text { text } => println!("{}", text),
            DisplayBlock::Ansi { lines, fallback } => {
                if use_color(is_tty) {
                    println!("{}\x1b[0m", lines.join("\n"));
                    drawn = true;
                } else if let Some(fallback) = fallback {
                    println!("{}", fallback);
                }
            }
            DisplayBlock::Image { url, alt, .. } => {
                if !drawn {
                    println!("🖼 {} {}", alt.as_deref().unwrap_or(""), url);
                }
            }
        }
    }
}
