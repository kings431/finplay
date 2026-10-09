#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // These only take effect if present at process start, so re-exec once.
    // WEBKIT_DISABLE_DMABUF_RENDERER: WebKitGTK on Wayland with the NVIDIA
    // driver otherwise dies with Gdk "Error 71 (Protocol error)".
    // GDK_BACKEND=x11: mpv can only draw inside our window (--wid) through
    // X11; Wayland does not let one client host another's surface.
    #[cfg(target_os = "linux")]
    if std::env::var_os("FINPLAY_REEXEC").is_none() {
        use std::os::unix::process::CommandExt;
        if let Ok(exe) = std::env::current_exe() {
            let mut command = std::process::Command::new(exe);
            command
                .args(std::env::args_os().skip(1))
                .env("FINPLAY_REEXEC", "1");
            if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                command.env("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
            if std::env::var_os("GDK_BACKEND").is_none() && std::env::var_os("DISPLAY").is_some() {
                command.env("GDK_BACKEND", "x11");
            }
            let err = command.exec();
            eprintln!("Finplay could not restart with its display settings: {err}");
        }
    }
    finplay_lib::run()
}
