//! Optional top-level folder watch for batch 1.1 CP5.
//! Create-only, 500ms size-stable settle, ignore temps/dotfiles/non-images.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;

const SETTLE_MS: u64 = 500;
const POLL_MS: u64 = 100;
const EVENT_READY: &str = "folder:ready";

#[derive(Clone, serde::Serialize)]
struct FolderReadyPayload {
    path: String,
}

struct WatchInner {
    _watcher: RecommendedWatcher,
}

pub struct FolderWatchState {
    inner: Mutex<Option<WatchInner>>,
}

impl FolderWatchState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

fn is_image_path(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "bmp"
    )
}

fn is_junk_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with('.') {
        return true;
    }
    lower.ends_with(".tmp")
        || lower.ends_with(".temp")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".part")
        || lower.ends_with(".partial")
        || lower.ends_with('~')
        || lower == "thumbs.db"
        || lower == "desktop.ini"
}

fn should_consider(path: &Path, folder: &Path) -> bool {
    if path.parent() != Some(folder) {
        return false;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if is_junk_name(name) {
        return false;
    }
    is_image_path(path)
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// Spawn settle loop for one path; emits `folder:ready` when size stable 500ms and non-zero.
fn spawn_settle(app: AppHandle, path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let settle = Duration::from_millis(SETTLE_MS);
        let poll = Duration::from_millis(POLL_MS);
        let mut last_size = file_size(&path);
        let mut stable_since = Instant::now();
        let deadline = Instant::now() + Duration::from_secs(120);

        while Instant::now() < deadline {
            tokio::time::sleep(poll).await;
            let size = file_size(&path);
            match (last_size, size) {
                (_, None) => {
                    // vanished
                    return;
                }
                (Some(a), Some(b)) if a == b => {
                    if Instant::now().duration_since(stable_since) >= settle {
                        if b == 0 {
                            return;
                        }
                        let _ = app.emit(
                            EVENT_READY,
                            FolderReadyPayload {
                                path: path.to_string_lossy().into_owned(),
                            },
                        );
                        return;
                    }
                }
                _ => {
                    last_size = size;
                    stable_since = Instant::now();
                }
            }
        }
    });
}

pub fn start_watch(app: AppHandle, folder: String) -> Result<(), AppError> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err(AppError::Dialog(format!("not a directory: {folder}")));
    }

    let state = app.state::<Arc<FolderWatchState>>();
    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());

    // Replace existing watch.
    *guard = None;

    let app_handle = app.clone();
    let folder_for_cb = folder_path.clone();
    let pending: Arc<Mutex<HashMap<PathBuf, Instant>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_cb = Arc::clone(&pending);

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let Ok(event) = res else {
            return;
        };
        // Create / rename-into-place / modify (copy completion)
        let interesting = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
        );
        if !interesting {
            return;
        }
        for path in event.paths {
            if !should_consider(&path, &folder_for_cb) {
                continue;
            }
            {
                let mut p = pending_cb.lock().unwrap_or_else(|e| e.into_inner());
                let now = Instant::now();
                if let Some(last) = p.get(&path) {
                    if now.duration_since(*last) < Duration::from_millis(200) {
                        continue;
                    }
                }
                p.insert(path.clone(), now);
            }
            spawn_settle(app_handle.clone(), path);
        }
    })
    .map_err(|e| AppError::Dialog(format!("watch failed: {e}")))?;

    watcher
        .watch(&folder_path, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Dialog(format!("watch failed: {e}")))?;

    *guard = Some(WatchInner {
        _watcher: watcher,
    });
    Ok(())
}

pub fn stop_watch(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<FolderWatchState>>() {
        let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
}
