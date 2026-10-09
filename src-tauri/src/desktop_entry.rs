//! Wayland desktops only show a window's icon when a .desktop file matches
//! its app id, and an AppImage installs none. So when running as an AppImage,
//! Finplay writes its own launcher entry and icon, pointing at wherever the
//! AppImage currently lives (it moves on update or when the user moves it).

#[cfg(target_os = "linux")]
pub fn install() {
    let Some(appimage) = std::env::var_os("APPIMAGE") else { return };
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return };
    let data = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
    let icon = data.join("icons/hicolor/512x512/apps/finplay.png");
    let entry = data.join("applications/finplay.desktop");

    if !icon.is_file() {
        if let Some(dir) = icon.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&icon, include_bytes!("../icons/icon.png"));
    }

    let exec = appimage.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let contents = format!(
        "[Desktop Entry]\nType=Application\nName=Finplay\nComment=Jellyfin client that plays through mpv\nExec=\"{exec}\" %U\nIcon={}\nCategories=AudioVideo;Video;Player;\nTerminal=false\nStartupWMClass=finplay\n",
        icon.display()
    );
    if std::fs::read_to_string(&entry).ok().as_deref() != Some(contents.as_str()) {
        if let Some(dir) = entry.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&entry, contents);
    }
}

#[cfg(not(target_os = "linux"))]
pub fn install() {}
