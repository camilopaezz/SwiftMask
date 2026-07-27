use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::config::Config;
use crate::error::AppError;
use ndarray::Array4;

use crate::events::{
    InferenceDonePayload, InferenceErrorPayload, InferenceFallbackPayload,
    InferenceProgressPayload, JobTimings, RuntimeInfo, INFERENCE_DONE, INFERENCE_ERROR,
    INFERENCE_FALLBACK, INFERENCE_PROGRESS,
};
use crate::gpu::{BenchmarkResult, GpuInfo};
use crate::job::{JobDeps, JobSink, ProcessingJob};
use crate::download::DownloadState;
use crate::models::ModelMeta;
use crate::processing::{ProcessingSlotGuard, ProcessingState};

struct AppJobSink {
    app: AppHandle,
    id: String,
}

impl JobSink for AppJobSink {
    fn on_progress(&self, stage: &str, pct: f32) -> Result<(), AppError> {
        self.app
            .emit(
                INFERENCE_PROGRESS,
                InferenceProgressPayload {
                    id: self.id.clone(),
                    stage: stage.to_string(),
                    pct,
                },
            )
            .map_err(|e| crate::error::inference_error(e.to_string()))
    }

    fn on_done(&self, output_path: &str, timings: &JobTimings) -> Result<(), AppError> {
        self.app
            .emit(
                INFERENCE_DONE,
                InferenceDonePayload {
                    id: self.id.clone(),
                    output_path: output_path.to_string(),
                    timings: timings.clone(),
                },
            )
            .map_err(|e| crate::error::inference_error(e.to_string()))
    }

    fn on_error(&self, err: &AppError) {
        let _ = self.app.emit(
            INFERENCE_ERROR,
            InferenceErrorPayload {
                id: self.id.clone(),
                code: crate::error::error_code(err).to_string(),
                message: crate::error::error_message(err),
            },
        );
    }

    fn on_fallback(&self, reason: &str, from_ep: &str, to_ep: &str) -> Result<(), AppError> {
        self.app
            .emit(
                INFERENCE_FALLBACK,
                InferenceFallbackPayload {
                    id: self.id.clone(),
                    reason: reason.to_string(),
                    from_ep: from_ep.to_string(),
                    to_ep: to_ep.to_string(),
                },
            )
            .map_err(|e| crate::error::inference_error(e.to_string()))
    }
}

#[tauri::command]
pub async fn detect_gpu() -> Result<GpuInfo, AppError> {
    tauri::async_runtime::spawn_blocking(crate::gpu::detect_gpu)
        .await
        .map_err(|e| crate::error::inference_error(e.to_string()))?
}

#[tauri::command]
pub async fn run_benchmark(app: AppHandle) -> Result<BenchmarkResult, AppError> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::gpu::run_benchmark(&app))
        .await
        .map_err(|e| crate::error::inference_error(e.to_string()))?
}

#[tauri::command]
pub async fn set_ep(app: AppHandle, ep: String) -> Result<(), AppError> {
    let normalized = ep.to_lowercase();
    if !matches!(
        normalized.as_str(),
        crate::inference::EP_CPU | crate::inference::EP_DIRECTML | crate::inference::EP_CUDA
    ) {
        return Err(AppError::Config(format!(
            "unknown execution provider: {}",
            ep
        )));
    }
    let mut config = crate::config::load_config(&app)?;
    config.execution_provider = Some(normalized);
    crate::config::save_config(&app, &config)?;
    crate::inference::invalidate_all_sessions()?;
    Ok(())
}

#[tauri::command]
pub async fn list_models(app: AppHandle) -> Result<Vec<ModelMeta>, AppError> {
    crate::models::list_models(&app)
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, Arc<DownloadState>>,
    model_id: String,
) -> Result<(), AppError> {
    crate::models::download_model(&app, state.inner(), &model_id).await
}

#[tauri::command]
pub async fn cancel_download(state: State<'_, Arc<DownloadState>>) -> Result<(), AppError> {
    if !state.is_busy() {
        return Ok(());
    }
    state.cancel();
    state.wait_until_idle().await;
    Ok(())
}

#[tauri::command]
pub async fn remove_image_background(
    app: AppHandle,
    state: State<'_, Arc<ProcessingState>>,
    args: ProcessingJob,
) -> Result<(), AppError> {
    state.try_acquire(&args.id)?;
    let processing_state = state.inner().clone();
    // Clone for JoinError recovery — the blocking task moves its own copy.
    let processing_state_for_join = processing_state.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Always clear busy — success, cancel, error, or panic inside catch_unwind.
        let _guard = ProcessingSlotGuard(processing_state.clone());
        let job_id = args.id.clone();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let sink = AppJobSink {
                app: app_handle.clone(),
                id: args.id.clone(),
            };
            let app_for_ep = app_handle.clone();
            let app_for_ready = app_handle.clone();
            let app_for_load = app_handle.clone();
            let execution_provider = || {
                Ok(crate::config::load_config(&app_for_ep)?.execution_provider())
            };
            let model_is_ready = |model: &crate::models::ModelEntry| {
                crate::models::model_is_cached(&app_for_ready, model)
            };
            let load_model_bytes = |model: &crate::models::ModelEntry| {
                if model.bundled {
                    Ok(crate::inference::U2NETP_MODEL_BYTES.to_vec())
                } else {
                    Ok(std::fs::read(crate::models::model_cache_path(
                        &app_for_load,
                        model,
                    )?)?)
                }
            };
            let run_inference = |model_id: &str, ep: &str, tensor: &Array4<f32>| {
                let model = crate::models::find_model(model_id)?;
                crate::inference::with_session(
                    model_id,
                    ep,
                    || load_model_bytes(&model),
                    |session| crate::inference::run(session, tensor),
                )
            };
            let deps = JobDeps {
                sink: &sink,
                execution_provider: &execution_provider,
                model_is_ready: &model_is_ready,
                run_inference: &run_inference,
            };
            crate::job::run(&args, &processing_state, &deps)
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                // job::run already called sink.on_error. OOM path also drops
                // sessions inside with_session; belt-and-suspenders here so a
                // future error site that skips that still releases multi-GB.
                if crate::inference::is_likely_oom(&err) {
                    let _ = crate::inference::invalidate_all_sessions();
                }
            }
            Err(_) => {
                // Panic can leave the ORT/DirectML session in a bad state with
                // committed GPU/system memory. Destroy the cache so the idle
                // process does not keep multi-GB around.
                let _ = crate::inference::invalidate_all_sessions();
                let _ = app_handle.emit(
                    INFERENCE_ERROR,
                    InferenceErrorPayload {
                        id: job_id,
                        code: crate::error::code::UNKNOWN.to_string(),
                        message: "worker panic".to_string(),
                    },
                );
            }
        }
    })
    .await
    .map_err(|e| {
        // JoinError path: worker may have panicked before `_guard` ran, or
        // the runtime aborted the task — ensure the slot is free either way.
        processing_state_for_join.release();
        crate::error::inference_error(e.to_string())
    })?;
    Ok(())
}

#[tauri::command]
pub async fn cancel_inference(
    state: State<'_, Arc<ProcessingState>>,
    job_id: String,
) -> Result<(), AppError> {
    // Scoped: a late cancel for a finished job must not trip the next run.
    // Only wait when this job was actually active — a stale id must not block
    // on an unrelated worker holding the slot.
    if state.cancel_job(&job_id) {
        // Block until the worker releases the slot so a follow-up Process cannot
        // race the still-running job (RAM spike from overlapping inference).
        // Cancel is cooperative (checked between pipeline stages); long ORT
        // inferring work may delay return until that stage finishes.
        state.wait_until_idle().await;
    }
    Ok(())
}

/// Check whether a path exists using native FS (not the scoped frontend plugin).
/// Required for overwrite prompts when the output dir is outside `$HOME` etc.
#[tauri::command]
pub async fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub async fn pick_output_dir(app: AppHandle) -> Result<Option<String>, AppError> {
    let config = crate::config::load_config(&app)?;
    let current_dir = config
        .output_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    let dialog = app.dialog().file();
    let dialog = if let Some(dir) = current_dir {
        dialog.set_directory(dir)
    } else {
        dialog
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |path| {
        let _ = tx.send(path);
    });

    let path = rx.await.ok().flatten();

    if let Some(path) = path {
        let path_buf = path
            .into_path()
            .map_err(|e| AppError::Dialog(format!("invalid path: {}", e)))?;
        let path_str = path_buf.to_string_lossy().into_owned();
        let mut config = crate::config::load_config(&app)?;
        config.output_dir = Some(path_str.clone());
        crate::config::save_config(&app, &config)?;
        Ok(Some(path_str))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn get_runtime_info() -> Result<RuntimeInfo, AppError> {
    Ok(RuntimeInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        ort_version: format!("1.{}", ort::MINOR_VERSION),
    })
}

#[tauri::command]
pub async fn get_config(app: AppHandle) -> Result<Config, AppError> {
    crate::config::load_config(&app)
}
