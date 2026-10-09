//! Keeps the screen on and the machine awake while something is playing.
//!
//! mpv inhibits the screensaver itself on Windows and macOS, but when it is
//! embedded through XWayland its request never reaches a Wayland desktop, so
//! on Linux the app asks the session's ScreenSaver and PowerManagement
//! services directly.

use std::sync::mpsc::{self, Sender};

pub struct KeepAwake {
    tx: Sender<bool>,
}

impl KeepAwake {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<bool>();
        std::thread::spawn(move || {
            let mut inhibitor = Inhibitor::default();
            while let Ok(on) = rx.recv() {
                if on {
                    inhibitor.inhibit();
                } else {
                    inhibitor.release();
                }
            }
            inhibitor.release();
        });
        Self { tx }
    }

    pub fn set(&self, on: bool) {
        let _ = self.tx.send(on);
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct Inhibitor {
    connection: Option<dbus::blocking::Connection>,
    cookies: Vec<(&'static str, &'static str, u32)>,
}

#[cfg(target_os = "linux")]
const SERVICES: [(&str, &str); 2] = [
    ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver"),
    ("org.freedesktop.PowerManagement.Inhibit", "/org/freedesktop/PowerManagement/Inhibit"),
];

#[cfg(target_os = "linux")]
impl Inhibitor {
    fn inhibit(&mut self) {
        if !self.cookies.is_empty() {
            return;
        }
        if self.connection.is_none() {
            self.connection = dbus::blocking::Connection::new_session().ok();
        }
        let Some(connection) = &self.connection else { return };
        for (service, path) in SERVICES {
            let proxy = connection.with_proxy(service, path, std::time::Duration::from_secs(2));
            let reply: Result<(u32,), dbus::Error> = proxy.method_call(service, "Inhibit", ("Finplay", "Playing video"));
            if let Ok((cookie,)) = reply {
                self.cookies.push((service, path, cookie));
            }
        }
    }

    fn release(&mut self) {
        let Some(connection) = &self.connection else { return };
        for (service, path, cookie) in self.cookies.drain(..) {
            let proxy = connection.with_proxy(service, path, std::time::Duration::from_secs(2));
            let _: Result<(), dbus::Error> = proxy.method_call(service, "UnInhibit", (cookie,));
        }
    }
}

#[cfg(not(target_os = "linux"))]
#[derive(Default)]
struct Inhibitor;

#[cfg(not(target_os = "linux"))]
impl Inhibitor {
    fn inhibit(&mut self) {}
    fn release(&mut self) {}
}
