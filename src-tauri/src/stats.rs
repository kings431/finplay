//! Opens the Streamystats dashboard in its own window. The window loads a
//! remote site, so it is deliberately left out of every capability and gets
//! no access to Finplay's commands.

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "stats";

#[tauri::command]
pub async fn open_stats(app: AppHandle, url: String) -> Result<(), String> {
    let target = Url::parse(url.trim()).map_err(|_| "That Streamystats address is not valid.".to_string())?;
    if !matches!(target.scheme(), "http" | "https") || target.host_str().is_none() {
        return Err("The Streamystats address needs to start with http:// or https://".into());
    }

    if let Some(window) = app.get_webview_window(LABEL) {
        let same_site = window.url().map(|current| current.origin() == target.origin()).unwrap_or(false);
        if !same_site {
            window.navigate(target).map_err(|err| format!("Could not open Streamystats ({err})."))?;
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(target))
        .title("Streamystats")
        .inner_size(1320.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|err| format!("Could not open Streamystats ({err})."))?;
    Ok(())
}
