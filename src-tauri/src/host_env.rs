//! Running as an AppImage, Finplay's environment points library, GTK, GIO
//! and PATH lookups into the AppImage mount. Programs Finplay starts from the
//! host (mpv) must not inherit that, or the host's libraries get mixed with
//! the AppImage's older copies and fail to load.

use std::ffi::OsString;
use std::process::Command;

fn inside_appimage(entry: &str, appdir: Option<&str>) -> bool {
    entry.contains("/.mount_") || appdir.is_some_and(|dir| !dir.is_empty() && entry.starts_with(dir))
}

pub fn use_host_environment(command: &mut Command) {
    if std::env::var_os("APPIMAGE").is_none() && std::env::var_os("APPDIR").is_none() {
        return;
    }
    let appdir = std::env::var("APPDIR").ok();
    for name in ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "PYTHONHOME", "GTK_DATA_PREFIX", "GTK_EXE_PREFIX"] {
        command.env_remove(name);
    }
    for (name, value) in std::env::vars_os() {
        let Some(text) = value.to_str() else { continue };
        if !inside_appimage(text, appdir.as_deref()) && !text.split(':').any(|entry| inside_appimage(entry, appdir.as_deref())) {
            continue;
        }
        let kept: Vec<&str> = text
            .split(':')
            .filter(|entry| !entry.is_empty() && !inside_appimage(entry, appdir.as_deref()))
            .collect();
        if kept.is_empty() {
            command.env_remove(&name);
        } else {
            command.env(&name, OsString::from(kept.join(":")));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
}
