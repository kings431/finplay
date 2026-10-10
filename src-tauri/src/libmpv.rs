//! Runs mpv inside Finplay through libmpv. mpv's macOS video outputs ignore
//! `--wid` and always open their own window, so in windowed mode mpv's video
//! view is moved into Finplay's window and mpv's own window is kept hidden.
//!
//! Fullscreen cannot use that arrangement: AppKit refuses Spaces fullscreen on
//! the borrowed borderless window (NSGenericException / hard crash).
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_LOG_MESSAGE: c_int = 2;
const MPV_EVENT_CLIENT_MESSAGE: c_int = 16;
const MPV_EVENT_VIDEO_RECONFIG: c_int = 17;

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
struct ClientMessage {
    num_args: c_int,
    args: *const *const c_char,
}

/// First argument of a `script-message` event, if `event` is one.
unsafe fn client_message(event: *const c_int) -> Option<String> {
    let event = &*(event as *const Event);
    if event.data.is_null() {
        return None;
    }
    let message = &*(event.data as *const ClientMessage);
    if message.num_args < 1 || message.args.is_null() || (*message.args).is_null() {
        return None;
    }
    Some(std::ffi::CStr::from_ptr(*message.args).to_string_lossy().into_owned())
}

/// Hides the cursor over the embedded video until the mouse moves.
fn hide_cursor() {
    let attached = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if attached.is_some_and(|embed| shows_video(embed.host)) {
        let _: () = unsafe { msg_send![objc2::class!(NSCursor), setHiddenUntilMouseMoves: true] };
    }
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

/// `[prefix] level: text` for a log event, with the stream's ApiKey cut out.
unsafe fn log_line(event: &Event) -> Option<String> {
    if event.event_id != MPV_EVENT_LOG_MESSAGE || event.data.is_null() {
        return None;
    }
    let message = &*(event.data as *const LogMessage);
    let text = |ptr: *const c_char| {
        if ptr.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(ptr).to_string_lossy().trim().to_string()
        }
    };
    Some(redact(&format!("[{}] {}: {}", text(message.prefix), text(message.level), text(message.text))))
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
        if let Some(line) = unsafe { log_line(event) } {
            lines.push(line);
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
const NS_VIEW_WIDTH_SIZABLE: usize = 1 << 1;
const NS_VIEW_HEIGHT_SIZABLE: usize = 1 << 4;

#[repr(transparent)]
#[derive(Clone, Copy)]
struct CgColor(*const c_void);

unsafe impl Encode for CgColor {
    const ENCODING: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
}

/// The embedded player's AppKit objects. mpv draws into `video`, its own
/// view, which Finplay moves into its window; mpv's window (`player`) stays
/// hidden but sized like the video, since mpv sizes its output from it.
/// Only touched on the main thread, as AppKit requires.
#[derive(Clone, Copy, PartialEq)]
struct Embed {
    player: usize,
    host: usize,
    video: usize,
    /// Black backing for the title bar strip above the video.
    backdrop: usize,
}

static ATTACHED: Mutex<Option<Embed>> = Mutex::new(None);

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

/// Picture-in-picture: the player leaves Finplay and floats above every app
/// in a corner of the screen, so it stays visible while other apps are used.
static MINI: AtomicBool = AtomicBool::new(false);
/// Set once the floating player has been placed; the user may then drag it.
static MINI_PLACED: AtomicBool = AtomicBool::new(false);
const MINI_MARGIN: f64 = 20.0;
const NS_NORMAL_WINDOW_LEVEL: isize = 0;
const NS_FLOATING_WINDOW_LEVEL: isize = 3;
const NS_COLLECTION_ALL_SPACES: usize = 1 << 0;
const NS_COLLECTION_FULLSCREEN_AUXILIARY: usize = 1 << 8;

unsafe fn mini_rect(host: *mut AnyObject) -> Rect {
    let screen: *mut AnyObject = msg_send![host, screen];
    let area: Rect = if screen.is_null() { msg_send![host, frame] } else { msg_send![screen, visibleFrame] };
    let width = (area.width * 0.22).clamp(320.0, 480.0).min(area.width - 2.0 * MINI_MARGIN).max(1.0);
    let height = width * 9.0 / 16.0;
    Rect {
        x: area.x + area.width - width - MINI_MARGIN,
        y: area.y + MINI_MARGIN,
        width,
        height,
    }
}

/// Finplay's content area in screen coordinates, below the overlaid title bar.
unsafe fn content_rect(host: *mut AnyObject) -> Rect {
    let frame: Rect = msg_send![host, frame];
    let layout: Rect = msg_send![host, contentLayoutRect];
    Rect { x: frame.x + layout.x, y: frame.y + layout.y, width: layout.width, height: layout.height }
}

/// mpv's video view: the subview of its window backed by a Metal layer.
unsafe fn video_view(player: *mut AnyObject) -> Option<*mut AnyObject> {
    let content: *mut AnyObject = msg_send![player, contentView];
    if content.is_null() {
        return None;
    }
    let subviews: *mut AnyObject = msg_send![content, subviews];
    let count: usize = msg_send![subviews, count];
    let metal = objc2::runtime::AnyClass::get(c"CAMetalLayer");
    let mut first = None;
    for index in 0..count {
        let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
        first.get_or_insert(view);
        let layer: *mut AnyObject = msg_send![view, layer];
        if let (false, Some(metal)) = (layer.is_null(), metal) {
            let is_metal: bool = msg_send![layer, isKindOfClass: metal];
            if is_metal {
                return Some(view);
            }
        }
    }
    first
}

unsafe fn make_backdrop() -> *mut AnyObject {
    let view: *mut AnyObject = msg_send![objc2::class!(NSView), alloc];
    let zero = Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 };
    let view: *mut AnyObject = msg_send![view, initWithFrame: zero];
    let _: () = msg_send![view, setWantsLayer: true];
    let layer: *mut AnyObject = msg_send![view, layer];
    let black: *mut AnyObject = msg_send![objc2::class!(NSColor), blackColor];
    let color: CgColor = msg_send![black, CGColor];
    let _: () = msg_send![layer, setBackgroundColor: color];
    let _: () = msg_send![view, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
    view
}

/// Moves `view` into `parent` (on top) and sizes it, unless already there.
unsafe fn adopt(parent: *mut AnyObject, view: *mut AnyObject, frame: Rect, above: *mut AnyObject) {
    let current: *mut AnyObject = msg_send![view, superview];
    if current != parent {
        let _: () = msg_send![parent, addSubview: view, positioned: NS_WINDOW_ABOVE, relativeTo: above];
    }
    let now: Rect = msg_send![view, frame];
    if !rect_near(now, frame) {
        let _: () = msg_send![view, setFrame: frame];
    }
}

/// Shows the video inside Finplay below the title bar, or floating in mpv's
/// own window while mini.
unsafe fn place(embed: Embed) {
    let player = embed.player as *mut AnyObject;
    let host = embed.host as *mut AnyObject;
    let video = embed.video as *mut AnyObject;
    let backdrop = embed.backdrop as *mut AnyObject;
    let parent: *mut AnyObject = msg_send![player, parentWindow];
    if !parent.is_null() {
        let _: () = msg_send![parent, removeChildWindow: player];
    }
    if MINI.load(Ordering::SeqCst) {
        let _: () = msg_send![backdrop, removeFromSuperview];
        let content: *mut AnyObject = msg_send![player, contentView];
        let bounds: Rect = msg_send![content, bounds];
        adopt(content, video, bounds, std::ptr::null_mut());
        let _: () = msg_send![player, setLevel: NS_FLOATING_WINDOW_LEVEL];
        let _: () = msg_send![player, setCollectionBehavior: NS_COLLECTION_ALL_SPACES | NS_COLLECTION_FULLSCREEN_AUXILIARY];
        let _: () = msg_send![player, setHasShadow: true];
        let _: () = msg_send![player, setMovableByWindowBackground: true];
        if !MINI_PLACED.swap(true, Ordering::SeqCst) {
            let _: () = msg_send![player, setFrame: mini_rect(host), display: true];
        }
        let _: () = msg_send![player, orderFront: std::ptr::null_mut::<AnyObject>()];
        return;
    }
    MINI_PLACED.store(false, Ordering::SeqCst);
    let content: *mut AnyObject = msg_send![host, contentView];
    let bounds: Rect = msg_send![content, bounds];
    let layout: Rect = msg_send![host, contentLayoutRect];
    let below_title: Rect = msg_send![content, convertRect: layout, fromView: std::ptr::null_mut::<AnyObject>()];
    adopt(content, backdrop, bounds, std::ptr::null_mut());
    adopt(content, video, below_title, backdrop);
    let _: () = msg_send![player, orderOut: std::ptr::null_mut::<AnyObject>()];
    let _: () = msg_send![player, setLevel: NS_NORMAL_WINDOW_LEVEL];
    let _: () = msg_send![player, setCollectionBehavior: 0usize];
    let _: () = msg_send![player, setMovableByWindowBackground: false];
    let size = content_rect(host);
    let frame: Rect = msg_send![player, frame];
    if !rect_near(frame, size) {
        let _: () = msg_send![player, setFrame: size, display: false];
    }
}

/// Moves the embedded player between filling Finplay and floating mini.
/// False when there is no embedded player to move.
pub fn set_mini(app: &AppHandle, on: bool) -> bool {
    let attached = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if on && attached.is_none() {
        return false;
    }
    MINI.store(on, Ordering::SeqCst);
    MINI_PLACED.store(false, Ordering::SeqCst);
    let Some(embed) = attached else { return true };
    let _ = app.run_on_main_thread(move || unsafe {
        place(embed);
        let _: () = msg_send![embed.host as *mut AnyObject, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    });
    true
}

/// Leaves mini mode, returning whether it was on.
pub fn take_mini() -> bool {
    MINI_PLACED.store(false, Ordering::SeqCst);
    MINI.swap(false, Ordering::SeqCst)
}

pub fn is_mini() -> bool {
    MINI.load(Ordering::SeqCst)
}

/// Puts the video view back in mpv's window so mpv can tear it down as usual.
unsafe fn release(embed: Embed) {
    let player = embed.player as *mut AnyObject;
    let video = embed.video as *mut AnyObject;
    let backdrop = embed.backdrop as *mut AnyObject;
    let _: () = msg_send![backdrop, removeFromSuperview];
    let _: () = msg_send![backdrop, release];
    let content: *mut AnyObject = msg_send![player, contentView];
    if !content.is_null() {
        let bounds: Rect = msg_send![content, bounds];
        adopt(content, video, bounds, std::ptr::null_mut());
    }
}

fn attach(app: &AppHandle, player: usize) {
    let Some(host) = host_window(app) else { return };
    let previous = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    unsafe {
        if let Some(embed) = previous.filter(|embed| embed.player == player && embed.host == host) {
            place(embed);
            return;
        }
        let Some(video) = video_view(player as *mut AnyObject) else { return };
        if let Some(old) = previous {
            release(old);
        }
        let window = player as *mut AnyObject;
        let _: () = msg_send![window, setExcludedFromWindowsMenu: true];
        let _: () = msg_send![window, setHasShadow: false];
        let embed = Embed { player, host, video: video as usize, backdrop: make_backdrop() as usize };
        // AppKit may send window events synchronously; never hold the lock across it.
        *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(embed);
        place(embed);
        let _: () = msg_send![host as *mut AnyObject, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Finplay's Dock icon when it is not running from an app bundle (dev builds).
static APP_ICON: AtomicUsize = AtomicUsize::new(0);

/// Records the Dock icon so `restore_app_icon` can put it back. Call at startup.
pub fn remember_app_icon(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| unsafe {
        let shared: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
        let icon: *mut AnyObject = msg_send![shared, applicationIconImage];
        if !icon.is_null() {
            let copy: *mut AnyObject = msg_send![icon, copy];
            APP_ICON.store(copy as usize, Ordering::Relaxed);
        }
    });
}

/// mpv swaps the Dock icon for its own each time it sets up a video window
/// (unless MPVBUNDLE=true, which also rewrites PATH) and never changes it
/// back. Call on the main thread after mpv has configured its output.
fn restore_app_icon() {
    unsafe {
        let shared: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
        let bundle: *mut AnyObject = msg_send![objc2::class!(NSBundle), mainBundle];
        let path: *mut AnyObject = msg_send![bundle, bundlePath];
        let suffix: *mut AnyObject = msg_send![objc2::class!(NSString), stringWithUTF8String: c".app".as_ptr()];
        let bundled: bool = !path.is_null() && msg_send![path, hasSuffix: suffix];
        // nil makes AppKit fall back to the bundle's icon file.
        let icon = if bundled { std::ptr::null_mut() } else { APP_ICON.load(Ordering::Relaxed) as *mut AnyObject };
        let _: () = msg_send![shared, setApplicationIconImage: icon];
    }
}

fn detach() {
    restore_app_icon();
    let attached = ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    let Some(embed) = attached else { return };
    unsafe {
        release(embed);
        let _: () = msg_send![embed.host as *mut AnyObject, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Keeps the video and mpv's hidden window matched to Finplay after it moves
/// or resizes. Call on the main thread. No-op while the player is a standalone
/// fullscreen window (not attached).
pub fn follow_host() {
    let attached = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(embed) = attached {
        unsafe { place(embed) };
    }
}

/// Gives Finplay keyboard focus while the video is shown inside it; keys are
/// then forwarded to mpv (see `install_key_forwarding`).
pub fn focus_player(app: &AppHandle) {
    let attached = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(embed) = attached else { return };
    if is_mini() {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        let _: () = msg_send![embed.host as *mut AnyObject, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    });
}

/// Whether keys typed into `window` belong to the embedded video.
fn shows_video(window: usize) -> bool {
    let attached = *ATTACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    attached.is_some_and(|embed| embed.host == window) && !is_mini()
}

const NS_EVENT_MASK_KEY_DOWN: u64 = 1 << 10;
const NS_SHIFT: usize = 1 << 17;
const NS_CONTROL: usize = 1 << 18;
const NS_OPTION: usize = 1 << 19;
const NS_COMMAND: usize = 1 << 20;

/// mpv name for a key press, or None to leave the event to AppKit.
fn mpv_key_name(code: u16, chars: &str, flags: usize) -> Option<String> {
    if flags & NS_COMMAND != 0 {
        return None;
    }
    let special = match code {
        49 => Some("SPACE"),
        36 => Some("ENTER"),
        76 => Some("KP_ENTER"),
        48 => Some("TAB"),
        51 => Some("BS"),
        117 => Some("DEL"),
        53 => Some("ESC"),
        123 => Some("LEFT"),
        124 => Some("RIGHT"),
        125 => Some("DOWN"),
        126 => Some("UP"),
        115 => Some("HOME"),
        119 => Some("END"),
        116 => Some("PGUP"),
        121 => Some("PGDWN"),
        _ => None,
    };
    let base = match special {
        Some(name) => name.to_string(),
        None => {
            let mut chars = chars.chars();
            let ch = chars.next().filter(|ch| !ch.is_control() && chars.next().is_none())?;
            if ch == '#' { "SHARP".to_string() } else { ch.to_string() }
        }
    };
    let mut name = String::new();
    if flags & NS_CONTROL != 0 {
        name.push_str("Ctrl+");
    }
    if flags & NS_OPTION != 0 {
        name.push_str("Alt+");
    }
    if special.is_some() && flags & NS_SHIFT != 0 {
        name.push_str("Shift+");
    }
    name.push_str(&base);
    Some(name)
}

/// libmpv only reads the keyboard through mpv's own NSApplication subclass,
/// which Finplay is not, so keys typed into a player window (embedded or the
/// fullscreen handoff) would be dropped. Forward them over IPC instead.
pub fn install_key_forwarding(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || unsafe {
        let block = block2::RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
            if event.is_null() {
                return event;
            }
            let window: *mut AnyObject = msg_send![event, window];
            if window.is_null() {
                return event;
            }
            let ours = handle
                .webview_windows()
                .values()
                .any(|webview| webview.ns_window().is_ok_and(|pointer| pointer as usize == window as usize));
            let panel: bool = msg_send![window, isKindOfClass: objc2::class!(NSPanel)];
            if (ours && !shows_video(window as usize)) || panel {
                return event;
            }
            let code: u16 = msg_send![event, keyCode];
            let flags: usize = msg_send![event, modifierFlags];
            let text: *mut AnyObject = msg_send![event, charactersIgnoringModifiers];
            let chars = if text.is_null() {
                String::new()
            } else {
                let utf8: *const c_char = msg_send![text, UTF8String];
                if utf8.is_null() { String::new() } else { std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned() }
            };
            match mpv_key_name(code, &chars, flags) {
                Some(name) if crate::mpv::forward_key(&handle, &name) => std::ptr::null_mut(),
                _ => event,
            }
        });
        let monitor: *mut AnyObject = msg_send![
            objc2::class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: NS_EVENT_MASK_KEY_DOWN,
            handler: &*block
        ];
        if !monitor.is_null() {
            let _: *mut AnyObject = msg_send![monitor, retain];
        }
    });
}

impl LibMpv {
    /// `embed` attaches the player as a borderless child over Finplay. When
    /// false, mpv keeps a normal window suitable for Spaces fullscreen (`--fs`).
    /// mpv's warnings and errors are appended to `log`, as stderr is for the mpv process.
    pub fn start(app: &AppHandle, path: &Path, args: &[String], embed: bool, log: Arc<Mutex<String>>) -> Result<Self, String> {
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
                // mpv's window stays hidden, so it would otherwise stop drawing.
                ("force-render".to_string(), "yes".to_string()),
                ("window-dragging".to_string(), "no".to_string()),
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
                if event.is_null() {
                    continue;
                }
                match unsafe { *event } {
                    MPV_EVENT_SHUTDOWN => break,
                    MPV_EVENT_LOG_MESSAGE => {
                        if let Some(line) = unsafe { log_line(&*(event as *const Event)) } {
                            crate::mpv::push_log(&log, &line);
                        }
                    }
                    MPV_EVENT_CLIENT_MESSAGE => {
                        if unsafe { client_message(event) }.as_deref() == Some("finplay-hide-cursor") {
                            let _ = events_app.run_on_main_thread(hide_cursor);
                        }
                    }
                    // mpv resizes its own window to suit new video; pull it back over Finplay.
                    // Its window setup has also replaced the Dock icon by now.
                    MPV_EVENT_VIDEO_RECONFIG => {
                        let app = events_app.clone();
                        std::thread::spawn(move || {
                            for delay in [0, 300] {
                                std::thread::sleep(Duration::from_millis(delay));
                                let _ = app.run_on_main_thread(|| {
                                    restore_app_icon();
                                    follow_host();
                                });
                            }
                        });
                    }
                    _ => {}
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
