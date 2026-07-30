use std::time::Instant;

use ndarray::{Array4, ArrayD};

use crate::error::AppError;
use crate::events::{JobTimings, StageTiming};
use crate::processing::ProcessingState;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingJob {
    pub id: String,
    pub input_path: String,
    pub output_path: String,
    pub model_id: String,
}

pub trait JobSink {
    fn on_progress(&self, stage: &str, pct: f32) -> Result<(), AppError>;
    fn on_done(&self, output_path: &str, timings: &JobTimings) -> Result<(), AppError>;
    fn on_error(&self, err: &AppError);
    fn on_fallback(&self, reason: &str, from_ep: &str, to_ep: &str) -> Result<(), AppError>;
}

pub struct JobDeps<'a> {
    pub sink: &'a dyn JobSink,
    pub execution_provider: &'a dyn Fn() -> Result<String, AppError>,
    pub model_is_ready: &'a dyn Fn(&crate::models::ModelEntry) -> Result<bool, AppError>,
    /// Session load + forward pass. Implementations must load the model for `ep`
    /// (e.g. via `with_session`) so load-time OOM still participates in GPU→CPU fallback.
    pub run_inference: &'a dyn Fn(&str, &str, &Array4<f32>) -> Result<ArrayD<f32>, AppError>,
}

fn ep_is_cpu(ep: &str) -> bool {
    ep.eq_ignore_ascii_case(crate::inference::EP_CPU)
}

struct StageTimer {
    stage: &'static str,
    start: Instant,
}

impl StageTimer {
    fn start(stage: &'static str) -> Self {
        Self {
            stage,
            start: Instant::now(),
        }
    }

    fn finish(self) -> StageTiming {
        StageTiming {
            stage: self.stage.into(),
            seconds: self.start.elapsed().as_secs_f64(),
        }
    }
}

pub fn run(
    job: &ProcessingJob,
    state: &ProcessingState,
    deps: &JobDeps<'_>,
) -> Result<(), AppError> {
    let result = run_inner(job, state, deps);
    if let Err(ref err) = result {
        deps.sink.on_error(err);
    }
    result
}

fn run_inner(
    job: &ProcessingJob,
    state: &ProcessingState,
    deps: &JobDeps<'_>,
) -> Result<(), AppError> {
    let job_start = Instant::now();
    let mut stages = Vec::new();

    state.check_cancel()?;

    let model = crate::models::find_model(&job.model_id)?;
    if !model.bundled && !(deps.model_is_ready)(model)? {
        return Err(crate::error::model_not_ready(&job.model_id));
    }

    deps.sink.on_progress("decoding", 10.0)?;
    state.check_cancel()?;
    let timer = StageTimer::start("decoding");
    let image_bytes = std::fs::read(&job.input_path)
        .map_err(|e| crate::error::image_decode_error(format!("open input: {e}")))?;
    let img = crate::image_io::decode(&image_bytes)?;
    drop(image_bytes);
    let original_size = (img.width(), img.height());
    stages.push(timer.finish());

    deps.sink.on_progress("preprocessing", 20.0)?;
    state.check_cancel()?;
    let timer = StageTimer::start("preprocessing");
    let tensor = crate::pipeline::preprocess(model, &img)?;
    // Consume img into rgb so we never hold DynamicImage + RgbImage together.
    let rgb = img.into_rgb8();
    stages.push(timer.finish());

    deps.sink.on_progress("inferring", 50.0)?;
    state.check_cancel()?;
    let timer_infer = StageTimer::start("inferring");
    let ep = (deps.execution_provider)()?;
    // Scope so the preprocess tensor (e.g. ~12 MiB at 1024², ~3 MiB at 512²) is
    // dropped before postprocess on success. Multi-GB pressure is the ORT
    // session, released inside with_session when the infer closure returns.
    let output = {
        let tensor = tensor;
        match (deps.run_inference)(&job.model_id, &ep, &tensor) {
            Ok(output) => {
                stages.push(timer_infer.finish());
                output
            }
            Err(e) if crate::inference::is_likely_oom(&e) && !ep_is_cpu(&ep) => {
                stages.push(timer_infer.finish());
                state.check_cancel()?;
                deps.sink
                    .on_fallback("oom", &ep, crate::inference::EP_CPU)?;
                // Sink may cancel during on_fallback; re-check before progress/CPU work.
                state.check_cancel()?;
                log::warn!(
                    "inference OOM on execution provider '{ep}'; retrying on {}",
                    crate::inference::EP_CPU
                );
                deps.sink.on_progress("inferring-cpu", 50.0)?;
                state.check_cancel()?;
                let timer_cpu = StageTimer::start("inferring-cpu");
                let output = (deps.run_inference)(
                    &job.model_id,
                    crate::inference::EP_CPU,
                    &tensor,
                )?;
                stages.push(timer_cpu.finish());
                output
            }
            Err(e) => return Err(e),
        }
    };

    deps.sink.on_progress("postprocessing", 80.0)?;
    state.check_cancel()?;
    let timer = StageTimer::start("postprocessing");
    let alpha = {
        let output = output;
        crate::pipeline::postprocess(&job.model_id, original_size, &output)?
    };
    stages.push(timer.finish());

    deps.sink.on_progress("encoding", 95.0)?;
    state.check_cancel()?;
    let timer = StageTimer::start("encoding");
    let output_bytes = crate::image_io::encode_png_rgba(&rgb, &alpha)?;
    // Skip write if the user cancelled during encode (or earlier race).
    state.check_cancel()?;
    std::fs::write(&job.output_path, output_bytes)
        .map_err(crate::error::output_write_error)?;
    stages.push(timer.finish());

    let timings = JobTimings {
        stages,
        total_seconds: job_start.elapsed().as_secs_f64(),
    };
    // Do not emit done after cancel — finish must not beat cancel for the UI.
    state.check_cancel()?;
    deps.sink.on_done(&job.output_path, &timings)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct Recorder {
        progress: Mutex<Vec<(String, f32)>>,
        done: Mutex<Option<String>>,
        timings: Mutex<Option<JobTimings>>,
        errors: Mutex<Vec<String>>,
        fallbacks: Mutex<Vec<(String, String, String)>>,
    }

    impl Recorder {
        fn new() -> Self {
            Self {
                progress: Mutex::new(Vec::new()),
                done: Mutex::new(None),
                timings: Mutex::new(None),
                errors: Mutex::new(Vec::new()),
                fallbacks: Mutex::new(Vec::new()),
            }
        }
    }

    impl JobSink for Recorder {
        fn on_progress(&self, stage: &str, pct: f32) -> Result<(), AppError> {
            self.progress
                .lock()
                .unwrap()
                .push((stage.to_string(), pct));
            Ok(())
        }

        fn on_done(&self, output_path: &str, timings: &JobTimings) -> Result<(), AppError> {
            *self.done.lock().unwrap() = Some(output_path.to_string());
            *self.timings.lock().unwrap() = Some(timings.clone());
            Ok(())
        }

        fn on_error(&self, err: &AppError) {
            self.errors
                .lock()
                .unwrap()
                .push(crate::error::error_message(err));
        }

        fn on_fallback(&self, reason: &str, from_ep: &str, to_ep: &str) -> Result<(), AppError> {
            self.fallbacks.lock().unwrap().push((
                reason.to_string(),
                from_ep.to_string(),
                to_ep.to_string(),
            ));
            Ok(())
        }
    }

    fn run_inference_with_session(
        load: &dyn Fn(&crate::models::ModelEntry) -> Result<Vec<u8>, AppError>,
    ) -> impl Fn(&str, &str, &Array4<f32>) -> Result<ArrayD<f32>, AppError> + '_ {
        move |model_id, ep, tensor| {
            // Serialize against inference session-cache tests (global SESSION_CACHE).
            let _lock = crate::inference::lock_session_cache_for_test();
            let model = crate::models::find_model(model_id)?;
            crate::inference::with_session(
                model_id,
                ep,
                || load(&model),
                |session| crate::inference::run(session, tensor),
            )
        }
    }

    fn ready_true(_model: &crate::models::ModelEntry) -> Result<bool, AppError> {
        Ok(true)
    }

    fn ready_false(_model: &crate::models::ModelEntry) -> Result<bool, AppError> {
        Ok(false)
    }

    fn ep_cpu() -> Result<String, AppError> {
        Ok("cpu".to_string())
    }

    fn load_u2netp(_model: &crate::models::ModelEntry) -> Result<Vec<u8>, AppError> {
        Ok(crate::inference::U2NETP_MODEL_BYTES.to_vec())
    }

    #[test]
    fn cancel_before_work() {
        let state = ProcessingState::new();
        state.cancel();
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.png");
        let recorder = Recorder::new();
        let job = ProcessingJob {
            id: "job-cancel".into(),
            input_path: dir.path().join("missing.png").to_string_lossy().into(),
            output_path: output.to_string_lossy().into(),
            model_id: "u2netp".into(),
        };
        let run_inference = run_inference_with_session(&load_u2netp);
        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_cpu,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert_eq!(recorder.errors.lock().unwrap().as_slice(), ["cancelled"]);
        assert!(recorder.done.lock().unwrap().is_none());
        assert!(!output.exists());
        assert!(recorder.progress.lock().unwrap().is_empty());
    }

    /// Sink that cancels the shared token on the first progress event (after run has started).
    struct CancelOnProgress {
        state: Arc<ProcessingState>,
        inner: Recorder,
    }

    impl JobSink for CancelOnProgress {
        fn on_progress(&self, stage: &str, pct: f32) -> Result<(), AppError> {
            self.inner.on_progress(stage, pct)?;
            self.state.cancel();
            Ok(())
        }

        fn on_done(&self, output_path: &str, timings: &JobTimings) -> Result<(), AppError> {
            self.inner.on_done(output_path, timings)
        }

        fn on_error(&self, err: &AppError) {
            self.inner.on_error(err);
        }

        fn on_fallback(&self, reason: &str, from_ep: &str, to_ep: &str) -> Result<(), AppError> {
            self.inner.on_fallback(reason, from_ep, to_ep)
        }
    }

    #[test]
    fn cancel_between_stages() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.png");
        let output = dir.path().join("out.png");
        let rgb = image::RgbImage::from_pixel(16, 16, image::Rgb([10, 20, 30]));
        rgb.save(&input).unwrap();

        let sink = CancelOnProgress {
            state: Arc::clone(&state),
            inner: Recorder::new(),
        };
        let job = ProcessingJob {
            id: "job-mid-cancel".into(),
            input_path: input.to_string_lossy().into(),
            output_path: output.to_string_lossy().into(),
            model_id: "u2netp".into(),
        };
        let run_inference = run_inference_with_session(&load_u2netp);
        let deps = JobDeps {
            sink: &sink,
            execution_provider: &ep_cpu,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert_eq!(sink.inner.errors.lock().unwrap().as_slice(), ["cancelled"]);
        assert!(sink.inner.done.lock().unwrap().is_none());
        // First progress fired; cancel before completing the pipeline.
        assert!(!sink.inner.progress.lock().unwrap().is_empty());
        assert!(!output.exists());
    }

    /// Cancels when the encoding progress event fires — must not write output.
    struct CancelOnEncoding {
        state: Arc<ProcessingState>,
        inner: Recorder,
    }

    impl JobSink for CancelOnEncoding {
        fn on_progress(&self, stage: &str, pct: f32) -> Result<(), AppError> {
            self.inner.on_progress(stage, pct)?;
            if stage == "encoding" {
                self.state.cancel();
            }
            Ok(())
        }

        fn on_done(&self, output_path: &str, timings: &JobTimings) -> Result<(), AppError> {
            self.inner.on_done(output_path, timings)
        }

        fn on_error(&self, err: &AppError) {
            self.inner.on_error(err);
        }

        fn on_fallback(&self, reason: &str, from_ep: &str, to_ep: &str) -> Result<(), AppError> {
            self.inner.on_fallback(reason, from_ep, to_ep)
        }
    }

    #[test]
    fn cancel_before_write_skips_output_file() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.png");
        let output = dir.path().join("out.png");
        let rgb = image::RgbImage::from_pixel(16, 16, image::Rgb([10, 20, 30]));
        rgb.save(&input).unwrap();

        let sink = CancelOnEncoding {
            state: Arc::clone(&state),
            inner: Recorder::new(),
        };
        let job = ProcessingJob {
            id: "job-pre-write-cancel".into(),
            input_path: input.to_string_lossy().into(),
            output_path: output.to_string_lossy().into(),
            model_id: "u2netp".into(),
        };
        let run_inference = run_inference_with_session(&load_u2netp);
        let deps = JobDeps {
            sink: &sink,
            execution_provider: &ep_cpu,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert_eq!(sink.inner.errors.lock().unwrap().as_slice(), ["cancelled"]);
        assert!(sink.inner.done.lock().unwrap().is_none());
        assert!(!output.exists());
    }

    #[test]
    fn missing_input_file() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.png");
        let missing = dir.path().join("no-such-input.png");
        let recorder = Recorder::new();
        let job = ProcessingJob {
            id: "job-missing".into(),
            input_path: missing.to_string_lossy().into(),
            output_path: output.to_string_lossy().into(),
            model_id: "u2netp".into(),
        };
        let run_inference = run_inference_with_session(&load_u2netp);
        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_cpu,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(
            matches!(&err, AppError::ImageUnreadable(msg) if msg.starts_with("open input:")),
            "expected image open error, got {:?}",
            err
        );
        assert_eq!(
            crate::error::error_code(&err),
            crate::error::code::IMAGE_UNREADABLE
        );
        let errors = recorder.errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0], crate::error::error_message(&err));
        assert!(recorder.done.lock().unwrap().is_none());
        assert!(!output.exists());
    }

    #[test]
    fn model_not_downloaded() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let recorder = Recorder::new();
        let job = ProcessingJob {
            id: "job-model".into(),
            input_path: dir.path().join("in.png").to_string_lossy().into(),
            output_path: dir.path().join("out.png").to_string_lossy().into(),
            model_id: "isnet-general-use".into(),
        };
        let run_inference = run_inference_with_session(&load_u2netp);
        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_cpu,
            model_is_ready: &ready_false,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        match err {
            AppError::ModelNotReady(msg) => {
                assert!(msg.contains("isnet-general-use"));
                assert!(msg.contains("not downloaded"));
            }
            other => panic!("expected Model error, got {:?}", other),
        }
        let errors = recorder.errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("not downloaded"));
        assert!(recorder.done.lock().unwrap().is_none());
    }

    #[test]
    fn happy_path_u2netp() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.png");
        let output = dir.path().join("out.png");

        let rgb = image::RgbImage::from_pixel(32, 32, image::Rgb([200, 100, 50]));
        rgb.save(&input).unwrap();

        let recorder = Recorder::new();
        let job = ProcessingJob {
            id: "job-happy".into(),
            input_path: input.to_string_lossy().into(),
            output_path: output.to_string_lossy().into(),
            model_id: "u2netp".into(),
        };
        let run_inference = run_inference_with_session(&load_u2netp);
        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_cpu,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        run(&job, &state, &deps).expect("happy path should succeed");

        let stages: Vec<String> = recorder
            .progress
            .lock()
            .unwrap()
            .iter()
            .map(|(s, _)| s.clone())
            .collect();
        assert_eq!(
            stages,
            vec![
                "decoding",
                "preprocessing",
                "inferring",
                "postprocessing",
                "encoding",
            ]
        );
        assert_eq!(
            recorder.done.lock().unwrap().as_deref(),
            Some(output.to_string_lossy().as_ref())
        );
        let timings = recorder.timings.lock().unwrap().clone().unwrap();
        assert_eq!(
            timings
                .stages
                .iter()
                .map(|t| t.stage.as_str())
                .collect::<Vec<_>>(),
            vec![
                "decoding",
                "preprocessing",
                "inferring",
                "postprocessing",
                "encoding",
            ]
        );
        assert!(timings.stages.iter().all(|t| t.seconds >= 0.0));
        assert!(timings.total_seconds >= 0.0);
        assert!(recorder.errors.lock().unwrap().is_empty());
        assert!(output.exists());
        let out_bytes = std::fs::read(&output).unwrap();
        assert!(!out_bytes.is_empty());
        // PNG magic
        assert_eq!(&out_bytes[..8], b"\x89PNG\r\n\x1a\n");
        let decoded = crate::image_io::decode(&out_bytes).expect("output should decode");
        assert_eq!(decoded.width(), 32);
        assert_eq!(decoded.height(), 32);
        assert!(
            decoded.color().has_alpha(),
            "job output PNG must include an alpha channel"
        );
    }

    fn ep_directml() -> Result<String, AppError> {
        Ok("directml".to_string())
    }

    fn make_u2netp_job(dir: &tempfile::TempDir) -> (ProcessingJob, std::path::PathBuf) {
        let input = dir.path().join("in.png");
        let output = dir.path().join("out.png");
        let rgb = image::RgbImage::from_pixel(32, 32, image::Rgb([200, 100, 50]));
        rgb.save(&input).unwrap();
        let job = ProcessingJob {
            id: "job-fallback".into(),
            input_path: input.to_string_lossy().into(),
            output_path: output.to_string_lossy().into(),
            model_id: "u2netp".into(),
        };
        (job, output)
    }

    #[test]
    fn gpu_oom_then_cpu_ok() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let (job, output) = make_u2netp_job(&dir);
        let recorder = Recorder::new();

        let run_inference = |model_id: &str, ep: &str, tensor: &Array4<f32>| {
            if ep.eq_ignore_ascii_case("directml") {
                return Err(crate::error::inference_error("CUDA out of memory"));
            }
            let _lock = crate::inference::lock_session_cache_for_test();
            let model = crate::models::find_model(model_id)?;
            crate::inference::with_session(
                model_id,
                ep,
                || load_u2netp(&model),
                |session| crate::inference::run(session, tensor),
            )
        };

        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_directml,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        run(&job, &state, &deps).expect("CPU retry should succeed");

        assert_eq!(
            recorder.fallbacks.lock().unwrap().as_slice(),
            &[(
                "oom".to_string(),
                "directml".to_string(),
                "cpu".to_string()
            )]
        );
        let stages: Vec<String> = recorder
            .progress
            .lock()
            .unwrap()
            .iter()
            .map(|(s, _)| s.clone())
            .collect();
        assert!(stages.contains(&"inferring-cpu".to_string()));
        let timings = recorder.timings.lock().unwrap().clone().unwrap();
        let timing_stages: Vec<_> = timings
            .stages
            .iter()
            .map(|t| t.stage.as_str())
            .collect();
        assert!(timing_stages.contains(&"inferring"));
        assert!(timing_stages.contains(&"inferring-cpu"));
        assert!(recorder.done.lock().unwrap().is_some());
        assert!(output.exists());
    }

    #[test]
    fn cpu_oom_no_fallback() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let (job, output) = make_u2netp_job(&dir);
        let recorder = Recorder::new();

        let run_inference = |_model_id: &str, _ep: &str, _tensor: &Array4<f32>| {
            Err(crate::error::inference_error("CUDA out of memory"))
        };

        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_cpu,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(matches!(err, AppError::Oom(_)));
        assert!(recorder.fallbacks.lock().unwrap().is_empty());
        assert!(recorder.done.lock().unwrap().is_none());
        assert!(!output.exists());
    }

    #[test]
    fn gpu_oom_then_cpu_fail() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let (job, output) = make_u2netp_job(&dir);
        let recorder = Recorder::new();
        let calls = Mutex::new(0usize);

        let run_inference = |_model_id: &str, ep: &str, _tensor: &Array4<f32>| {
            let mut n = calls.lock().unwrap();
            *n += 1;
            if ep.eq_ignore_ascii_case("directml") {
                return Err(crate::error::inference_error("CUDA out of memory"));
            }
            Err(crate::error::inference_error("cpu retry failed: bad_alloc"))
        };

        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_directml,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(
            matches!(&err, AppError::Oom(msg) if msg.contains("cpu retry failed")),
            "expected final CPU OOM error, got {:?}",
            err
        );
        assert_eq!(*calls.lock().unwrap(), 2);
        assert_eq!(
            recorder.fallbacks.lock().unwrap().as_slice(),
            &[(
                "oom".to_string(),
                "directml".to_string(),
                "cpu".to_string()
            )]
        );
        let errors = recorder.errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("cpu retry failed"));
        assert!(recorder.done.lock().unwrap().is_none());
        assert!(!output.exists());
    }

    #[test]
    fn non_oom_error_no_fallback() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let (job, output) = make_u2netp_job(&dir);
        let recorder = Recorder::new();

        let run_inference = |_model_id: &str, _ep: &str, _tensor: &Array4<f32>| {
            Err(crate::error::inference_error("model produced no outputs"))
        };

        let deps = JobDeps {
            sink: &recorder,
            execution_provider: &ep_directml,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(matches!(err, AppError::Inference(_)));
        assert!(recorder.fallbacks.lock().unwrap().is_empty());
        assert!(recorder.done.lock().unwrap().is_none());
        assert!(!output.exists());
    }

    struct CancelBeforeCpuRetry {
        state: Arc<ProcessingState>,
        inner: Recorder,
    }

    impl JobSink for CancelBeforeCpuRetry {
        fn on_progress(&self, stage: &str, pct: f32) -> Result<(), AppError> {
            self.inner.on_progress(stage, pct)
        }

        fn on_done(&self, output_path: &str, timings: &JobTimings) -> Result<(), AppError> {
            self.inner.on_done(output_path, timings)
        }

        fn on_error(&self, err: &AppError) {
            self.inner.on_error(err);
        }

        fn on_fallback(&self, reason: &str, from_ep: &str, to_ep: &str) -> Result<(), AppError> {
            self.inner.on_fallback(reason, from_ep, to_ep)?;
            self.state.cancel();
            Ok(())
        }
    }

    #[test]
    fn cancel_before_cpu_retry_after_oom() {
        let state = ProcessingState::new();
        let dir = tempfile::tempdir().unwrap();
        let (job, output) = make_u2netp_job(&dir);
        let sink = CancelBeforeCpuRetry {
            state: Arc::clone(&state),
            inner: Recorder::new(),
        };
        let calls = Mutex::new(0usize);

        let run_inference = |model_id: &str, ep: &str, tensor: &Array4<f32>| {
            *calls.lock().unwrap() += 1;
            if ep.eq_ignore_ascii_case("directml") {
                return Err(crate::error::inference_error("CUDA out of memory"));
            }
            // Must not be reached when cancel fires in on_fallback.
            let _lock = crate::inference::lock_session_cache_for_test();
            let model = crate::models::find_model(model_id)?;
            crate::inference::with_session(
                model_id,
                ep,
                || load_u2netp(&model),
                |session| crate::inference::run(session, tensor),
            )
        };

        let deps = JobDeps {
            sink: &sink,
            execution_provider: &ep_directml,
            model_is_ready: &ready_true,
            run_inference: &run_inference,
        };

        let err = run(&job, &state, &deps).unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert_eq!(*calls.lock().unwrap(), 1, "CPU run_inference must not run after cancel");
        assert_eq!(sink.inner.errors.lock().unwrap().as_slice(), ["cancelled"]);
        assert!(sink.inner.done.lock().unwrap().is_none());
        assert!(!output.exists());
        let stages: Vec<_> = sink
            .inner
            .progress
            .lock()
            .unwrap()
            .iter()
            .map(|(s, _)| s.clone())
            .collect();
        assert!(
            !stages.iter().any(|s| s == "inferring-cpu"),
            "should not emit inferring-cpu progress after cancel in on_fallback"
        );
    }
}
