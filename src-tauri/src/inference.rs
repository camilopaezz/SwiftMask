use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use ndarray::Array4;
use ort::ep::ExecutionProviderDispatch;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;

use crate::error::AppError;

pub const EP_CPU: &str = "cpu";
pub const EP_DIRECTML: &str = "directml";
pub const EP_CUDA: &str = "cuda";

/// Drop warm sessions if unused for this long (batch 1.1 CP3 keep-alive).
const SESSION_IDLE_TTL: Duration = Duration::from_secs(120);

pub static U2NETP_MODEL_BYTES: &[u8] = include_bytes!("../models/u2netp.onnx");

/// Cached ORT sessions keyed by (model_id, ep). Kept warm across successful jobs
/// for batch throughput; dropped on OOM, non-OOM error, EP change, or idle TTL.
static SESSION_CACHE: Mutex<Option<HashMap<(String, String), Session>>> = Mutex::new(None);

/// Last successful use of any cached session (for idle TTL).
static SESSION_LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);

static DETECTED_VRAM: LazyLock<Option<u64>> = LazyLock::new(|| {
    crate::gpu::detect_gpu().ok().and_then(|g| g.vram_bytes)
});

fn optimization_level_for_vram(vram: Option<u64>) -> GraphOptimizationLevel {
    match crate::gpu::opt_level_for_vram(vram) {
        3 => GraphOptimizationLevel::Level3,
        _ => GraphOptimizationLevel::Level1,
    }
}

/// DirectML requires sequential execution and no mem-pattern (ORT will error otherwise).
/// Disabling mem-pattern also avoids holding large reserved arenas after a run.
fn is_directml(ep: &str) -> bool {
    ep.eq_ignore_ascii_case(EP_DIRECTML)
}

pub fn load_session_from_bytes(model_bytes: &[u8], ep: &str) -> Result<Session, AppError> {
    let mut providers: Vec<ExecutionProviderDispatch> = Vec::new();
    match ep.to_lowercase().as_str() {
        EP_DIRECTML => {
            #[cfg(target_os = "windows")]
            {
                providers.push(ort::ep::DirectML::default().build());
            }
        }
        EP_CUDA => {
            #[cfg(target_os = "linux")]
            {
                providers.push(ort::ep::CUDA::default().build());
            }
        }
        _ => {}
    }
    providers.push(ort::ep::CPU::default().build());

    let opt_level = optimization_level_for_vram(*DETECTED_VRAM);
    let dml = is_directml(ep);

    let mut builder = Session::builder()
        .map_err(|e| crate::error::inference_error(e.to_string()))?
        .with_optimization_level(opt_level)
        .map_err(|e| crate::error::inference_error(e.to_string()))?;

    if dml {
        // Required by DirectML EP; also reduces lingering reserved buffers.
        builder = builder
            .with_memory_pattern(false)
            .map_err(|e| crate::error::inference_error(e.to_string()))?
            .with_parallel_execution(false)
            .map_err(|e| crate::error::inference_error(e.to_string()))?;
    }

    builder
        .with_execution_providers(providers)
        .map_err(|e| crate::error::inference_error(e.to_string()))?
        .commit_from_memory(model_bytes)
        .map_err(|e| crate::error::inference_error(e.to_string()))
}

/// Drop every cached ORT session and ask the OS to return free pages.
///
/// DirectML/ORT keep multi-GB of committed resources on the live `OrtSession`.
/// After OOM (or EP switch) those sessions must be destroyed; Task Manager may
/// still show a high working set until we trim it.
pub fn invalidate_all_sessions() -> Result<(), AppError> {
    release_all_sessions();
    Ok(())
}

/// Take ownership of the cache so `Session` Drop runs outside the mutex.
fn take_session_cache() -> Option<HashMap<(String, String), Session>> {
    let mut guard = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard.take()
}

fn release_all_sessions() {
    // Drop sessions first (frees ORT/DirectML device resources), then trim WS.
    let stolen = take_session_cache();
    drop(stolen);
    if let Ok(mut last) = SESSION_LAST_USE.lock() {
        *last = None;
    }
    trim_process_working_set();
}

/// If the warm cache has been idle longer than [`SESSION_IDLE_TTL`], drop it.
fn maybe_expire_idle_sessions() {
    let expired = {
        let last = SESSION_LAST_USE.lock().unwrap_or_else(|e| e.into_inner());
        match *last {
            Some(t) => t.elapsed() > SESSION_IDLE_TTL,
            None => false,
        }
    };
    if expired {
        log::info!(
            "ORT session idle > {}s; releasing warm cache",
            SESSION_IDLE_TTL.as_secs()
        );
        release_all_sessions();
    }
}

fn touch_session_last_use() {
    let mut last = SESSION_LAST_USE.lock().unwrap_or_else(|e| e.into_inner());
    *last = Some(Instant::now());
}

/// Ask Windows to page out free RAM so Task Manager reflects the drop.
/// No-op on other platforms (RSS typically shrinks once arenas are freed).
fn trim_process_working_set() {
    #[cfg(target_os = "windows")]
    {
        // SAFETY: GetCurrentProcess returns a pseudo-handle; EmptyWorkingSet only
        // affects this process and is best-effort (failure is non-fatal).
        unsafe {
            use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
            use windows::Win32::System::Threading::GetCurrentProcess;
            let _ = EmptyWorkingSet(GetCurrentProcess());
        }
    }
}

/// True when an inference error likely means GPU/system allocator failure.
/// Used to drop cached sessions so DirectML/ORT can release committed memory.
///
/// Aligned with wire catalog code `oom` via shared needles in
/// [`crate::error::looks_like_oom_message`] / [`crate::error::error_code`].
/// Avoid bare `"oom"` — it false-positives on words like "room" / "zoom".
pub fn is_likely_oom(err: &AppError) -> bool {
    crate::error::error_code(err) == crate::error::code::OOM
}

/// Drop sessions *outside* the cache mutex, then trim the process working set.
/// Heavy DirectML `Session` teardown must not run while `SESSION_CACHE` is held.
fn discard_sessions_and_trim<T>(stolen: T) {
    drop(stolen);
    trim_process_working_set();
}

/// Ensure `key` is present in the cache, loading outside the lock if needed.
fn ensure_session_loaded<L>(key: &(String, String), load_bytes: &mut L) -> Result<(), AppError>
where
    L: FnMut() -> Result<Vec<u8>, AppError>,
{
    {
        let guard = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if guard
            .as_ref()
            .is_some_and(|cache| cache.contains_key(key))
        {
            return Ok(());
        }
    }

    // commit_from_memory can take seconds and may OOM — do not hold the mutex.
    let model_bytes = load_bytes()?;
    let session = match load_session_from_bytes(&model_bytes, &key.1) {
        Ok(s) => s,
        Err(e) => {
            // Load OOM often means another cached session already ate the budget.
            if is_likely_oom(&e) {
                log::warn!(
                    "OOM while loading session {key:?}; releasing all cached sessions: {e}"
                );
                release_all_sessions();
            }
            return Err(e);
        }
    };
    // Drop model_bytes before insert so we do not hold file bytes + session.
    drop(model_bytes);

    let mut guard = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    // Another thread may have inserted the same key; prefer existing.
    cache.entry(key.clone()).or_insert(session);
    Ok(())
}

pub fn with_session<F, R, L>(model_id: &str, ep: &str, mut load_bytes: L, f: F) -> Result<R, AppError>
where
    F: FnOnce(&mut Session) -> Result<R, AppError>,
    L: FnMut() -> Result<Vec<u8>, AppError>,
{
    // Batch 1.1: keep sessions warm across serial jobs; expire after idle TTL.
    maybe_expire_idle_sessions();

    let key = (model_id.to_string(), ep.to_string());
    ensure_session_loaded(&key, &mut load_bytes)?;

    let mut guard = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());

    // Key may have vanished between ensure and re-lock (invalidate / OOM cleanup
    // on another path). Reload once rather than failing with a cryptic miss.
    if !guard
        .as_ref()
        .is_some_and(|cache| cache.contains_key(&key))
    {
        drop(guard);
        ensure_session_loaded(&key, &mut load_bytes)?;
        guard = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    }

    // End the &mut Session borrow before we mutate the map on error paths.
    let result = {
        let cache = guard.get_or_insert_with(HashMap::new);
        match cache.get_mut(&key) {
            Some(session) => f(session),
            None => Err(crate::error::inference_error(
                "session missing from cache after reload".to_string(),
            )),
        }
    };

    // Keep warm on success (batch serial jobs re-enter with_session per image).
    // Drop on OOM (all keys) or other errors (this key) so bad sessions are not reused.
    match &result {
        Ok(_) => {
            drop(guard);
            touch_session_last_use();
        }
        Err(err) if is_likely_oom(err) => {
            log::warn!(
                "OOM-like inference error; destroying all cached sessions to free GPU/system memory: {err}"
            );
            let all = guard.take();
            drop(guard);
            if let Ok(mut last) = SESSION_LAST_USE.lock() {
                *last = None;
            }
            discard_sessions_and_trim(all);
        }
        Err(err) => {
            log::warn!("inference failed; dropping cached session {key:?}: {err}");
            let one = take_cached_session(&mut guard, &key);
            drop(guard);
            discard_sessions_and_trim(one);
        }
    }

    result
}

/// Remove `key` from the map (and clear it if empty). Caller drops outside the lock.
fn take_cached_session(
    guard: &mut Option<HashMap<(String, String), Session>>,
    key: &(String, String),
) -> Option<Session> {
    let Some(cache) = guard.as_mut() else {
        return None;
    };
    let session = cache.remove(key);
    if cache.is_empty() {
        *guard = None;
    }
    session
}

/// Serializes tests that touch the process-global session cache.
///
/// `with_session` can drop the cache mutex while loading; concurrent tests that
/// call `invalidate_all_sessions` (or OOM wipe) in that window produce flaky
/// "session missing from cache after reload" failures under multi-threaded
/// `cargo test` (seen on Windows CI). Hold this for the full body of any test
/// that uses `with_session` / `invalidate_all_sessions` / `insert_session_for_test`.
#[cfg(test)]
static SESSION_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Hold for the full body of any test that reads/writes `SESSION_CACHE`.
#[cfg(test)]
pub fn lock_session_cache_for_test() -> std::sync::MutexGuard<'static, ()> {
    SESSION_CACHE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Test-only: leave a live session under `key` without going through `with_session`
/// (which unloads on return). Used to exercise multi-key OOM wipe.
#[cfg(test)]
fn insert_session_for_test(model_id: &str, ep: &str, session: Session) {
    let key = (model_id.to_string(), ep.to_string());
    let mut guard = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(key, session);
}

pub fn run(session: &mut Session, input: &Array4<f32>) -> Result<ndarray::ArrayD<f32>, AppError> {
    let tensor_ref = TensorRef::from_array_view(input.view())
        .map_err(|e| crate::error::inference_error(e.to_string()))?;
    let outputs = session
        .run(ort::inputs![tensor_ref])
        .map_err(|e| crate::error::inference_error(e.to_string()))?;
    if outputs.len() == 0 {
        return Err(crate::error::inference_error("model produced no outputs"));
    }
    let value = &outputs[0];
    value
        .try_extract_array::<f32>()
        .map_err(|e| crate::error::inference_error(e.to_string()))
        .map(|view| view.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optimization_level_picks_level3_for_4gb_plus() {
        assert_eq!(
            optimization_level_for_vram(Some(4 * 1024 * 1024 * 1024)),
            GraphOptimizationLevel::Level3
        );
        assert_eq!(
            optimization_level_for_vram(Some(8 * 1024 * 1024 * 1024)),
            GraphOptimizationLevel::Level3
        );
    }

    #[test]
    fn optimization_level_picks_level1_for_under_4gb() {
        assert_eq!(
            optimization_level_for_vram(Some(2 * 1024 * 1024 * 1024)),
            GraphOptimizationLevel::Level1
        );
        assert_eq!(
            optimization_level_for_vram(Some(3_999_999_999)),
            GraphOptimizationLevel::Level1
        );
    }

    #[test]
    fn optimization_level_defaults_to_level1_when_vram_unknown() {
        assert_eq!(
            optimization_level_for_vram(None),
            GraphOptimizationLevel::Level1
        );
    }

    #[test]
    fn bundled_u2netp_loads_cpu() {
        let session = load_session_from_bytes(U2NETP_MODEL_BYTES, EP_CPU).unwrap();
        assert_eq!(session.inputs().len(), 1);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn cuda_ep_falls_back_to_cpu_on_amd() {
        let session = load_session_from_bytes(U2NETP_MODEL_BYTES, EP_CUDA).unwrap();
        assert_eq!(session.inputs().len(), 1);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn cuda_ep_actually_runs_on_gpu_when_available() {
        let gpu = crate::gpu::detect_gpu().unwrap();
        if !gpu.available_eps.iter().any(|e| e == EP_CUDA) {
            eprintln!("no CUDA EP available; skipping");
            return;
        }
        let providers = vec![
            ort::ep::CUDA::default().build().error_on_failure(),
            ort::ep::CPU::default().build(),
        ];
        let session = Session::builder()
            .map_err(|e| crate::error::inference_error(e.to_string()))
            .unwrap()
            .with_optimization_level(GraphOptimizationLevel::Level1)
            .map_err(|e| crate::error::inference_error(e.to_string()))
            .unwrap()
            .with_execution_providers(providers)
            .map_err(|e| crate::error::inference_error(e.to_string()))
            .unwrap()
            .commit_from_memory(U2NETP_MODEL_BYTES);
        let mut session = match session {
            Ok(s) => s,
            Err(e) => {
                eprintln!("CUDA EP failed to load (runtime libs mismatch?): {e}");
                return;
            }
        };
        let tensor = Array4::<f32>::zeros([1, 3, 320, 320]);
        let output = run(&mut session, &tensor).unwrap();
        assert_eq!(output.shape(), &[1, 1, 320, 320]);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn directml_ep_loads() {
        let session = load_session_from_bytes(U2NETP_MODEL_BYTES, EP_DIRECTML).unwrap();
        assert_eq!(session.inputs().len(), 1);
    }

    #[test]
    fn with_session_accepts_distinct_model_keys() {
        let _lock = lock_session_cache_for_test();
        let _ = invalidate_all_sessions();
        let r1 = with_session("u2netp", EP_CPU, || Ok(U2NETP_MODEL_BYTES.to_vec()), |session| {
            Ok(session.inputs().len())
        });
        let r2 = with_session("u2netp", EP_CPU, || Ok(U2NETP_MODEL_BYTES.to_vec()), |session| {
            Ok(session.inputs().len())
        });
        let r3 = with_session("isnet-stub", EP_CPU, || Ok(U2NETP_MODEL_BYTES.to_vec()), |session| {
            Ok(session.inputs().len())
        });
        assert_eq!(r1.unwrap(), 1);
        assert_eq!(r2.unwrap(), 1);
        assert_eq!(r3.unwrap(), 1);
    }

    #[test]
    fn successful_runs_keep_warm_session() {
        // Batch 1.1 CP3: serial with_session calls reuse the loaded session.
        let _lock = lock_session_cache_for_test();
        let _ = invalidate_all_sessions();
        let mut loads = 0usize;

        with_session(
            "u2netp",
            EP_CPU,
            || {
                loads += 1;
                Ok(U2NETP_MODEL_BYTES.to_vec())
            },
            |session| Ok(session.inputs().len()),
        )
        .unwrap();
        assert_eq!(loads, 1);

        with_session(
            "u2netp",
            EP_CPU,
            || {
                loads += 1;
                Ok(U2NETP_MODEL_BYTES.to_vec())
            },
            |session| Ok(session.inputs().len()),
        )
        .unwrap();
        assert_eq!(loads, 1, "warm session must not reload on success");
    }

    #[test]
    fn multi_run_inside_one_with_session_loads_once() {
        let _lock = lock_session_cache_for_test();
        let _ = invalidate_all_sessions();
        let mut loads = 0usize;
        let runs = with_session(
            "u2netp",
            EP_CPU,
            || {
                loads += 1;
                Ok(U2NETP_MODEL_BYTES.to_vec())
            },
            |session| {
                let mut n = 0;
                for _ in 0..3 {
                    n += session.inputs().len();
                }
                Ok(n)
            },
        )
        .unwrap();
        assert_eq!(runs, 3);
        assert_eq!(loads, 1);
    }

    #[test]
    fn is_likely_oom_detects_directml_and_generic_messages() {
        assert!(is_likely_oom(&crate::error::inference_error(
            "Non-zero status code ... DmlCommittedResourceAllocator.cpp ... 8007000E No hay suficientes recursos de memoria"
        )));
        assert!(is_likely_oom(&crate::error::inference_error(
            "No hay suficientes recursos de memoria disponibles para completar esta operaci\u{00f3}n"
        )));
        assert!(is_likely_oom(&crate::error::inference_error("CUDA out of memory")));
        assert!(is_likely_oom(&crate::error::inference_error("std::bad_alloc")));
        assert!(!is_likely_oom(&crate::error::inference_error(
            "model produced no outputs"
        )));
        // Bare "oom" was removed — incidental substrings must not wipe the cache.
        assert!(!is_likely_oom(&crate::error::inference_error(
            "failed in room setup"
        )));
        assert!(!is_likely_oom(&crate::error::inference_error("zoom level invalid")));
    }

    #[test]
    fn failed_run_drops_cached_session() {
        let _lock = lock_session_cache_for_test();
        let _ = invalidate_all_sessions();
        let mut load_count = 0usize;
        let load = || {
            load_count += 1;
            Ok(U2NETP_MODEL_BYTES.to_vec())
        };

        let err: Result<(), AppError> = with_session("u2netp", EP_CPU, load, |_session| {
            Err(crate::error::inference_error("model produced no outputs"))
        });
        assert!(err.is_err());

        // Session was dropped after error → next call must reload model bytes.
        let ok = with_session(
            "u2netp",
            EP_CPU,
            || {
                load_count += 1;
                Ok(U2NETP_MODEL_BYTES.to_vec())
            },
            |session| Ok(session.inputs().len()),
        );
        assert_eq!(ok.unwrap(), 1);
        assert_eq!(load_count, 2);
    }

    #[test]
    fn oom_run_clears_all_cached_sessions() {
        let _lock = lock_session_cache_for_test();
        let _ = invalidate_all_sessions();

        // Success-path unload empties the map after each with_session, so seed a
        // second live key via the test inject. During the OOM with_session, both
        // "other" and "u2netp" are present; guard.take() must wipe both.
        // If OOM only removed the active key, "other" would stay and reloads==0.
        let other = load_session_from_bytes(U2NETP_MODEL_BYTES, EP_CPU).unwrap();
        insert_session_for_test("other", EP_CPU, other);

        let mut reloads = 0usize;
        let oom: Result<(), AppError> = with_session(
            "u2netp",
            EP_CPU,
            || Ok(U2NETP_MODEL_BYTES.to_vec()),
            |_s| {
                Err(crate::error::inference_error(
                    "DmlCommittedResourceAllocator 8007000E out of memory",
                ))
            },
        );
        assert!(oom.is_err());

        with_session(
            "other",
            EP_CPU,
            || {
                reloads += 1;
                Ok(U2NETP_MODEL_BYTES.to_vec())
            },
            |s| Ok(s.inputs().len()),
        )
        .unwrap();
        assert_eq!(
            reloads, 1,
            "OOM must wipe sibling sessions, not only the failing key"
        );
    }

    #[test]
    fn invalidate_all_sessions_forces_reload() {
        let _lock = lock_session_cache_for_test();
        let _ = invalidate_all_sessions();
        let mut loads = 0usize;
        with_session(
            "u2netp",
            EP_CPU,
            || {
                loads += 1;
                Ok(U2NETP_MODEL_BYTES.to_vec())
            },
            |s| Ok(s.inputs().len()),
        )
        .unwrap();
        assert_eq!(loads, 1);

        let _ = invalidate_all_sessions();
        with_session(
            "u2netp",
            EP_CPU,
            || {
                loads += 1;
                Ok(U2NETP_MODEL_BYTES.to_vec())
            },
            |s| Ok(s.inputs().len()),
        )
        .unwrap();
        assert_eq!(loads, 2);
    }
}
