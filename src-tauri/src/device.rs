//! The name other Jellyfin apps see for this computer in "Play on" lists.

/// The computer's name as the user set it, or an empty string.
#[tauri::command]
pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    let name = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok());
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(all(unix, not(target_os = "macos")))]
    let name = std::fs::read_to_string("/etc/hostname").ok();
    name.unwrap_or_default().trim().to_string()
}
