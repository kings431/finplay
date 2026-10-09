use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::awake::KeepAwake;
use crate::downloads::Downloads;
use crate::mpris::{Control, Mpris, Track, Update};

/// The mpv to launch. A custom path from Settings wins; the default `mpv`
/// means the copy bundled with the Windows and macOS builds, then Homebrew's
/// (macOS apps don't inherit the shell PATH), then whatever is on PATH.
pub fn mpv_binary(app: &AppHandle, configured: &str) -> String {
    let configured = configured.trim();
    if !configured.is_empty() && configured != "mpv" {
        return configured.to_string();
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = if cfg!(target_os = "macos") {
            Some(resources.join("mpv").join("mpv.app").join("Contents").join("MacOS").join("mpv"))
        } else if cfg!(windows) {
            Some(resources.join("mpv").join("mpv.exe"))
        } else {
            None
        };
        if let Some(path) = bundled.filter(|path| path.is_file()) {
            return path.to_string_lossy().into_owned();
        }
    }
    if cfg!(target_os = "macos") {
        for candidate in ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"] {
            if std::path::Path::new(candidate).is_file() {
                return candidate.to_string();
            }
        }
    }
    "mpv".to_string()
}

pub struct PlayerState {
    inner: Arc<Mutex<Option<Session>>>,
}

/// The running player: an mpv process, or on macOS libmpv inside Finplay.
enum Engine {
    Process(Child),
    #[cfg(target_os = "macos")]
    Library(crate::libmpv::LibMpv),
}

impl Engine {
    fn exit_status(&mut self) -> Result<Option<String>, String> {
        match self {
            Engine::Process(child) => Ok(child.try_wait().map_err(|err| err.to_string())?.map(|status| status.to_string())),
            #[cfg(target_os = "macos")]
            Engine::Library(player) => Ok(player.exited().then(|| "shut down".to_string())),
        }
    }

    fn running(&mut self) -> bool {
        self.exit_status().ok().flatten().is_none()
    }

    fn terminate(&mut self) {
        match self {
            Engine::Process(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(target_os = "macos")]
            Engine::Library(player) => player.terminate(),
        }
    }
}

struct Session {
    child: Engine,
    shared: Arc<Shared>,
}

struct Shared {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    next_id: AtomicU64,
    stop: AtomicBool,
    suppress_close: AtomicBool,
    armed: AtomicBool,
    closed_sent: AtomicBool,
    app: AppHandle,
    made_fullscreen: AtomicBool,
    stderr: Arc<Mutex<String>>,
    embedded: bool,
    /// Native fullscreen window that hands back to the embedded player.
    handoff: bool,
    switching: AtomicBool,
    request: PlayRequest,
    thumb_counter: AtomicU64,
    awake: KeepAwake,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerEvent {
    kind: String,
    time: f64,
    duration: f64,
    paused: bool,
    ended: bool,
    reason: String,
    detail: String,
    embedded: bool,
    volume: f64,
    muted: bool,
    rate: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    url: String,
    title: String,
    start_seconds: f64,
    fullscreen: bool,
    audio_lang: String,
    subtitle_lang: String,
    subtitles_enabled: bool,
    #[serde(default = "default_one")]
    subtitle_scale: f64,
    #[serde(default)]
    subtitle_color: String,
    #[serde(default)]
    subtitle_font: String,
    #[serde(default = "default_one")]
    playback_speed: f64,
    mpv_path: String,
    badge: String,
    #[serde(default)]
    trickplay: bool,
    #[serde(default)]
    segments: String,
    #[serde(default)]
    next_title: String,
    #[serde(default)]
    auto_skip: bool,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    art_url: String,
    /// Plays the downloaded file for this item instead of `url`.
    #[serde(default)]
    download_id: String,
    /// A remote (YouTube) trailer streamed through yt-dlp.
    #[serde(default)]
    trailer: bool,
}

fn default_one() -> f64 {
    1.0
}

#[derive(Clone, Serialize)]
struct ThumbRequest {
    time: f64,
    width: u32,
}

struct PlaybackProbe {
    time: f64,
    duration: f64,
    paused: bool,
    ended: bool,
    reason: String,
    volume: f64,
    muted: bool,
    rate: f64,
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    pub fn shutdown(&self) {
        stop_player(&self.inner);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub async fn player_play(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PlayerState>,
    request: PlayRequest,
) -> Result<(), String> {
    let inner = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut request = request;
        // mpv may quit on its own while the session entry lingers; don't treat
        // that stale handoff flag as "user still wants fullscreen".
        let stale = {
            let mut guard = lock(&inner);
            guard.as_mut().is_some_and(|session| !session.child.running())
        };
        if stale {
            stop_player(&inner);
        }
        let was_fullscreen = lock(&inner).as_ref().is_some_and(|session| {
            session.shared.handoff || session.shared.made_fullscreen.load(Ordering::SeqCst)
        });
        request.fullscreen |= was_fullscreen;
        let mut wid = embed_target(&window);
        // A separate mpv process can't draw into Finplay's window on macOS.
        #[cfg(target_os = "macos")]
        if crate::libmpv::locate(&app).is_none() {
            wid = None;
        }
        // Fullscreen while embedded is unsafe on Wayland (no foreign surfaces)
        // and on macOS (AppKit crashes borderless child windows that try Spaces
        // fullscreen). Hand off to a standalone mpv window with --fs instead.
        let handoff = wid.is_some() && request.fullscreen && (wayland_session() || cfg!(target_os = "macos"));
        if handoff {
            wid = None;
        }
        start_player(app, inner, request, wid, handoff, Vec::new())
    })
    .await
    .map_err(|err| err.to_string())??;
    Ok(())
}

/// Native handle mpv can draw into with `--wid`. None on Wayland, where a
/// client cannot host another process's surface. On macOS it is an NSView
/// pointer, usable only by libmpv running inside Finplay.
fn embed_target(window: &WebviewWindow) -> Option<i64> {
    let (tx, rx) = mpsc::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            let wid = target.window_handle().ok().and_then(|handle| match handle.as_raw() {
                RawWindowHandle::Xlib(h) => Some(h.window as i64),
                RawWindowHandle::Xcb(h) => Some(h.window.get() as i64),
                RawWindowHandle::Win32(h) => Some(h.hwnd.get() as i64),
                RawWindowHandle::AppKit(h) => Some(h.ns_view.as_ptr() as i64),
                _ => None,
            });
            let _ = tx.send(wid);
        })
        .ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn restore_window(shared: &Shared) {
    if shared.made_fullscreen.swap(false, Ordering::SeqCst) {
        if let Some(window) = main_window(&shared.app) {
            let _ = window.set_fullscreen(false);
        }
    }
}

/// Fullscreening an XWayland window that mpv draws into can hang the whole
/// desktop on KWin with NVIDIA, so Wayland sessions never do it.
fn wayland_session() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
}

fn needs_fullscreen_handoff(embedded: bool) -> bool {
    embedded && (wayland_session() || cfg!(target_os = "macos"))
}

fn toggle_fullscreen(shared: &Arc<Shared>) {
    // Embedded borderless child windows cannot take Spaces fullscreen on macOS
    // (AppKit throws NSGenericException). Restart in a normal mpv window with
    // --fs, then hand back when leaving fullscreen — same as Wayland.
    if shared.handoff || needs_fullscreen_handoff(shared.embedded) {
        switch_mode(shared);
        return;
    }
    if let Some(window) = main_window(&shared.app) {
        let next = !window.is_fullscreen().unwrap_or(false);
        if window.set_fullscreen(next).is_ok() {
            shared.made_fullscreen.store(next, Ordering::SeqCst);
        }
    }
}

/// Restarts playback at the same spot, either in a native fullscreen mpv
/// window or back inside the app window.
fn switch_mode(shared: &Arc<Shared>) {
    if shared.switching.swap(true, Ordering::SeqCst) {
        return;
    }
    let shared = Arc::clone(shared);
    thread::spawn(move || {
        let to_native = !shared.handoff;
        let get = |name: &str| send_command(&shared, vec![json!("get_property"), json!(name)]).ok();
        let mut request = shared.request.clone();
        if let Some(time) = get("time-pos").and_then(|value| value.as_f64()) {
            request.start_seconds = time;
        }
        request.fullscreen = to_native;
        let mut carry = Vec::new();
        for name in ["aid", "sid", "volume", "mute", "speed", "pause"] {
            let text = match get(name) {
                Some(Value::Bool(on)) => if on { "yes" } else { "no" }.to_string(),
                Some(Value::Number(number)) => number.to_string(),
                Some(Value::String(text)) if !text.chars().any(|ch| ch.is_control()) => text,
                _ => continue,
            };
            carry.push(format!("--{name}={text}"));
        }
        let wid = if to_native {
            None
        } else {
            main_window(&shared.app).and_then(|window| embed_target(&window))
        };
        let resume_at = request.start_seconds;
        let inner = Arc::clone(&shared.app.state::<PlayerState>().inner);
        if let Err(err) = start_player(shared.app.clone(), inner, request, wid, to_native, carry) {
            let _ = shared.app.emit(
                "player",
                PlayerEvent {
                    kind: "status".into(),
                    time: resume_at,
                    duration: 0.0,
                    paused: true,
                    ended: true,
                    reason: "error".into(),
                    detail: err,
                    embedded: false,
                    volume: 100.0,
                    muted: false,
                    rate: 1.0,
                },
            );
        }
        shared.switching.store(false, Ordering::SeqCst);
    });
}

fn escape(shared: &Arc<Shared>) {
    // Handed-off playback runs in a separate mpv window; ESC returns to the
    // in-app embed instead of quitting.
    if shared.handoff {
        switch_mode(shared);
        return;
    }
    let fullscreen = shared.made_fullscreen.load(Ordering::SeqCst)
        || main_window(&shared.app)
            .and_then(|window| window.is_fullscreen().ok())
            .unwrap_or(false);
    if fullscreen {
        toggle_fullscreen(shared);
        return;
    }
    if shared.embedded {
        // Embedded chrome: leave fullscreen / UI first; only quit from Back.
        return;
    }
    quit(shared);
}

fn quit(shared: &Shared) {
    fire(shared, json!(["quit"]));
}

/// Sends a command without waiting for mpv's reply.
fn fire(shared: &Shared, command: Value) {
    let mut writer = lock(&shared.writer);
    let _ = writeln!(writer, "{}", json!({ "command": command }));
    let _ = writer.flush();
}

fn mpris(app: &AppHandle, update: Update) {
    if let Some(mpris) = app.try_state::<Mpris>() {
        mpris.update(update);
    }
}

/// Media keys and desktop media widgets.
pub fn control(app: &AppHandle, control: Control) {
    if let Control::Next = control {
        let _ = app.emit("player-next", ());
        return;
    }
    let Some(state) = app.try_state::<PlayerState>() else { return };
    let Some(shared) = lock(&state.inner).as_ref().map(|session| Arc::clone(&session.shared)) else {
        return;
    };
    let command = match control {
        Control::PlayPause => json!(["cycle", "pause"]),
        Control::Play => json!(["set", "pause", "no"]),
        Control::Pause => json!(["set", "pause", "yes"]),
        Control::Stop => json!(["quit"]),
        Control::SeekBy(seconds) => json!(["seek", seconds, "relative"]),
        Control::SeekTo(seconds) => json!(["seek", seconds, "absolute"]),
        Control::Next => return,
    };
    fire(&shared, command);
}

/// Sends a key (mpv key name) to the running player. False if nothing plays.
#[cfg(target_os = "macos")]
pub fn forward_key(app: &AppHandle, key: &str) -> bool {
    let Some(state) = app.try_state::<PlayerState>() else { return false };
    let Some(shared) = lock(&state.inner).as_ref().map(|session| Arc::clone(&session.shared)) else {
        return false;
    };
    fire(&shared, json!(["keypress", key]));
    true
}

#[tauri::command]
pub async fn player_request(
    state: State<'_, PlayerState>,
    command: Vec<Value>,
) -> Result<Value, String> {
    let shared = {
        let guard = lock(&state.inner);
        guard
            .as_ref()
            .map(|session| Arc::clone(&session.shared))
            .ok_or_else(|| "Nothing is playing".to_string())?
    };
    match tauri::async_runtime::spawn_blocking(move || send_command(&shared, command)).await {
        Ok(result) => result,
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
#[allow(unused_variables)]
pub fn player_focus(app: AppHandle, state: State<'_, PlayerState>) -> Result<(), String> {
    if lock(&state.inner).is_some() {
        #[cfg(target_os = "macos")]
        crate::libmpv::focus_player(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn player_stop(state: State<'_, PlayerState>) -> Result<(), String> {
    let inner = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        stop_player(&inner);
        Ok::<(), String>(())
    })
    .await
    .map_err(|err| err.to_string())??;
    Ok(())
}

fn stop_player(inner: &Arc<Mutex<Option<Session>>>) {
    let session = lock(inner).take();
    if let Some(mut session) = session {
        session.shared.suppress_close.store(true, Ordering::SeqCst);
        session.shared.stop.store(true, Ordering::SeqCst);
        session.shared.awake.set(false);
        mpris(&session.shared.app, Update::Stopped);
        session.child.terminate();
        restore_window(&session.shared);
        for slot in 0..2 {
            let _ = std::fs::remove_file(thumb_path(slot));
        }
    }
}

fn thumb_path(slot: u64) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("finplay-thumb-{}-{slot}.bgra", std::process::id()))
}

/// Takes a raw BGRA preview frame from the app and shows it in the overlay.
/// mpv overlays only read raw pixels from a file, so the frame goes through
/// one of two alternating temp files to avoid overwriting one mpv is reading.
#[tauri::command]
pub async fn player_thumb(state: State<'_, PlayerState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Expected raw image bytes.".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|text| text.parse::<u32>().ok())
            .ok_or_else(|| format!("Missing {name}"))
    };
    let (width, height) = (header("x-width")?, header("x-height")?);
    if width == 0 || height == 0 || width > 1280 || height > 1280 || data.len() != (width * height * 4) as usize {
        return Err("Preview frame size does not match.".into());
    }
    let shared = {
        let guard = lock(&state.inner);
        guard
            .as_ref()
            .map(|session| Arc::clone(&session.shared))
            .ok_or_else(|| "Nothing is playing".to_string())?
    };
    let path = thumb_path(shared.thumb_counter.fetch_add(1, Ordering::Relaxed) % 2);
    std::fs::write(&path, data).map_err(|err| format!("Could not write preview: {err}"))?;
    let line = json!({
        "command": ["script-message", "finplay-thumb-ready", path.to_string_lossy(), width.to_string(), height.to_string()]
    });
    let mut writer = lock(&shared.writer);
    writeln!(writer, "{line}").map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

fn start_player(
    app: AppHandle,
    inner: Arc<Mutex<Option<Session>>>,
    request: PlayRequest,
    wid: Option<i64>,
    handoff: bool,
    carry: Vec<String>,
) -> Result<(), String> {
    let media = if request.download_id.is_empty() {
        if !(request.url.starts_with("https://") || request.url.starts_with("http://")) {
            return Err("Refusing to open a stream that is not http or https.".into());
        }
        if request.url.chars().any(|ch| ch.is_control()) {
            return Err("The stream address from Jellyfin was not usable.".into());
        }
        request.url.clone()
    } else {
        app.state::<Downloads>()
            .media_path(&request.download_id)
            .ok_or_else(|| "This download is missing. Download it again.".to_string())?
            .to_string_lossy()
            .into_owned()
    };

    stop_player(&inner);

    let title: String = request
        .title
        .chars()
        .filter(|ch| !ch.is_control())
        .take(180)
        .collect();
    let badge: String = request
        .badge
        .chars()
        .filter(|ch| *ch != ',' && !ch.is_control())
        .take(90)
        .collect();
    let next_title: String = request
        .next_title
        .chars()
        .filter(|ch| *ch != ',' && !ch.is_control())
        .take(120)
        .collect();
    let segments: String = request
        .segments
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | ':' | ';'))
        .take(2000)
        .collect();
    let mpv_path = mpv_binary(&app, &request.mpv_path);
    let ytdl = if request.trailer {
        let path = crate::trailer::ytdl_path().ok_or_else(|| "Trailers need yt-dlp to play in Finplay.".to_string())?;
        path.to_str()
            .filter(|text| !text.contains(',') && !text.chars().any(|ch| ch.is_control()))
            .map(str::to_string)
            .ok_or_else(|| "The yt-dlp path is not usable.".to_string())?
    } else {
        String::new()
    };

    let sock = ipc_path();
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&sock);
    }

    let script_path = std::env::temp_dir().join("finplay-osc.lua");
    std::fs::write(&script_path, include_str!("../player/finplay.lua"))
        .map_err(|err| format!("Could not write the player overlay: {err}"))?;

    let mut args: Vec<String> = vec![
        "--no-config".into(),
        "--input-terminal=no".into(),
        "--term-osd=no".into(),
        "--force-window=immediate".into(),
        "--idle=no".into(),
        "--keep-open=yes".into(),
        "--osc=no".into(),
        "--osd-bar=no".into(),
        "--osd-on-seek=no".into(),
        "--cursor-autohide=800".into(),
        "--hr-seek=yes".into(),
        "--cache=yes".into(),
        "--demuxer-max-bytes=256MiB".into(),
        "--demuxer-readahead-secs=20".into(),
        "--audio-display=no".into(),
        "--msg-level=all=warn".into(),
        format!("--input-ipc-server={sock}"),
        format!("--script={}", script_path.display()),
        format!(
            "--script-opts=finplay-badge={badge},finplay-embedded={},finplay-handoff={},finplay-trickplay={},finplay-segments={segments},finplay-next={next_title},finplay-autoskip={}{}",
            if wid.is_some() { "yes" } else { "no" },
            if handoff { "yes" } else { "no" },
            if request.trickplay { "yes" } else { "no" },
            if request.auto_skip { "yes" } else { "no" },
            if ytdl.is_empty() { String::new() } else { format!(",ytdl_hook-ytdl_path={ytdl}") }
        ),
        format!("--title=Finplay — {title}"),
        format!("--force-media-title={title}"),
        format!("--start={}", request.start_seconds.max(0.0)),
        "--user-agent=Finplay/0.1.0".into(),
    ];
    let mut made_fullscreen = false;
    if let Some(wid) = wid {
        args.push(format!("--wid={wid}"));
        // Embedded on Linux means presenting through XWayland. Vulkan swapchains
        // there have frozen the whole desktop on NVIDIA, so use EGL, and prefer
        // NVDEC over VA-API wrappers such as libva-nvidia-driver.
        #[cfg(target_os = "linux")]
        {
            args.push("--vo=gpu".into());
            args.push("--gpu-api=opengl".into());
            args.push("--gpu-context=x11egl".into());
            args.push("--hwdec=nvdec,auto-safe".into());
        }
        if request.fullscreen {
            if let Some(window) = main_window(&app) {
                made_fullscreen = !window.is_fullscreen().unwrap_or(false) && window.set_fullscreen(true).is_ok();
            }
        }
    }
    if wid.is_none() || cfg!(not(target_os = "linux")) {
        args.push("--hwdec=auto-safe".into());
    }
    if wid.is_none() {
        // Standalone window (Wayland/macOS fullscreen handoff, or no embed).
        // Keep a normal chrome so macOS can run a real Spaces transition.
        let placement = if request.fullscreen { "--fs" } else { "--geometry=80%x80%" };
        args.push(placement.into());
        if request.fullscreen {
            args.push("--native-fs=yes".into());
        }
    }
    if !request.audio_lang.trim().is_empty() {
        args.push(format!("--alang={}", request.audio_lang.trim()));
    }
    if request.subtitles_enabled && !request.subtitle_lang.trim().is_empty() {
        args.push(format!("--slang={}", request.subtitle_lang.trim()));
    } else if !request.subtitles_enabled {
        args.push("--sid=no".into());
    }
    let scale = if request.subtitle_scale.is_finite() {
        request.subtitle_scale.clamp(0.5, 3.0)
    } else {
        1.0
    };
    if (scale - 1.0).abs() > 0.01 {
        args.push(format!("--sub-scale={scale}"));
    }
    if let Some(color) = sub_color(&request.subtitle_color) {
        args.push(format!("--sub-color={color}"));
    }
    let font: String = request
        .subtitle_font
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ' '))
        .take(64)
        .collect();
    if !font.trim().is_empty() {
        args.push(format!("--sub-font={}", font.trim()));
    }
    let speed = if request.playback_speed.is_finite() {
        request.playback_speed.clamp(0.25, 3.0)
    } else {
        1.0
    };
    if (speed - 1.0).abs() > 0.01 {
        args.push(format!("--speed={speed}"));
    }
    if request.trailer {
        // Quit at the end so Finplay returns to the title instead of a frozen frame.
        args.push("--keep-open=no".into());
        args.push("--ytdl=yes".into());
        args.push("--ytdl-format=bestvideo[height<=?1080]+bestaudio/best".into());
    }
    args.extend(carry);
    args.push("--".into());
    args.push(media);

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    // Always prefer bundled libmpv on macOS, including fullscreen handoff where
    // wid is None (a separate mpv process is not shipped in the app bundle).
    #[cfg(target_os = "macos")]
    let library = crate::libmpv::locate(&app);
    #[cfg(not(target_os = "macos"))]
    let library: Option<std::path::PathBuf> = None;
    let mut child = match library {
        #[cfg(target_os = "macos")]
        Some(path) => Engine::Library(crate::libmpv::LibMpv::start(&app, &path, &args, wid.is_some())?),
        #[cfg(not(target_os = "macos"))]
        Some(_) => unreachable!(),
        None => {
            let mut command = Command::new(&mpv_path);
            command
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            crate::host_env::use_host_environment(&mut command);
            if wid.is_some() {
                // mpv prefers Wayland when it can reach it, and Wayland ignores --wid.
                command.env_remove("WAYLAND_DISPLAY");
            }
            let mut process = command.spawn().map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    format!("mpv was not found ({mpv_path}). Install mpv, or set its full path in Settings.")
                } else {
                    format!("Could not start mpv: {err}")
                }
            })?;
            if let Some(stderr) = process.stderr.take() {
                let slot = Arc::clone(&stderr_tail);
                thread::spawn(move || drain_stderr(stderr, slot));
            }
            Engine::Process(process)
        }
    };

    let stream = match connect_ipc(&sock, &mut child, &stderr_tail) {
        Ok(stream) => stream,
        Err(err) => {
            child.terminate();
            if made_fullscreen {
                if let Some(window) = main_window(&app) {
                    let _ = window.set_fullscreen(false);
                }
            }
            return Err(err);
        }
    };

    let (writer, reader) = split_stream(stream)?;
    let shared = Arc::new(Shared {
        writer: Mutex::new(writer),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1000),
        stop: AtomicBool::new(false),
        suppress_close: AtomicBool::new(false),
        armed: AtomicBool::new(false),
        closed_sent: AtomicBool::new(false),
        app: app.clone(),
        made_fullscreen: AtomicBool::new(made_fullscreen),
        stderr: Arc::clone(&stderr_tail),
        embedded: wid.is_some(),
        handoff,
        switching: AtomicBool::new(false),
        request: request.clone(),
        thumb_counter: AtomicU64::new(0),
        awake: KeepAwake::new(),
    });
    shared.awake.set(true);

    let reader_shared = Arc::clone(&shared);
    let reader_app = app.clone();
    thread::spawn(move || read_loop(reader_app, reader_shared, reader));

    for (id, name) in [
        (1u64, "time-pos"),
        (2, "duration"),
        (3, "pause"),
        (4, "eof-reached"),
        (5, "volume"),
        (6, "mute"),
        (7, "speed"),
    ] {
        let _ = send_command(
            &shared,
            vec![json!("observe_property"), json!(id), json!(name)],
        );
    }

    {
        let mut guard = lock(&inner);
        *guard = Some(Session { child, shared: Arc::clone(&shared) });
    }
    shared.armed.store(true, Ordering::SeqCst);
    let art_url = if ["https://", "http://", "file://"].iter().any(|scheme| request.art_url.starts_with(scheme)) {
        request.art_url.chars().filter(|ch| !ch.is_control()).collect()
    } else {
        String::new()
    };
    mpris(
        &app,
        Update::Track(Track {
            title: title.clone(),
            artist: request.artist.chars().filter(|ch| !ch.is_control()).take(180).collect(),
            art_url,
            can_next: !next_title.is_empty(),
        }),
    );
    let _ = app.emit(
        "player",
        PlayerEvent {
            kind: "status".into(),
            time: request.start_seconds.max(0.0),
            duration: 0.0,
            paused: false,
            ended: false,
            reason: String::new(),
            detail: String::new(),
            embedded: wid.is_some(),
            volume: 100.0,
            muted: false,
            rate: speed,
        },
    );
    Ok(())
}

fn sub_color(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "" | "white" => None,
        "yellow" => Some("#FFFF00"),
        "cyan" => Some("#00FFFF"),
        "lime" | "green" => Some("#00FF00"),
        _ => None,
    }
}

fn connect_ipc(
    sock: &str,
    child: &mut Engine,
    stderr_tail: &Arc<Mutex<String>>,
) -> Result<IpcStream, String> {
    for _ in 0..100 {
        if let Some(status) = child.exit_status()? {
            let detail = safe_detail(&lock(stderr_tail));
            if detail.is_empty() {
                return Err(format!("mpv exited before it could play ({status})."));
            }
            return Err(format!("mpv exited before it could play. {detail}"));
        }
        match IpcStream::connect(sock) {
            Ok(stream) => return Ok(stream),
            Err(_) => thread::sleep(Duration::from_millis(20)),
        }
    }
    Err("mpv did not open its control socket.".into())
}

fn send_command(shared: &Shared, command: Vec<Value>) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
    lock(&shared.pending).insert(id, tx);
    let line = json!({ "command": command, "request_id": id }).to_string();
    {
        let mut writer = lock(&shared.writer);
        writeln!(writer, "{line}").map_err(|err| format!("Could not talk to mpv: {err}"))?;
        writer.flush().map_err(|err| format!("Could not talk to mpv: {err}"))?;
    }
    match rx.recv_timeout(Duration::from_secs(4)) {
        Ok(value) => {
            if value.get("error").and_then(Value::as_str) == Some("success") {
                Ok(value.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("mpv refused that command")
                    .to_string())
            }
        }
        Err(_) => Err("mpv did not respond.".into()),
    }
}

fn read_loop(app: AppHandle, shared: Arc<Shared>, mut reader: BufReader<Box<dyn Read + Send>>) {
    let mut line = String::new();
    let mut probe = PlaybackProbe {
        time: 0.0,
        duration: 0.0,
        paused: false,
        ended: false,
        reason: String::new(),
        volume: 100.0,
        muted: false,
        rate: 1.0,
    };
    let mut last_emit = std::time::Instant::now() - Duration::from_secs(1);
    let mut kept_awake = true;

    loop {
        if shared.stop.load(Ordering::Relaxed) {
            break;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                emit_closed(&app, &shared, &probe, "quit");
                break;
            }
            Ok(_) => {
                let urgent = apply_message(&line, &mut probe);
                let playing = !probe.paused && !probe.ended;
                if playing != kept_awake {
                    kept_awake = playing;
                    shared.awake.set(playing);
                }
                if urgent || last_emit.elapsed() >= Duration::from_millis(400) {
                    emit_status(&app, &shared, &probe);
                    last_emit = std::time::Instant::now();
                }
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    if let Some(id) = value.get("request_id").and_then(Value::as_u64) {
                        if let Some(tx) = lock(&shared.pending).remove(&id) {
                            let _ = tx.send(value);
                        }
                    } else if value.get("event").and_then(Value::as_str) == Some("client-message") {
                        match value.pointer("/args/0").and_then(Value::as_str) {
                            Some("finplay-fullscreen") => toggle_fullscreen(&shared),
                            Some("finplay-escape") => escape(&shared),
                            Some("finplay-back") => quit(&shared),
                            Some("finplay-next") => {
                                let _ = app.emit("player-next", ());
                            }
                            Some("finplay-thumb") => {
                                let arg = |index: usize| value.pointer(&format!("/args/{index}")).and_then(Value::as_str);
                                if let (Some(time), Some(width)) = (
                                    arg(1).and_then(|text| text.parse::<f64>().ok()),
                                    arg(2).and_then(|text| text.parse::<u32>().ok()),
                                ) {
                                    let _ = app.emit("player-thumb", ThumbRequest { time, width: width.clamp(80, 640) });
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Err(_) => {
                emit_closed(&app, &shared, &probe, "quit");
                break;
            }
        }
    }
}

fn apply_message(line: &str, probe: &mut PlaybackProbe) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return false;
    };
    if value.get("request_id").is_some() {
        return false;
    }
    match value.get("event").and_then(Value::as_str) {
        Some("property-change") => {
            let name = value.get("name").and_then(Value::as_str).unwrap_or("");
            let data = value.get("data");
            match name {
                "time-pos" => probe.time = data.and_then(Value::as_f64).unwrap_or(probe.time),
                "duration" => probe.duration = data.and_then(Value::as_f64).unwrap_or(0.0),
                "pause" => probe.paused = data.and_then(Value::as_bool).unwrap_or(false),
                "volume" => probe.volume = data.and_then(Value::as_f64).unwrap_or(probe.volume),
                "mute" => probe.muted = data.and_then(Value::as_bool).unwrap_or(false),
                "speed" => probe.rate = data.and_then(Value::as_f64).unwrap_or(probe.rate),
                "eof-reached" => {
                    probe.ended = data.and_then(Value::as_bool).unwrap_or(false);
                    if probe.ended && probe.reason.is_empty() {
                        probe.reason = "eof".into();
                    }
                    return true;
                }
                _ => {}
            }
            name == "pause"
        }
        Some("end-file") => {
            let reason = value.get("reason").and_then(Value::as_str).unwrap_or("");
            if reason == "eof" {
                probe.ended = true;
                probe.reason = "eof".into();
            } else if reason == "error" {
                probe.ended = true;
                probe.reason = "error".into();
            }
            true
        }
        _ => false,
    }
}

fn emit_status(app: &AppHandle, shared: &Shared, probe: &PlaybackProbe) {
    let detail = if probe.reason == "error" {
        safe_detail(&lock(&shared.stderr))
    } else {
        String::new()
    };
    if !shared.stop.load(Ordering::SeqCst) {
        mpris(
            app,
            Update::Progress { time: probe.time, duration: probe.duration, paused: probe.paused || probe.ended },
        );
    }
    let _ = app.emit(
        "player",
        PlayerEvent {
            kind: "status".into(),
            time: probe.time,
            duration: probe.duration,
            paused: probe.paused,
            ended: probe.ended,
            reason: probe.reason.clone(),
            detail,
            embedded: shared.embedded,
            volume: probe.volume,
            muted: probe.muted,
            rate: probe.rate,
        },
    );
}

fn emit_closed(app: &AppHandle, shared: &Arc<Shared>, probe: &PlaybackProbe, reason: &str) {
    shared.awake.set(false);
    if !shared.suppress_close.load(Ordering::SeqCst) {
        mpris(app, Update::Stopped);
    }
    restore_window(shared);
    if shared.suppress_close.load(Ordering::SeqCst) || !shared.armed.load(Ordering::SeqCst) {
        return;
    }
    if shared.closed_sent.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit(
        "player",
        PlayerEvent {
            kind: "closed".into(),
            time: probe.time,
            duration: probe.duration,
            paused: probe.paused,
            ended: probe.ended,
            reason: reason.into(),
            detail: String::new(),
            embedded: shared.embedded,
            volume: probe.volume,
            muted: probe.muted,
            rate: probe.rate,
        },
    );
    drop_stale_session(app, shared);
}

/// Removes a session entry after mpv exits so the next play does not inherit
/// stale handoff / fullscreen state.
fn drop_stale_session(app: &AppHandle, shared: &Arc<Shared>) {
    let inner = &app.state::<PlayerState>().inner;
    let mut guard = lock(inner);
    if guard.as_ref().is_some_and(|session| Arc::ptr_eq(&session.shared, shared)) {
        *guard = None;
    }
}

fn drain_stderr(mut stderr: std::process::ChildStderr, slot: Arc<Mutex<String>>) {
    let mut buf = [0u8; 1024];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                let mut text = lock(&slot);
                text.push_str(&String::from_utf8_lossy(&buf[..size]));
                if text.len() > 4000 {
                    let drop_count = text.len() - 2000;
                    text.drain(..drop_count);
                }
            }
        }
    }
}

/// Last few mpv log lines, with every URL cut to scheme and host so the
/// ApiKey in the stream address never reaches the UI.
fn safe_detail(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            line.split(' ')
                .map(|word| match word.find("://") {
                    Some(at) => {
                        let rest = &word[at + 3..];
                        let host_end = rest.find(['/', '?']).unwrap_or(rest.len());
                        format!("{}://{}/…", &word[..at], &rest[..host_end])
                    }
                    None => word.to_string(),
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" · ");
    tail.chars().take(360).collect()
}

fn ipc_path() -> String {
    #[cfg(unix)]
    {
        format!("/tmp/finplay-{}.sock", std::process::id())
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\finplay-{}", std::process::id())
    }
}

#[cfg(unix)]
struct IpcStream(std::os::unix::net::UnixStream);

#[cfg(unix)]
impl IpcStream {
    fn connect(path: &str) -> std::io::Result<Self> {
        Ok(Self(std::os::unix::net::UnixStream::connect(path)?))
    }
}

#[cfg(unix)]
fn split_stream(stream: IpcStream) -> Result<(Box<dyn Write + Send>, BufReader<Box<dyn Read + Send>>), String> {
    let reader = stream
        .0
        .try_clone()
        .map_err(|err| format!("Could not connect to mpv: {err}"))?;
    Ok((
        Box::new(stream.0),
        BufReader::new(Box::new(reader)),
    ))
}

#[cfg(windows)]
struct IpcStream(std::fs::File);

#[cfg(windows)]
impl IpcStream {
    fn connect(path: &str) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
        Ok(Self(file))
    }
}

#[cfg(windows)]
fn split_stream(stream: IpcStream) -> Result<(Box<dyn Write + Send>, BufReader<Box<dyn Read + Send>>), String> {
    let reader = stream
        .0
        .try_clone()
        .map_err(|err| format!("Could not connect to mpv: {err}"))?;
    Ok((Box::new(stream.0), BufReader::new(Box::new(reader))))
}
