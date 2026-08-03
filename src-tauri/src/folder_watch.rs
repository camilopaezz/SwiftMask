//! Optional top-level folder watch (create / rename-into-place, settled files).
//! 500ms size-stable settle, ignore temps/dotfiles/non-images.
//!
//! Event policy: start a settle task on:
//! - `EventKind::Create` (direct write / copy create)
//! - rename-into-place (`Modify(Name(To|Both|Any))`) — file managers and atomic
//!   save patterns use rename, which on Linux notify is **not** a Create
//!
//! We intentionally do not spawn on `Modify(Data)`, to avoid reprocessing and
//! unbounded settle tasks on write churn. Size growth for an already-settling
//! path is observed by the settle poll.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
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

/// Events that indicate a new top-level path may have appeared.
fn is_arrival_event(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(_) | EventKind::Any => true,
        EventKind::Modify(ModifyKind::Name(mode)) => matches!(
            mode,
            RenameMode::To | RenameMode::Both | RenameMode::Any
        ),
        _ => false,
    }
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
                    // Empty files are not ready — keep waiting for content (or deadline).
                    // Exiting on stable zero drops create-then-write races where the first
                    // Create arrives at size 0 and content lands just after settle.
                    if b == 0 {
                        continue;
                    }
                    if Instant::now().duration_since(stable_since) >= settle {
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
    // Strip trailing separators so parent() of child paths matches the watched dir.
    let trimmed = folder.trim_end_matches(['/', '\\']);
    let folder_path = PathBuf::from(if trimmed.is_empty() { &folder } else { trimmed });
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
        if !is_arrival_event(&event.kind) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, EventKind, ModifyKind, RenameMode};

    #[test]
    fn arrival_events_include_create_and_rename_into_place() {
        assert!(is_arrival_event(&EventKind::Create(CreateKind::File)));
        assert!(is_arrival_event(&EventKind::Create(CreateKind::Any)));
        assert!(is_arrival_event(&EventKind::Modify(ModifyKind::Name(
            RenameMode::To
        ))));
        assert!(is_arrival_event(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Both
        ))));
        assert!(is_arrival_event(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Any
        ))));
        assert!(is_arrival_event(&EventKind::Any));
    }

    #[test]
    fn arrival_events_exclude_data_modify_and_rename_from() {
        assert!(!is_arrival_event(&EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Any
        ))));
        assert!(!is_arrival_event(&EventKind::Modify(ModifyKind::Name(
            RenameMode::From
        ))));
        assert!(!is_arrival_event(&EventKind::Access(
            notify::event::AccessKind::Close(notify::event::AccessMode::Write)
        )));
        assert!(!is_arrival_event(&EventKind::Remove(
            notify::event::RemoveKind::File
        )));
    }

    #[test]
    fn should_consider_top_level_images_only() {
        let folder = PathBuf::from("/tmp/watched");
        assert!(should_consider(
            &folder.join("shot.png"),
            &folder
        ));
        assert!(should_consider(
            &folder.join("photo.JPEG"),
            &folder
        ));
        assert!(!should_consider(
            &folder.join("nested").join("shot.png"),
            &folder
        ));
        assert!(!should_consider(&folder.join("notes.txt"), &folder));
        assert!(!should_consider(&folder.join(".hidden.png"), &folder));
        assert!(!should_consider(&folder.join("shot.png.tmp"), &folder));
        assert!(!should_consider(&folder.join("shot.crdownload"), &folder));
    }
}
