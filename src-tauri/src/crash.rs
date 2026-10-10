//! Crash reports to a Discord webhook. The address is baked in at build time
//! from `FINPLAY_CRASH_WEBHOOK` (a release secret); builds without it send nothing.
//! Panics are written to disk first, so one that takes the app down is sent on
//! the next launch.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

fn webhook() -> Option<&'static str> {
    option_env!("FINPLAY_CRASH_WEBHOOK").filter(|url| !url.is_empty())
}
/// A crash loop must not flood the channel (Discord allows ~30 posts a minute per webhook).
const PER_RUN: usize = 5;
const PENDING: &str = "crash-pending.json";
const OFF: &str = "crash-reports-off";

static ENABLED: AtomicBool = AtomicBool::new(true);
static SENT: AtomicUsize = AtomicUsize::new(0);
static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Deserialize)]
pub struct Report {
    kind: String,
    message: String,
    #[serde(default)]
    stack: String,
    #[serde(default)]
    context: String,
}

/// Cuts tokens out of `ApiKey=…`-style text and the user's name out of home paths.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    for marker in ["ApiKey=", "api_key=", "api-key=", "Token=", "token=", "X-Emby-Token: ", "Authorization: "] {
        let mut from = 0;
        while let Some(found) = out[from..].find(marker) {
            let start = from + found + marker.len();
            let end = out[start..]
                .find(|c: char| matches!(c, '&' | '"' | '\'' | ' ' | '\n' | ',' | ')'))
                .map_or(out.len(), |offset| start + offset);
            let quoted = out[start..].starts_with('"');
            let (start, end) = if quoted {
                let close = out[start + 1..].find('"').map_or(out.len(), |offset| start + 1 + offset + 1);
                (start, close)
            } else {
                (start, end)
            };
            out.replace_range(start..end, "…");
            from = start + "…".len();
        }
    }
    for root in ["/Users/", "/home/", "\\Users\\", "C:/Users/"] {
        let mut from = 0;
        while let Some(found) = out[from..].find(root) {
            let start = from + found + root.len();
            let end = out[start..]
                .find(|c: char| matches!(c, '/' | '\\' | '"' | ' ' | '\n'))
                .map_or(out.len(), |offset| start + offset);
            out.replace_range(start..end, "…");
            from = start + "…".len();
        }
    }
    out
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max - 1).collect::<String>() + "…"
}

fn body(report: &Report) -> Value {
    let version = env!("CARGO_PKG_VERSION");
    let os = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    let stack = scrub(&report.stack);
    let mut description = scrub(&report.message);
    if !stack.trim().is_empty() {
        description = format!("{description}\n```\n{}\n```", clip(&stack, 3200));
    }
    let mut fields = vec![
        json!({ "name": "Version", "value": version, "inline": true }),
        json!({ "name": "OS", "value": os, "inline": true }),
    ];
    if !report.context.trim().is_empty() {
        fields.push(json!({ "name": "Context", "value": clip(&scrub(&report.context), 1000), "inline": false }));
    }
    json!({
        "username": "Finplay crashes",
        "embeds": [{
            "title": clip(&format!("{} · {}", report.kind, scrub(&report.message)), 250),
            "description": clip(&description, 4000),
            "color": 0x9333ea,
            "fields": fields,
        }],
    })
}

fn post(report: &Report) -> bool {
    let Some(url) = webhook() else { return false };
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .build()
        .post(url)
        .set("Content-Type", "application/json")
        .send_string(&body(report).to_string())
        .is_ok()
}

/// Sends once per distinct crash and at most `PER_RUN` times per launch.
fn send(report: &Report) -> bool {
    if !ENABLED.load(Ordering::Relaxed) || webhook().is_none() {
        return false;
    }
    let signature = format!("{}|{}", report.kind, clip(&report.message, 200));
    let fresh = SEEN.get_or_init(|| Mutex::new(HashSet::new())).lock().map(|mut seen| seen.insert(signature)).unwrap_or(false);
    if !fresh || SENT.fetch_add(1, Ordering::Relaxed) >= PER_RUN {
        return false;
    }
    post(report)
}

fn panic_report(info: &std::panic::PanicHookInfo<'_>) -> Report {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|text| text.to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into());
    let location = info.location().map(|at| format!("{}:{}", at.file(), at.line())).unwrap_or_default();
    let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
    Report {
        kind: "Rust panic".into(),
        message,
        stack: std::backtrace::Backtrace::force_capture().to_string(),
        context: format!("at {location} on thread {thread}"),
    }
}

/// Call once at startup with a writable folder.
pub fn install(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    ENABLED.store(!dir.join(OFF).exists(), Ordering::Relaxed);
    let _ = DIR.set(dir.clone());
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let report = panic_report(info);
        if ENABLED.load(Ordering::Relaxed) && webhook().is_some() {
            let pending = dir.join(PENDING);
            let saved = json!({ "kind": report.kind, "message": report.message, "stack": report.stack, "context": report.context });
            let _ = fs::write(&pending, saved.to_string());
            if send(&report) {
                let _ = fs::remove_file(&pending);
            }
        }
        previous(info);
    }));
    std::thread::spawn(send_pending);
}

/// A panic that ended the last run before its report went out.
fn send_pending() {
    let Some(dir) = DIR.get() else { return };
    let pending = dir.join(PENDING);
    let Ok(text) = fs::read_to_string(&pending) else { return };
    let _ = fs::remove_file(&pending);
    if let Ok(mut report) = serde_json::from_str::<Report>(&text) {
        report.context = format!("{} (sent on the next launch)", report.context);
        send(&report);
    }
}

#[tauri::command]
pub fn crash_report(report: Report) {
    std::thread::spawn(move || {
        send(&report);
    });
}

#[tauri::command]
pub fn crash_reporting(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    if let Some(dir) = DIR.get() {
        let off = dir.join(OFF);
        if enabled {
            let _ = fs::remove_file(off);
        } else {
            let _ = fs::write(off, "");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_removes_tokens_and_user_names() {
        let text = r#"GET https://jf.example/Videos/1/stream?ApiKey=abc123&static=true Token="secret" at /Users/marcus/finplay and C:\Users\Marcus\AppData"#;
        let clean = scrub(text);
        assert!(!clean.contains("abc123"));
        assert!(!clean.contains("secret"));
        assert!(!clean.contains("marcus"));
        assert!(!clean.contains("Marcus"));
        assert!(clean.contains("static=true"));
    }

    /// Run with FINPLAY_CRASH_WEBHOOK=http://127.0.0.1:18787/hook to check what Discord would receive.
    #[test]
    fn posts_scrubbed_embed() {
        use std::io::{Read, Write};
        if webhook() != Some("http://127.0.0.1:18787/hook") {
            return;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:18787").unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(|value| value.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if request.len() >= split + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        let report = Report {
            kind: "Crash screen".into(),
            message: "boom at https://jf.example/x?ApiKey=topsecret".into(),
            stack: "Error: boom\n    at /Users/marcus/app.js:1:1".into(),
            context: "screen #/home".into(),
        };
        assert!(send(&report));
        assert!(!send(&report), "the same crash is sent once per run");
        let request = server.join().unwrap();
        assert!(request.contains("\"embeds\""));
        assert!(!request.contains("topsecret"));
        assert!(!request.contains("marcus"));
    }
}
