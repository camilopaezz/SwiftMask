use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use clipboard_rs::{
    common::{ContentFormat, RustImage},
    Clipboard, ClipboardContext,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{image_decode_error, output_write_error, AppError};

static NEXT_IMPORT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardImportKind {
    Files,
    Pixels,
}

#[derive(Debug, Serialize)]
pub struct ClipboardImport {
    pub paths: Vec<String>,
    pub kind: ClipboardImportKind,
    pub default_output_dir: Option<String>,
}

pub fn session_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("clipboard-imports"))
        .map_err(|error| AppError::OutputFailed(error.to_string()))
}

/// Remove clipboard pixel snapshots from a previous or current app session.
/// Call at startup and on process exit; failures are best-effort cleanup only.
pub fn cleanup_session(app: &AppHandle) {
    if let Ok(dir) = session_dir(app) {
        if let Err(error) = std::fs::remove_dir_all(dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not clean clipboard import files: {error}");
            }
        }
    }
}

pub async fn import(app: AppHandle) -> Result<ClipboardImport, AppError> {
    tauri::async_runtime::spawn_blocking(move || import_blocking(&app))
        .await
        .map_err(|error| AppError::Dialog(format!("clipboard import worker failed: {error}")))?
}

fn import_blocking(app: &AppHandle) -> Result<ClipboardImport, AppError> {
    // Clipboard access can block while the OS transfers data (especially X11).
    let context = ClipboardContext::new()
        .map_err(|error| AppError::Dialog(format!("could not open clipboard: {error}")))?;
    if let Some(files) = clipboard_file_list(&context)? {
        let image_files = files
            .into_iter()
            .filter_map(|file| clipboard_file_path(&file))
            .filter(|path| is_supported_image_path(path))
            .collect::<Vec<_>>();
        if !image_files.is_empty() {
            // Match picker/drop behavior for batches: enqueue paths promptly and let
            // each queue item report its own decode failure during processing.
            // A single pasted file is validated now so an unreadable image gets
            // immediate feedback instead of an empty preview.
            if image_files.len() == 1 {
                let path = &image_files[0];
                if !path.is_file() {
                    return Err(image_decode_error(format!(
                        "copied image file does not exist: {}",
                        path.display()
                    )));
                }
                image::ImageReader::open(path)
                    .and_then(|reader| reader.with_guessed_format())
                    .map_err(|error| image_decode_error(format!("{}: {error}", path.display())))?
                    .decode()
                    .map_err(|error| image_decode_error(format!("{}: {error}", path.display())))?;
            }
            let paths = image_files
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            return Ok(ClipboardImport {
                paths,
                kind: ClipboardImportKind::Files,
                default_output_dir: None,
            });
        }
    }

    if !context.has(ContentFormat::Image) {
        return Ok(empty_import());
    }

    let image = context
        .get_image()
        .map_err(|error| image_decode_error(format!("could not read clipboard image: {error}")))?;
    let dir = session_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(output_write_error)?;
    let id = NEXT_IMPORT_ID.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("pasted-image-{}-{id}.png", std::process::id()));
    image
        .save_to_path(&path.to_string_lossy())
        .map_err(|error| image_decode_error(format!("could not save clipboard image: {error}")))?;

    let output_dir = app
        .path()
        .picture_dir()
        .map_err(|error| AppError::OutputFailed(error.to_string()))?
        .join("SwiftMask");
    Ok(ClipboardImport {
        paths: vec![path.to_string_lossy().into_owned()],
        kind: ClipboardImportKind::Pixels,
        default_output_dir: Some(output_dir.to_string_lossy().into_owned()),
    })
}

fn clipboard_file_list(context: &ClipboardContext) -> Result<Option<Vec<String>>, AppError> {
    if context.has(ContentFormat::Files) {
        return context
            .get_files()
            .map(Some)
            .map_err(|error| image_decode_error(format!("could not read copied files: {error}")));
    }

    // GNOME and some GTK file managers additionally expose this format, with
    // a leading `copy` or `cut` line followed by file:// URIs. clipboard-rs's
    // generic Files format maps text/uri-list, so handle this Linux MIME too.
    #[cfg(target_os = "linux")]
    {
        const GNOME_FILES_MIME: &str = "x-special/gnome-copied-files";
        if context
            .available_formats()
            .map(|formats| formats.iter().any(|format| format == GNOME_FILES_MIME))
            .unwrap_or(false)
        {
            let buffer = context.get_buffer(GNOME_FILES_MIME).map_err(|error| {
                image_decode_error(format!("could not read copied files: {error}"))
            })?;
            let text = String::from_utf8(buffer).map_err(|error| {
                image_decode_error(format!("invalid copied file list: {error}"))
            })?;
            let files = text
                .lines()
                .map(|line| line.trim_end_matches('\r'))
                .skip_while(|line| matches!(line.trim(), "copy" | "cut"))
                .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
                .map(|line| line.trim().to_string())
                .collect();
            return Ok(Some(files));
        }
    }

    Ok(None)
}

fn empty_import() -> ClipboardImport {
    ClipboardImport {
        paths: Vec::new(),
        kind: ClipboardImportKind::Files,
        default_output_dir: None,
    }
}

fn is_supported_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "bmp")
    )
}

fn clipboard_file_path(file: &str) -> Option<PathBuf> {
    if file.starts_with("file:") {
        url::Url::parse(file).ok()?.to_file_path().ok()
    } else if file.contains("://") {
        None
    } else {
        Some(PathBuf::from(file))
    }
}

#[cfg(test)]
mod tests {
    use super::{clipboard_file_path, is_supported_image_path};
    use std::path::{Path, PathBuf};

    #[test]
    fn decodes_file_uri_paths() {
        assert_eq!(
            clipboard_file_path("file:///tmp/my%20image.PNG"),
            Some(PathBuf::from("/tmp/my image.PNG"))
        );
        assert_eq!(clipboard_file_path("https://example.com/image.png"), None);
    }

    #[test]
    fn accepts_supported_image_extensions_case_insensitively() {
        for path in [
            "image.png",
            "photo.JPG",
            "photo.jpeg",
            "image.webp",
            "image.bmp",
        ] {
            assert!(is_supported_image_path(Path::new(path)), "{path}");
        }
        for path in ["document.txt", "image.tiff", "no-extension"] {
            assert!(!is_supported_image_path(Path::new(path)), "{path}");
        }
    }
}
