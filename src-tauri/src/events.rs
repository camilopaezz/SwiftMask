use serde::{Deserialize, Serialize};

pub const INFERENCE_PROGRESS: &str = "inference:progress";
pub const INFERENCE_DONE: &str = "inference:done";
pub const INFERENCE_ERROR: &str = "inference:error";
pub const INFERENCE_FALLBACK: &str = "inference:fallback";
pub const MODEL_DOWNLOAD: &str = "model:download";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceProgressPayload {
    pub id: String,
    pub stage: String,
    pub pct: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageTiming {
    pub stage: String,
    pub seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobTimings {
    pub stages: Vec<StageTiming>,
    pub total_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceDonePayload {
    pub id: String,
    pub output_path: String,
    pub timings: JobTimings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub app_version: String,
    pub ort_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceErrorPayload {
    pub id: String,
    /// Stable catalog code (see `error::code`).
    pub code: String,
    /// Technical detail for diagnostics / unmapped FE fallback.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceFallbackPayload {
    pub id: String,
    pub reason: String,
    pub from_ep: String,
    pub to_ep: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadPayload {
    pub model_id: String,
    pub pct: f32,
    /// `"download"` while streaming bytes; `"verify"` while hashing.
    pub stage: String,
}
