//! Runs mpv inside Finplay through libmpv. mpv's macOS video outputs ignore
//! `--wid` and always open their own window, so in windowed mode that window is
//! made a borderless child of Finplay and laid over the content area.
//!
//! Fullscreen cannot use that child relationship: AppKit refuses Spaces
//! fullscreen on borderless child windows (NSGenericException / hard crash).
//! IINA avoids this by owning the NSWindow; Finplay instead hands off to a
//! normal standalone mpv window with `--fs` (same idea as the Linux Wayland
//! handoff). AppKit window pointers are only usable in-process. The bundled
//! libmpv is loaded at runtime, and the player is still driven over its JSON
//! IPC socket exactly like the mpv process is.

use libloading::Library;
use objc2::encode::{Encode, Encoding};
use objc2::msg_send;
use objc2::runtime::AnyObject;
use std::ffi::{c_char, c_int, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_LOG_MESSAGE: c_int = 2;

type Create = unsafe extern "C" fn() -> *mut c_void;
type SetOption = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
type Initialize = unsafe extern "C" fn(*mut c_void) -> c_int;
type Command = unsafe extern "C" fn(*mut c_void, *mut *const c_char) -> c_int;
type WaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *const c_int;
type Destroy = unsafe extern "C" fn(*mut c_void);
type ErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
type RequestLog = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
type GetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
type Free = unsafe extern "C" fn(*mut c_void);

struct Api {
    create: Create,
    set_option: SetOption,
    initialize: Initialize,
    command: Command,
    wait_event: WaitEvent,
    destroy: Destroy,
    error_string: ErrorString,
    request_log: RequestLog,
    get_property_string: GetPropertyString,
    free: Free,
}

/// Loaded once and never unloaded; libmpv does not survive being unloaded.
static API: OnceLock<Result<(Library, Api), String>> = OnceLock::new();

pub fn locate(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().resource_dir().ok()?.join("libmpv").join("libmpv.2.dylib");
    path.is_file().then_some(path)
}

fn api(path: &Path) -> Result<&'static Api, String> {
    let loaded = API.get_or_init(|| unsafe {
        // Vulkan has no system driver on macOS; use the bundled MoltenVK.
        if let Some(icd) = path.parent().map(|dir| dir.join("MoltenVK_icd.json")).filter(|icd| icd.is_file()) {
            for name in ["VK_DRIVER_FILES", "VK_ICD_FILENAMES"] {
                if std::env::var_os(name).is_none() {
                    std::env::set_var(name, &icd);
                }
            }
        }
        let library = Library::new(path).map_err(|err| format!("Could not load the built-in player ({err})."))?;
        let api = Api {
            create: *library.get::<Create>(b"mpv_create\0").map_err(|err| err.to_string())?,
            set_option: *library.get::<SetOption>(b"mpv_set_option_string\0").map_err(|err| err.to_string())?,
            initialize: *library.get::<Initialize>(b"mpv_initialize\0").map_err(|err| err.to_string())?,
            command: *library.get::<Command>(b"mpv_command\0").map_err(|err| err.to_string())?,
            wait_event: *library.get::<WaitEvent>(b"mpv_wait_event\0").map_err(|err| err.to_string())?,
            destroy: *library.get::<Destroy>(b"mpv_terminate_destroy\0").map_err(|err| err.to_string())?,
            error_string: *library.get::<ErrorString>(b"mpv_error_string\0").map_err(|err| err.to_string())?,
            request_log: *library.get::<RequestLog>(b"mpv_request_log_messages\0").map_err(|err| err.to_string())?,
            get_property_string: *library
                .get::<GetPropertyString>(b"mpv_get_property_string\0")
                .map_err(|err| err.to_string())?,
            free: *library.get::<Free>(b"mpv_free\0").map_err(|err| err.to_string())?,
        };
        Ok((library, api))
    });
    loaded.as_ref().map(|(_, api)| api).map_err(Clone::clone)
}

struct Handle(*mut c_void);
// libmpv handles are thread-safe; access is serialized by `alive` below.
unsafe impl Send for Handle {}

pub struct LibMpv {
    api: &'static Api,
    /// Some while the core runs. The event thread takes it to destroy the core.
    alive: Arc<Mutex<Option<Handle>>>,
    app: AppHandle,
}

fn cstring(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "Player option contained a NUL byte.".to_string())
}

#[repr(C)]
struct Event {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct LogMessage {
    prefix: *const c_char,
    level: *const c_char,
    text: *const c_char,
    log_level: c_int,
}

fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("ApiKey=") {
        out.push_str(&rest[..at + 7]);
        out.push_str("…");
        rest = &rest[at + 7..];
        rest = &rest[rest.find(|c: char| c == '&' || c.is_whitespace()).unwrap_or(rest.len())..];
    }
    out.push_str(rest);
    out
}

/// Warnings and errors mpv has queued, oldest first.
fn drain_messages(api: &Api, raw: *mut c_void) -> Vec<String> {
    let mut lines = Vec::new();
    for _ in 0..500 {
        let event = unsafe { (api.wait_event)(raw, 0.0) as *const Event };
        if event.is_null() {
            break;
        }
        let event = unsafe { &*event };
        if event.event_id == 0 {
            break;
        }
        if event.event_id == MPV_EVENT_LOG_MESSAGE && !event.data.is_null() {
            let message = unsafe { &*(event.data as *const LogMessage) };
            let text = |ptr: *const c_char| {
                if ptr.is_null() {
                    String::new()
                } else {
                    unsafe { std::ffi::CStr::from_ptr(ptr) }.to_string_lossy().trim().to_string()
                }
            };
            lines.push(redact(&format!("[{}] {}", text(message.prefix), text(message.text))));
        }
    }
    lines
}

/// Turns mpv command-line arguments into libmpv option pairs.
fn option_pair(arg: &str) -> Option<(String, String)> {
    let body = arg.strip_prefix("--")?;
    let (name, value) = match body.split_once('=') {
        Some((name, value)) => (name.to_string(), value.to_string()),
        None => match body.strip_prefix("no-") {
            Some(name) => (name.to_string(), "no".to_string()),
            None => (body.to_string(), "yes".to_string()),
        },
    };
    let name = if name == "script" { "scripts".to_string() } else { name };
    Some((name, value))
}

#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

unsafe impl Encode for Rect {
    const ENCODING: Encoding = Encoding::Struct(
        "CGRect",
        &[
            Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
            Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
        ],
    );
}

const NS_WINDOW_ABOVE: isize = 1;

/// (player NSWindow, Finplay NSWindow) while the player is attached.
/// Only touched on the main thread, as AppKit requires.
static ATTACHED: Mutex<Option<(usize, usize)>> = Mutex::new(None);

fn host_window(app: &AppHandle) -> Option<usize> {
    let window = app.get_webview_window("main")?;
    window.ns_window().ok().map(|pointer| pointer as usize)
}

fn window_id(api: &Api, raw: *mut c_void) -> Option<usize> {
    let name = cstring("window-id").ok()?;
    let value = unsafe { (api.get_property_string)(raw, name.as_ptr()) };
    if value.is_null() {
        return None;
    }
    let text = unsafe { std::ffi::CStr::from_ptr(value) }.to_string_lossy().into_owned();
    unsafe { (api.free)(value as *mut c_void) };
    text.trim().parse::<i64>().ok().filter(|id| *id != 0).map(|id| id as usize)
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.5
}

fn rect_near(a: Rect, b: Rect) -> bool {
    near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height)
}

/// Lays the player window over the host's content area.
/// Exact f64 equality is avoided: AppKit often returns a slightly different
/// frame after `setFrame`, which would otherwise resize forever.
unsafe fn place(player: usize, host: usize) {
    let (player, host) = (player as *mut AnyObject, host as *mut AnyObject);
    let frame: Rect = msg_send![host, frame];
    let content: Rect = msg_send![host, contentRectForFrameRect: frame];
    let current: Rect = msg_send![player, frame];
    if !rect_near(current, content) {
        let _: () = msg_send![player, setFrame: content, display: true];
    }
}

fn attach(app: &AppHandle, player: usize) {
    let Some(host) = host_window(app) else { return };
    // AppKit may send window events synchronously; never hold the lock across it.
    let previous = ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).replace((player, host));
    let fresh = previous != Some((player, host));
    unsafe {
        if let Some((old_player, old_host)) = previous {
            if old_player != player || old_host != host {
                let (window, parent) = (old_player as *mut AnyObject, old_host as *mut AnyObject);
                let _: () = msg_send![parent, removeChildWindow: window];
            }
        }
        if fresh {
            let (window, parent) = (player as *mut AnyObject, host as *mut AnyObject);
            let _: () = msg_send![window, setHasShadow: false];
            let _: () = msg_send![parent, addChildWindow: window, ordered: NS_WINDOW_ABOVE];
            let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
        }
        place(player, host);
    }
}

fn detach() {
    let attached = ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    let Some((player, host)) = attached else { return };
    unsafe {
        let (window, parent) = (player as *mut AnyObject, host as *mut AnyObject);
        let _: () = msg_send![parent, removeChildWindow: window];
        let _: () = msg_send![parent, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Keeps the player covering Finplay's content after the window moves or
/// resizes. Call on the main thread. No-op while the player is a standalone
/// fullscreen window (not attached).
pub fn follow_host() {
    let attached = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((player, host)) = attached {
        unsafe { place(player, host) };
    }
}

/// Brings keyboard focus to the embedded player window (macOS).
pub fn focus_player(app: &AppHandle) {
    let attached = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some((player, _host)) = attached else { return };
    let _ = app.run_on_main_thread(move || unsafe {
        let window = player as *mut AnyObject;
        let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    });
}

impl LibMpv {
    /// `embed` attaches the player as a borderless child over Finplay. When
    /// false, mpv keeps a normal window suitable for Spaces fullscreen (`--fs`).
    pub fn start(app: &AppHandle, path: &Path, args: &[String], embed: bool) -> Result<Self, String> {
        let api = api(path)?;
        let raw = unsafe { (api.create)() };
        if raw.is_null() {
            return Err("The built-in player could not start.".into());
        }
        let describe = |code: c_int| unsafe {
            let text = (api.error_string)(code);
            if text.is_null() {
                code.to_string()
            } else {
                std::ffi::CStr::from_ptr(text).to_string_lossy().into_owned()
            }
        };
        let fail = |message: String| {
            unsafe { (api.destroy)(raw) };
            Err(message)
        };

        // libmpv turns these off by default; the mpv binary has them on.
        let mut options = vec![
            ("input-default-bindings".to_string(), "yes".to_string()),
            ("input-vo-keyboard".to_string(), "yes".to_string()),
        ];
        if embed {
            // Child overlay: Finplay sizes the window; chrome would show through.
            options.extend([
                ("border".to_string(), "no".to_string()),
                ("title-bar".to_string(), "no".to_string()),
                ("auto-window-resize".to_string(), "no".to_string()),
                ("keepaspect-window".to_string(), "no".to_string()),
            ]);
        }
        // Standalone / fullscreen keeps mpv's normal titled window so AppKit
        // can run a real Spaces fullscreen transition (`native-fs`).
        let mut media = None;
        let mut rest = args.iter();
        for arg in rest.by_ref() {
            if arg == "--" {
                break;
            }
            if let Some(pair) = option_pair(arg) {
                options.push(pair);
            }
        }
        if let Some(target) = rest.next() {
            media = Some(target.clone());
        }

        for (name, value) in &options {
            let (key, val) = (cstring(name)?, cstring(value)?);
            let code = unsafe { (api.set_option)(raw, key.as_ptr(), val.as_ptr()) };
            if code < 0 {
                return fail(format!("The built-in player rejected {name} ({}).", describe(code)));
            }
        }
        if let Ok(level) = cstring("warn") {
            unsafe { (api.request_log)(raw, level.as_ptr()) };
        }
        let code = unsafe { (api.initialize)(raw) };
        if code < 0 {
            let details = drain_messages(api, raw);
            let tail = details[details.len().saturating_sub(6)..].join(" ");
            return fail(format!("The built-in player could not start ({}). {tail}", describe(code)));
        }
        if let Some(media) = media {
            let (load, target) = (cstring("loadfile")?, cstring(&media)?);
            let mut argv = [load.as_ptr(), target.as_ptr(), std::ptr::null()];
            let code = unsafe { (api.command)(raw, argv.as_mut_ptr()) };
            if code < 0 {
                return fail(format!("The built-in player could not open the stream ({}).", describe(code)));
            }
        }

        let alive = Arc::new(Mutex::new(Some(Handle(raw))));
        let watcher = Arc::clone(&alive);
        let events = raw as usize;
        let events_app = app.clone();
        std::thread::spawn(move || {
            loop {
                let event = unsafe { (api.wait_event)(events as *mut c_void, -1.0) };
                if !event.is_null() && unsafe { *event } == MPV_EVENT_SHUTDOWN {
                    break;
                }
            }
            // Queued ahead of mpv closing its window on the main thread.
            let _ = events_app.run_on_main_thread(detach);
            let handle = watcher.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
            if let Some(handle) = handle {
                unsafe { (api.destroy)(handle.0) };
            }
        });

        if embed {
            let poll = Arc::clone(&alive);
            let poll_app = app.clone();
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(30);
                while Instant::now() < deadline {
                    let ready = {
                        let guard = poll.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        guard.as_ref().and_then(|handle| window_id(api, handle.0)).is_some()
                    };
                    if ready {
                        // mpv may still size its window just after creating it.
                        for delay in [0, 250, 1000] {
                            std::thread::sleep(Duration::from_millis(delay));
                            let id = {
                                let guard = poll.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                                let Some(handle) = guard.as_ref() else { return };
                                window_id(api, handle.0)
                            };
                            let Some(player) = id else { continue };
                            let app = poll_app.clone();
                            let _ = poll_app.run_on_main_thread(move || attach(&app, player));
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
        }
        Ok(Self { api, alive, app: app.clone() })
    }

    pub fn exited(&self) -> bool {
        self.alive.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_none()
    }

    /// Asks the core to quit and waits briefly for it to tear down. Bounded,
    /// because teardown hops to the main thread, which may be the caller.
    pub fn terminate(&mut self) {
        let _ = self.app.run_on_main_thread(detach);
        {
            let guard = self.alive.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(handle) = guard.as_ref() {
                if let Ok(quit) = cstring("quit") {
                    let mut argv = [quit.as_ptr(), std::ptr::null()];
                    unsafe { (self.api.command)(handle.0, argv.as_mut_ptr()) };
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
