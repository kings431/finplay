//! The NHL's public schedule for Live TV's Hockey tab. The page can't ask for
//! it itself: the API sends no CORS headers.

use std::io::Read;
use std::time::Duration;

/// The week of games starting at `date` (YYYY-MM-DD), as the API's own JSON.
#[tauri::command]
pub async fn sports_schedule(date: String) -> Result<String, String> {
    let shaped = date.len() == 10
        && date
            .bytes()
            .enumerate()
            .all(|(at, byte)| if at == 4 || at == 7 { byte == b'-' } else { byte.is_ascii_digit() });
    if !shaped {
        return Err("That is not a date.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
        let response = agent
            .get(&format!("https://api-web.nhle.com/v1/schedule/{date}"))
            .call()
            .map_err(|err| format!("Could not load the schedule ({err})."))?;
        let mut body = String::new();
        response
            .into_reader()
            .take(4 * 1024 * 1024)
            .read_to_string(&mut body)
            .map_err(|err| format!("Could not read the schedule ({err})."))?;
        Ok(body)
    })
    .await
    .map_err(|err| err.to_string())?
}
