//! Plays remote (YouTube) trailers. mpv needs yt-dlp for YouTube, so without
//! it the trailer opens in its own window, which like the stats window gets no
//! capabilities and so no access to Finplay's commands.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "trailer";

/// yt-dlp (or youtube-dl) for mpv's ytdl hook. Apps started from Finder don't
/// inherit the shell PATH, so Homebrew's folders are checked too.
pub fn ytdl_path() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|paths| std::env::split_paths(&paths).collect()).unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    ["yt-dlp", "youtube-dl"].iter().find_map(|name| {
        dirs.iter().find_map(|dir| {
            let path = dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
            path.is_file().then_some(path)
        })
    })
}

/// The address the in-app player should open for a remote trailer, or None
/// when mpv cannot stream it (no yt-dlp) and the trailer window must be used.
#[tauri::command]
pub fn trailer_stream(url: String) -> Option<String> {
    let parsed = Url::parse(url.trim()).ok().filter(|url| matches!(url.scheme(), "http" | "https"))?;
    ytdl_path()?;
    Some(match youtube_id(&parsed) {
        Some(id) => format!("https://www.youtube.com/watch?v={id}"),
        None => parsed.to_string(),
    })
}

fn youtube_id(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.");
    let id = match host {
        "youtu.be" => url.path_segments()?.next()?.to_string(),
        "youtube.com" | "youtube-nocookie.com" => {
            if url.path() == "/watch" {
                url.query_pairs().find(|(key, _)| key == "v")?.1.into_owned()
            } else {
                let mut parts = url.path_segments()?;
                match parts.next()? {
                    "embed" | "shorts" | "v" => parts.next()?.to_string(),
                    _ => return None,
                }
            }
        }
        _ => return None,
    };
    (id.len() >= 6 && id.len() <= 20 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')).then_some(id)
}

#[tauri::command]
pub async fn play_trailer(app: AppHandle, url: String, title: String, mpv_path: String, fullscreen: bool) -> Result<String, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "This trailer link is not valid.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("This trailer link is not a web address.".into());
    }
    let target = match youtube_id(&parsed) {
        Some(id) => Url::parse(&format!(
            "https://www.youtube-nocookie.com/embed/{id}?autoplay=1&rel=0&modestbranding=1&playsinline=1"
        ))
        .map_err(|err| err.to_string())?,
        None => parsed,
    };
    let title: String = title.chars().filter(|ch| !ch.is_control()).take(160).collect();
    let heading = if title.is_empty() { "Trailer".to_string() } else { format!("{title} · Trailer") };

    if ytdl_path().is_some() {
        let mut command = Command::new(crate::mpv::mpv_binary(&app, &mpv_path));
        command
            .arg("--force-window=immediate")
            .arg(format!("--title={heading}"))
            .arg("--ytdl-format=bestvideo[height<=?1080]+bestaudio/best")
            .arg("--keep-open=no");
        if fullscreen {
            command.arg("--fs");
        }
        command.arg("--").arg(target.as_str()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::host_env::use_host_environment(&mut command);
        if let Ok(mut child) = command.spawn() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok("mpv".into());
        }
    }

    if let Some(window) = app.get_webview_window(LABEL) {
        window.navigate(target).map_err(|err| format!("Could not open the trailer ({err})."))?;
        let _ = window.set_title(&heading);
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok("window".into());
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(target))
        .title(heading)
        .inner_size(1280.0, 760.0)
        .min_inner_size(640.0, 400.0)
        .build()
        .map_err(|err| format!("Could not open the trailer ({err})."))?;
    Ok("window".into())
}
