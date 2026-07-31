//! Optional top-level folder watch for batch 1.1 CP5.
//! Create-only, 500ms size-stable settle, ignore temps/dotfiles/non-images.
//!
//! Event policy: only `EventKind::Create` starts a settle task. Rename-into-place
//! and copy completion typically surface as Create (or Create then size growth
//! that the settle poll observes). We intentionally do not spawn on Modify, to
//! avoid reprocessing and unbounded settle tasks on write churn.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// Paths with an in-flight settle task (one per path).
    settling: Arc<Mutex<HashSet<PathBuf>>>,
    /// Bumped on stop so in-flight settles do not emit.
    generation: Arc<AtomicU64>,
}

pub struct FolderWatchState {
    inner: Mutex<Option<WatchInner>>,
    /// Global generation (also bumped on start/stop for diagnostics / future use).
    generation: AtomicU64,
}

impl FolderWatchState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            generation: AtomicU64::new(0),
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
fn spawn_settle(
    app: AppHandle,
    path: PathBuf,
    settling: Arc<Mutex<HashSet<PathBuf>>>,
    generation: Arc<AtomicU64>,
    started_gen: u64,
) {
    tauri::async_runtime::spawn(async move {
        let settle = Duration::from_millis(SETTLE_MS);
        let poll = Duration::from_millis(POLL_MS);
        let mut last_size = file_size(&path);
        let mut stable_since = Instant::now();
        let deadline = Instant::now() + Duration::from_secs(120);

        let prune = || {
            settling
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&path);
        };

        while Instant::now() < deadline {
            if generation.load(Ordering::SeqCst) != started_gen {
                prune();
                return;
            }
            tokio::time::sleep(poll).await;
            if generation.load(Ordering::SeqCst) != started_gen {
                prune();
                return;
            }
            let size = file_size(&path);
            match (last_size, size) {
                (_, None) => {
                    // vanished
                    prune();
                    return;
                }
                (Some(a), Some(b)) if a == b => {
                    if Instant::now().duration_since(stable_since) >= settle {
                        if b == 0 {
                            prune();
                            return;
                        }
                        if generation.load(Ordering::SeqCst) != started_gen {
                            prune();
                            return;
                        }
                        let _ = app.emit(
                            EVENT_READY,
                            FolderReadyPayload {
                                path: path.to_string_lossy().into_owned(),
                            },
                        );
                        prune();
                        return;
                    }
                }
                _ => {
                    last_size = size;
                    stable_since = Instant::now();
                }
            }
        }
        prune();
    });
}

pub fn start_watch(app: AppHandle, folder: String) -> Result<(), AppError> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err(AppError::Dialog(format!("not a directory: {folder}")));
    }

    let state = app.state::<Arc<FolderWatchState>>();
    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());

    // Invalidate any previous in-flight settles.
    if let Some(prev) = guard.take() {
        prev.generation.fetch_add(1, Ordering::SeqCst);
        prev.settling
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let watch_gen = Arc::new(AtomicU64::new(gen));
    let settling: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));

    let app_handle = app.clone();
    let folder_for_cb = folder_path.clone();
    let settling_cb = Arc::clone(&settling);
    let watch_gen_cb = Arc::clone(&watch_gen);
    let gen_for_cb = gen;

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let Ok(event) = res else {
            return;
        };
        // Create-only: starts settle. Size growth is observed by the settle poll.
        // (Rename-into-place / atomic replace usually appear as Create on Linux/Windows.)
        if !matches!(event.kind, EventKind::Create(_)) {
            return;
        }
        for path in event.paths {
            if !should_consider(&path, &folder_for_cb) {
                continue;
            }
            {
                let mut s = settling_cb.lock().unwrap_or_else(|e| e.into_inner());
                if s.contains(&path) {
                    continue;
                }
                s.insert(path.clone());
            }
            spawn_settle(
                app_handle.clone(),
                path,
                Arc::clone(&settling_cb),
                Arc::clone(&watch_gen_cb),
                gen_for_cb,
            );
        }
    })
    .map_err(|e| AppError::Dialog(format!("watch failed: {e}")))?;

    watcher
        .watch(&folder_path, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Dialog(format!("watch failed: {e}")))?;

    *guard = Some(WatchInner {
        _watcher: watcher,
        settling,
        generation: watch_gen,
    });
    Ok(())
}

pub fn stop_watch(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<FolderWatchState>>() {
        state.generation.fetch_add(1, Ordering::SeqCst);
        let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(inner) = guard.take() {
            // Bump so in-flight settles exit without emit.
            inner.generation.fetch_add(1, Ordering::SeqCst);
            inner
                .settling
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        }
    }
}
