mod awake;
mod desktop_entry;
mod downloads;
mod host_env;
#[cfg(target_os = "macos")]
mod libmpv;
mod mpris;
mod mpv;
mod stats;
mod trailer;

use downloads::{download_delete, download_dir, download_list, download_progress, download_start};
use mpv::{player_play, player_request, player_stop, player_thumb, PlayerState};
use stats::open_stats;
use trailer::play_trailer;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            std::thread::spawn(desktop_entry::install);
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
                    if let Some(settings) = WebViewExt::settings(&webview.inner()) {
                        settings.set_enable_smooth_scrolling(true);
                        settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Always);
                    }
                });
            }
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(|event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                    ) {
                        libmpv::follow_host();
                    }
                });
            }
            let handle = app.handle().clone();
            app.manage(mpris::Mpris::start(move |control| mpv::control(&handle, control)));
            app.manage(downloads::Downloads::new(app.handle()));
            Ok(())
        })
        .manage(PlayerState::new())
        .invoke_handler(tauri::generate_handler![
            player_play,
            player_request,
            player_stop,
            player_thumb,
            download_list,
            download_dir,
            download_start,
            download_delete,
            download_progress,
            open_stats,
            play_trailer
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Finplay")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<PlayerState>() {
                    state.shutdown();
                }
            }
        });
}
