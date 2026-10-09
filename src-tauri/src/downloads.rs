//! Offline downloads. Each item gets a folder in the app data directory and
//! an entry in a JSON manifest, so the app can list and play them with no
//! server. Stream addresses carry the access token, so they stay in memory
//! and are never written to the manifest.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    item: Value,
    quality: String,
    file: String,
    state: String,
    received: u64,
    total: u64,
    #[serde(default)]
    error: String,
    added: u64,
    #[serde(default)]
    position: f64,
    #[serde(default)]
    position_dirty: bool,
    #[serde(default)]
    played: bool,
    #[serde(default)]
    images: HashMap<String, String>,
    #[serde(default, skip_deserializing)]
    folder: String,
}

#[derive(Deserialize, Clone)]
pub struct ImageRequest {
    kind: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    id: String,
    item: Value,
    quality: String,
    url: String,
    extension: String,
    #[serde(default)]
    images: Vec<ImageRequest>,
    #[serde(default)]
    expected_size: u64,
    #[serde(default)]
    resumable: bool,
}

struct Job {
    url: String,
    images: Vec<ImageRequest>,
    resumable: bool,
    cancel: Arc<AtomicBool>,
}

struct Store {
    entries: Vec<Entry>,
    jobs: HashMap<String, Job>,
}

struct Inner {
    dir: PathBuf,
    store: Mutex<Store>,
}

pub struct Downloads {
    inner: Arc<Inner>,
    queue: Sender<String>,
}

fn valid_id(id: &str) -> bool {
    (32..=36).contains(&id.len()) && id.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

fn http(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://")) && !url.chars().any(|ch| ch.is_control())
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, store: &Store) {
        if let Ok(bytes) = serde_json::to_vec_pretty(&store.entries) {
            let temp = self.dir.join("downloads.json.tmp");
            if fs::write(&temp, bytes).is_ok() {
                let _ = fs::rename(temp, self.dir.join("downloads.json"));
            }
        }
    }

    fn view(&self, entry: &Entry) -> Entry {
        let mut entry = entry.clone();
        entry.folder = self.dir.join(&entry.id).to_string_lossy().into_owned();
        entry
    }

    fn emit(&self, app: &AppHandle, id: &str) {
        let snapshot = self.lock().entries.iter().find(|entry| entry.id == id).map(|entry| self.view(entry));
        let _ = app.emit("download", snapshot.unwrap_or_else(|| removed(id)));
    }

    fn progress(&self, app: &AppHandle, id: &str, received: u64, total: u64) {
        {
            let mut store = self.lock();
            if let Some(entry) = store.entries.iter_mut().find(|entry| entry.id == id) {
                entry.received = received;
                if total > 0 {
                    entry.total = total;
                }
            }
        }
        self.emit(app, id);
    }

    fn run(&self, app: &AppHandle, id: &str) {
        let (job, file) = {
            let mut store = self.lock();
            let Some(job) = store.jobs.get(id) else { return };
            if job.cancel.load(Ordering::SeqCst) {
                return;
            }
            let job = Job {
                url: job.url.clone(),
                images: job.images.clone(),
                resumable: job.resumable,
                cancel: Arc::clone(&job.cancel),
            };
            let Some(entry) = store.entries.iter_mut().find(|entry| entry.id == id) else { return };
            entry.state = "downloading".into();
            entry.error.clear();
            let file = entry.file.clone();
            self.save(&store);
            (job, file)
        };
        self.emit(app, id);

        let folder = self.dir.join(id);
        let _ = fs::create_dir_all(&folder);
        let mut images = HashMap::new();
        for image in &job.images {
            let name = format!("{}.jpg", image.kind);
            if fetch_small(&image.url, &folder.join(&name)).is_ok() {
                images.insert(image.kind.clone(), name);
            }
        }
        let part = folder.join(format!("{file}.part"));
        let result = self.fetch_media(app, id, &job, &part);

        let mut store = self.lock();
        store.jobs.remove(id);
        let cancelled = job.cancel.load(Ordering::SeqCst);
        let Some(entry) = store.entries.iter_mut().find(|entry| entry.id == id) else {
            drop(store);
            let _ = fs::remove_dir_all(&folder);
            return;
        };
        if cancelled {
            return;
        }
        entry.images = images;
        match result.and_then(|size| {
            fs::rename(&part, folder.join(&file))
                .map(|_| size)
                .map_err(|err| format!("Could not finish the file: {err}"))
        }) {
            Ok(size) => {
                entry.state = "done".into();
                entry.received = size;
                entry.total = size;
            }
            Err(message) => {
                entry.state = "failed".into();
                entry.error = message;
            }
        }
        self.save(&store);
        drop(store);
        self.emit(app, id);
    }

    fn fetch_media(&self, app: &AppHandle, id: &str, job: &Job, part: &Path) -> Result<u64, String> {
        let existing = if job.resumable {
            fs::metadata(part).map(|meta| meta.len()).unwrap_or(0)
        } else {
            let _ = fs::remove_file(part);
            0
        };
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(180))
            .user_agent("Finplay/0.1.0")
            .build();
        let mut request = agent.get(&job.url);
        if existing > 0 {
            request = request.set("Range", &format!("bytes={existing}-"));
        }
        // Errors are described by kind only: their text would include the
        // address, and the address includes the access token.
        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(401, _)) => {
                return Err("The server did not accept this sign-in for downloads. Try again, or sign out and back in.".into())
            }
            Err(ureq::Error::Status(403, _)) => {
                return Err("Your Jellyfin account is not allowed to download media. Turn on \"Allow media downloading\" for your user in the server dashboard.".into())
            }
            Err(ureq::Error::Status(404, _)) => return Err("The server could not find this file.".into()),
            Err(ureq::Error::Status(code, _)) => return Err(format!("The server returned {code}.")),
            Err(err) => return Err(format!("Could not reach the server ({}).", err.kind())),
        };
        let append = existing > 0 && response.status() == 206;
        let length: u64 = response.header("Content-Length").and_then(|value| value.parse().ok()).unwrap_or(0);
        let mut received = if append { existing } else { 0 };
        let total = if length > 0 { length + received } else { 0 };
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(part)
            .map_err(|err| format!("Could not write the file: {err}"))?;
        let mut reader = response.into_reader();
        let mut buffer = vec![0u8; 256 * 1024];
        let mut last = Instant::now();
        loop {
            if job.cancel.load(Ordering::Relaxed) {
                return Err("Cancelled.".into());
            }
            let count = reader
                .read(&mut buffer)
                .map_err(|_| "The connection dropped. Retry to continue.".to_string())?;
            if count == 0 {
                break;
            }
            file.write_all(&buffer[..count]).map_err(|err| format!("Could not write the file: {err}"))?;
            received += count as u64;
            if last.elapsed() >= Duration::from_millis(400) {
                last = Instant::now();
                self.progress(app, id, received, total);
            }
        }
        file.flush().map_err(|err| format!("Could not write the file: {err}"))?;
        if total > 0 && received < total {
            return Err("The download ended early. Retry to continue.".into());
        }
        if received == 0 {
            return Err("The server sent an empty file.".into());
        }
        Ok(received)
    }
}

fn removed(id: &str) -> Entry {
    Entry {
        id: id.to_string(),
        item: Value::Null,
        quality: String::new(),
        file: String::new(),
        state: "removed".into(),
        received: 0,
        total: 0,
        error: String::new(),
        added: 0,
        position: 0.0,
        position_dirty: false,
        played: false,
        images: HashMap::new(),
        folder: String::new(),
    }
}

fn fetch_small(url: &str, path: &Path) -> Result<(), ()> {
    let response = ureq::get(url).timeout(Duration::from_secs(20)).call().map_err(|_| ())?;
    let mut bytes = Vec::new();
    response.into_reader().take(20 * 1024 * 1024).read_to_end(&mut bytes).map_err(|_| ())?;
    fs::write(path, bytes).map_err(|_| ())
}

impl Downloads {
    pub fn new(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("finplay"))
            .join("downloads");
        let _ = fs::create_dir_all(&dir);
        let mut entries: Vec<Entry> = fs::read(dir.join("downloads.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        entries.retain(|entry| valid_id(&entry.id));
        for entry in &mut entries {
            if entry.state == "queued" || entry.state == "downloading" {
                entry.state = "failed".into();
                entry.error = "Interrupted. Retry to continue.".into();
            }
        }
        let inner = Arc::new(Inner { dir, store: Mutex::new(Store { entries, jobs: HashMap::new() }) });
        inner.save(&inner.lock());
        let (queue, jobs) = mpsc::channel::<String>();
        let worker = Arc::clone(&inner);
        let app = app.clone();
        thread::spawn(move || {
            while let Ok(id) = jobs.recv() {
                worker.run(&app, &id);
            }
        });
        Self { inner, queue }
    }

    /// The finished file for an item, if it is downloaded.
    pub fn media_path(&self, id: &str) -> Option<PathBuf> {
        let store = self.inner.lock();
        let entry = store.entries.iter().find(|entry| entry.id == id && entry.state == "done")?;
        let path = self.inner.dir.join(&entry.id).join(&entry.file);
        path.is_file().then_some(path)
    }

    fn remove(&self, id: &str) {
        let mut store = self.inner.lock();
        if let Some(job) = store.jobs.remove(id) {
            job.cancel.store(true, Ordering::SeqCst);
        }
        store.entries.retain(|entry| entry.id != id);
        self.inner.save(&store);
        drop(store);
        let _ = fs::remove_dir_all(self.inner.dir.join(id));
    }
}

#[tauri::command]
pub fn download_list(state: State<'_, Downloads>) -> Vec<Entry> {
    let store = state.inner.lock();
    store.entries.iter().map(|entry| state.inner.view(entry)).collect()
}

#[tauri::command]
pub fn download_dir(state: State<'_, Downloads>) -> String {
    state.inner.dir.to_string_lossy().into_owned()
}

#[tauri::command]
pub fn download_start(app: AppHandle, state: State<'_, Downloads>, request: StartRequest) -> Result<(), String> {
    if !valid_id(&request.id) {
        return Err("That item id is not valid.".into());
    }
    if !http(&request.url) {
        return Err("Refusing to download from an address that is not http or https.".into());
    }
    if request.extension.is_empty() || request.extension.len() > 5 || !request.extension.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return Err("That file type is not supported.".into());
    }
    let images: Vec<ImageRequest> = request
        .images
        .into_iter()
        .filter(|image| {
            !image.kind.is_empty() && image.kind.len() <= 12 && image.kind.chars().all(|ch| ch.is_ascii_alphanumeric()) && http(&image.url)
        })
        .collect();
    let file = format!("media.{}", request.extension.to_ascii_lowercase());
    let quality: String = request.quality.chars().filter(|ch| !ch.is_control()).take(24).collect();
    {
        let mut store = state.inner.lock();
        let previous = store.entries.iter().find(|entry| entry.id == request.id);
        let resumable = match previous {
            Some(entry) if entry.state == "queued" || entry.state == "downloading" => {
                return Err("This is already downloading.".into())
            }
            Some(entry) if entry.state == "done" => return Err("This is already downloaded.".into()),
            Some(entry) => request.resumable && entry.file == file && entry.quality == quality,
            None => false,
        };
        let received = if resumable {
            fs::metadata(state.inner.dir.join(&request.id).join(format!("{file}.part"))).map(|meta| meta.len()).unwrap_or(0)
        } else {
            0
        };
        let (position, played) = previous.map(|entry| (entry.position, entry.played)).unwrap_or((0.0, false));
        store.entries.retain(|entry| entry.id != request.id);
        store.entries.push(Entry {
            id: request.id.clone(),
            item: request.item,
            quality,
            file,
            state: "queued".into(),
            received,
            total: request.expected_size,
            error: String::new(),
            added: unix_now(),
            position,
            position_dirty: false,
            played,
            images: HashMap::new(),
            folder: String::new(),
        });
        store.jobs.insert(
            request.id.clone(),
            Job { url: request.url, images, resumable, cancel: Arc::new(AtomicBool::new(false)) },
        );
        state.inner.save(&store);
    }
    state.inner.emit(&app, &request.id);
    state.queue.send(request.id).map_err(|_| "The download queue stopped.".to_string())
}

#[tauri::command]
pub fn download_delete(app: AppHandle, state: State<'_, Downloads>, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("That item id is not valid.".into());
    }
    state.remove(&id);
    state.inner.emit(&app, &id);
    Ok(())
}

/// Remembers where offline playback stopped. `dirty` marks progress the
/// server has not heard about yet.
#[tauri::command]
pub fn download_progress(state: State<'_, Downloads>, id: String, position: f64, played: bool, dirty: bool) {
    let mut store = state.inner.lock();
    if let Some(entry) = store.entries.iter_mut().find(|entry| entry.id == id) {
        entry.position = position.max(0.0);
        entry.played = played;
        entry.position_dirty = dirty;
        state.inner.save(&store);
    }
}
