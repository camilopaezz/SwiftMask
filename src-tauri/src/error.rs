use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use thiserror::Error;

/// Stable wire codes for FE classification (`parseAppError` / `errorCopy` on the FE).
pub mod code {
    pub const CANCELLED: &str = "cancelled";
    pub const BUSY: &str = "busy";
    pub const DOWNLOAD_BUSY: &str = "download_busy";
    pub const NETWORK: &str = "network";
    pub const DISK_FULL: &str = "disk_full";
    pub const MODEL_CORRUPT: &str = "model_corrupt";
    pub const MODEL_NOT_READY: &str = "model_not_ready";
    pub const MODEL_UNKNOWN: &str = "model_unknown";
    pub const OOM: &str = "oom";
    pub const GPU: &str = "gpu";
    pub const IMAGE_UNREADABLE: &str = "image_unreadable";
    pub const OUTPUT_FAILED: &str = "output_failed";
    pub const CONFIG: &str = "config";
    pub const DIALOG: &str = "dialog";
    pub const INFERENCE_FAILED: &str = "inference_failed";
    pub const UNKNOWN: &str = "unknown";
}

/// Product error enum. Catalog codes are typed variants so [`error_code`] is a
/// pure match — do not re-parse free-form strings for classification.
///
/// Residual `Inference` / `Model` / `Pipeline` hold technical detail for cases
/// without a dedicated variant; they map to generic wire codes.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("cancelled")]
    Cancelled,
    #[error("already processing")]
    Busy,
    #[error("download already in progress")]
    DownloadBusy,
    #[error("network error: {0}")]
    Network(String),
    #[error("disk full: {0}")]
    DiskFull(String),
    #[error("model corrupt: {0}")]
    ModelCorrupt(String),
    #[error("model not ready: {0}")]
    ModelNotReady(String),
    #[error("unknown model: {0}")]
    ModelUnknown(String),
    #[error("out of memory: {0}")]
    Oom(String),
    #[error("gpu detection error: {0}")]
    Gpu(String),
    #[error("image unreadable: {0}")]
    ImageUnreadable(String),
    #[error("output failed: {0}")]
    OutputFailed(String),
    #[error("config error: {0}")]
    Config(String),
    #[error("dialog error: {0}")]
    Dialog(String),
    #[error("inference error: {0}")]
    Inference(String),
    #[error("model error: {0}")]
    Model(String),
    #[error("pipeline error: {0}")]
    Pipeline(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

/// Technical detail for the wire `message` field (no variant prefix).
pub fn error_message(err: &AppError) -> String {
    match err {
        AppError::Cancelled => "cancelled".into(),
        AppError::Busy => "already processing".into(),
        AppError::DownloadBusy => "download already in progress".into(),
        AppError::Io(e) => e.to_string(),
        AppError::Serde(e) => e.to_string(),
        AppError::Network(s)
        | AppError::DiskFull(s)
        | AppError::ModelCorrupt(s)
        | AppError::ModelNotReady(s)
        | AppError::ModelUnknown(s)
        | AppError::Oom(s)
        | AppError::Gpu(s)
        | AppError::ImageUnreadable(s)
        | AppError::OutputFailed(s)
        | AppError::Config(s)
        | AppError::Dialog(s)
        | AppError::Inference(s)
        | AppError::Model(s)
        | AppError::Pipeline(s) => s.clone(),
    }
}

/// Map an IO error into a model-path failure, tagging disk-full.
pub fn model_io_error(op: &str, e: std::io::Error) -> AppError {
    if is_storage_full(&e) {
        AppError::DiskFull(format!("disk full during {op}: {e}"))
    } else {
        AppError::Model(format!("{op} failed: {e}"))
    }
}

/// Decode/open failures → wire code [`code::IMAGE_UNREADABLE`].
pub fn image_decode_error(detail: impl Into<String>) -> AppError {
    AppError::ImageUnreadable(detail.into())
}

/// Encode failures → wire code [`code::OUTPUT_FAILED`].
pub fn image_encode_error(detail: impl Into<String>) -> AppError {
    AppError::OutputFailed(detail.into())
}

/// Output-path write failures → `disk_full` when full, else [`code::OUTPUT_FAILED`].
pub fn output_write_error(e: std::io::Error) -> AppError {
    if is_storage_full(&e) {
        AppError::DiskFull(e.to_string())
    } else {
        AppError::OutputFailed(format!("output write: {e}"))
    }
}

/// Config file IO → `disk_full` when full, else [`code::CONFIG`].
pub fn config_io_error(e: std::io::Error) -> AppError {
    if is_storage_full(&e) {
        AppError::DiskFull(e.to_string())
    } else {
        AppError::Config(e.to_string())
    }
}

/// Wrap an ORT/session failure; promote OOM via needle scan of the raw message.
pub fn inference_error(detail: impl Into<String>) -> AppError {
    let msg = detail.into();
    if looks_like_oom_message(&msg) {
        AppError::Oom(msg)
    } else {
        AppError::Inference(msg)
    }
}

pub fn network_error(detail: impl Into<String>) -> AppError {
    AppError::Network(detail.into())
}

pub fn model_corrupt(detail: impl Into<String>) -> AppError {
    AppError::ModelCorrupt(detail.into())
}

pub fn model_not_ready(model_id: impl AsRef<str>) -> AppError {
    AppError::ModelNotReady(format!("model '{}' is not downloaded", model_id.as_ref()))
}

pub fn model_unknown(model_id: impl AsRef<str>) -> AppError {
    AppError::ModelUnknown(format!("unknown model: {}", model_id.as_ref()))
}

pub fn is_storage_full(err: &std::io::Error) -> bool {
    if matches!(err.kind(), std::io::ErrorKind::StorageFull) {
        return true;
    }
    // Prefer platform-correct errno when kind is Other (common on some targets).
    // Linux ENOSPC = 28; Windows ERROR_DISK_FULL = 112.
    // Do NOT OR both: Linux 112 is EHOSTDOWN, Windows 28 is ERROR_OUT_OF_PAPER.
    #[cfg(unix)]
    if err.raw_os_error() == Some(28) {
        return true;
    }
    #[cfg(windows)]
    if err.raw_os_error() == Some(112) {
        return true;
    }
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("no space left")
        || msg.contains("not enough space")
        || msg.contains("disk full")
}

/// Product catalog code for FE copy maps and control flow (`cancelled`, `busy`, …).
pub fn error_code(err: &AppError) -> &'static str {
    match err {
        AppError::Cancelled => code::CANCELLED,
        AppError::Busy => code::BUSY,
        AppError::DownloadBusy => code::DOWNLOAD_BUSY,
        AppError::Network(_) => code::NETWORK,
        AppError::DiskFull(_) => code::DISK_FULL,
        AppError::ModelCorrupt(_) => code::MODEL_CORRUPT,
        AppError::ModelNotReady(_) => code::MODEL_NOT_READY,
        AppError::ModelUnknown(_) => code::MODEL_UNKNOWN,
        AppError::Oom(_) => code::OOM,
        AppError::Gpu(_) => code::GPU,
        AppError::ImageUnreadable(_) => code::IMAGE_UNREADABLE,
        AppError::OutputFailed(_) => code::OUTPUT_FAILED,
        AppError::Config(_) => code::CONFIG,
        AppError::Dialog(_) => code::DIALOG,
        AppError::Inference(_) | AppError::Pipeline(_) => code::INFERENCE_FAILED,
        AppError::Model(_) | AppError::Serde(_) => code::UNKNOWN,
        AppError::Io(e) => {
            if is_storage_full(e) {
                code::DISK_FULL
            } else {
                code::UNKNOWN
            }
        }
    }
}

/// Shared OOM needles for promoting ORT/session messages to [`AppError::Oom`].
/// Avoid bare `"oom"` — it false-positives on words like "room" / "zoom".
pub fn looks_like_oom_message(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "8007000e",
        "e_outofmemory",
        "out of memory",
        "out_of_memory",
        "not enough memory",
        "insufficient memory",
        "dmlcommittedresourceallocator",
        "suficientes recursos de memoria",
        "recursos de memoria disponibles",
        "failed to allocate",
        "allocation failure",
        "cuda_error_out_of_memory",
        "memory allocation failed",
        "std::bad_alloc",
        "bad_alloc",
    ];
    NEEDLES.iter().any(|n| lower.contains(n))
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", error_code(self))?;
        state.serialize_field("message", &error_message(self))?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_and_busy_codes() {
        assert_eq!(error_code(&AppError::Cancelled), code::CANCELLED);
        assert_eq!(error_code(&AppError::Busy), code::BUSY);
        assert_eq!(error_code(&AppError::DownloadBusy), code::DOWNLOAD_BUSY);
    }

    #[test]
    fn model_and_inference_catalog() {
        assert_eq!(
            error_code(&AppError::ModelCorrupt("SHA-256 mismatch for x".into())),
            code::MODEL_CORRUPT
        );
        assert_eq!(
            error_code(&model_not_ready("isnet")),
            code::MODEL_NOT_READY
        );
        assert_eq!(error_code(&model_unknown("nope")), code::MODEL_UNKNOWN);
        assert_eq!(
            error_code(&network_error("request failed: timeout")),
            code::NETWORK
        );
        assert_eq!(
            error_code(&network_error(
                "download returned status 503 Service Unavailable"
            )),
            code::NETWORK
        );
        assert_eq!(
            error_code(&AppError::DiskFull("disk full during write: ENOSPC".into())),
            code::DISK_FULL
        );
        assert_eq!(
            error_code(&inference_error("CUDA out of memory")),
            code::OOM
        );
        assert_eq!(
            error_code(&inference_error("model produced no outputs")),
            code::INFERENCE_FAILED
        );
        assert_eq!(
            error_code(&AppError::Pipeline("bad rank".into())),
            code::INFERENCE_FAILED
        );
        assert_eq!(
            error_code(&image_decode_error("bad png")),
            code::IMAGE_UNREADABLE
        );
        assert_eq!(
            error_code(&image_encode_error("png write failed")),
            code::OUTPUT_FAILED
        );
        assert_eq!(
            error_code(&output_write_error(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "access denied"
            ))),
            code::OUTPUT_FAILED
        );
        assert_eq!(error_code(&AppError::Gpu("lspci failed".into())), code::GPU);
        assert_eq!(
            error_code(&AppError::Config("invalid ep".into())),
            code::CONFIG
        );
        assert_eq!(
            error_code(&config_io_error(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "access denied"
            ))),
            code::CONFIG
        );
        assert_eq!(
            error_code(&AppError::Dialog("invalid path".into())),
            code::DIALOG
        );
    }

    #[test]
    fn io_disk_full_via_os_message() {
        let e = std::io::Error::new(std::io::ErrorKind::Other, "No space left on device");
        assert!(is_storage_full(&e));
        assert_eq!(error_code(&AppError::Io(e)), code::DISK_FULL);
    }

    #[test]
    fn storage_full_does_not_treat_wrong_platform_errno_as_disk() {
        // Linux EHOSTDOWN / Windows ERROR_OUT_OF_PAPER must not hard-match.
        #[cfg(unix)]
        {
            let e = std::io::Error::from_raw_os_error(112);
            assert!(!is_storage_full(&e), "Linux 112 is EHOSTDOWN, not ENOSPC");
        }
        #[cfg(windows)]
        {
            let e = std::io::Error::from_raw_os_error(28);
            assert!(
                !is_storage_full(&e),
                "Windows 28 is ERROR_OUT_OF_PAPER, not ERROR_DISK_FULL"
            );
        }
    }

    #[test]
    fn model_io_error_tags_disk_full() {
        let e = std::io::Error::new(std::io::ErrorKind::Other, "No space left on device");
        let err = model_io_error("write", e);
        assert_eq!(error_code(&err), code::DISK_FULL);
        assert!(error_message(&err).contains("disk full"));
    }

    #[test]
    fn serialize_is_code_message_object() {
        let err = AppError::ModelCorrupt("SHA-256 mismatch for x".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], code::MODEL_CORRUPT);
        assert_eq!(json["message"], "SHA-256 mismatch for x");
        assert!(json.get("code").is_some());
        assert!(json.get("message").is_some());
        assert_eq!(json.as_object().map(|o| o.len()), Some(2));
    }

    #[test]
    fn serialize_cancelled() {
        let json = serde_json::to_value(&AppError::Cancelled).unwrap();
        assert_eq!(json["code"], code::CANCELLED);
        assert_eq!(json["message"], "cancelled");
    }
}
