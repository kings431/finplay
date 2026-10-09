//! Runs mpv inside Finplay through libmpv. macOS only lets a process draw
//! into its own windows, so `--wid` (an NSView pointer there) works only
//! in-process. The bundled libmpv is loaded at runtime, and the player is
//! still driven over its JSON IPC socket exactly like the mpv process is.

use libloading::Library;
use std::ffi::{c_char, c_int, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MPV_EVENT_SHUTDOWN: c_int = 1;

type Create = unsafe extern "C" fn() -> *mut c_void;
type SetOption = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
type Initialize = unsafe extern "C" fn(*mut c_void) -> c_int;
type Command = unsafe extern "C" fn(*mut c_void, *mut *const c_char) -> c_int;
type WaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *const c_int;
type Destroy = unsafe extern "C" fn(*mut c_void);
type ErrorString = unsafe extern "C" fn(c_int) -> *const c_char;

struct Api {
    create: Create,
    set_option: SetOption,
    initialize: Initialize,
    command: Command,
    wait_event: WaitEvent,
    destroy: Destroy,
    error_string: ErrorString,
}

/// Loaded once and never unloaded; libmpv does not survive being unloaded.
static API: OnceLock<Result<(Library, Api), String>> = OnceLock::new();

pub fn locate(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().resource_dir().ok()?.join("libmpv").join("libmpv.2.dylib");
    path.is_file().then_some(path)
}

fn api(path: &Path) -> Result<&'static Api, String> {
    let loaded = API.get_or_init(|| unsafe {
        let library = Library::new(path).map_err(|err| format!("Could not load the built-in player ({err})."))?;
        let api = Api {
            create: *library.get::<Create>(b"mpv_create\0").map_err(|err| err.to_string())?,
            set_option: *library.get::<SetOption>(b"mpv_set_option_string\0").map_err(|err| err.to_string())?,
            initialize: *library.get::<Initialize>(b"mpv_initialize\0").map_err(|err| err.to_string())?,
            command: *library.get::<Command>(b"mpv_command\0").map_err(|err| err.to_string())?,
            wait_event: *library.get::<WaitEvent>(b"mpv_wait_event\0").map_err(|err| err.to_string())?,
            destroy: *library.get::<Destroy>(b"mpv_terminate_destroy\0").map_err(|err| err.to_string())?,
            error_string: *library.get::<ErrorString>(b"mpv_error_string\0").map_err(|err| err.to_string())?,
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
}

fn cstring(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "Player option contained a NUL byte.".to_string())
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

impl LibMpv {
    pub fn start(path: &Path, args: &[String]) -> Result<Self, String> {
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
        let code = unsafe { (api.initialize)(raw) };
        if code < 0 {
            return fail(format!("The built-in player could not start ({}).", describe(code)));
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
        std::thread::spawn(move || {
            loop {
                let event = unsafe { (api.wait_event)(events as *mut c_void, -1.0) };
                if !event.is_null() && unsafe { *event } == MPV_EVENT_SHUTDOWN {
                    break;
                }
            }
            let handle = watcher.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
            if let Some(handle) = handle {
                unsafe { (api.destroy)(handle.0) };
            }
        });
        Ok(Self { api, alive })
    }

    pub fn exited(&self) -> bool {
        self.alive.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_none()
    }

    /// Asks the core to quit and waits briefly for it to tear down. Bounded,
    /// because teardown hops to the main thread, which may be the caller.
    pub fn terminate(&mut self) {
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
