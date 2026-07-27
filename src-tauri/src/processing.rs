use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::error::AppError;

pub struct ProcessingState {
    cancel: AtomicBool,
    busy: AtomicBool,
    /// Job id currently holding the slot; cancel only applies when it matches.
    active_job_id: Mutex<Option<String>>,
    idle_notify: Notify,
}

impl ProcessingState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cancel: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            active_job_id: Mutex::new(None),
            idle_notify: Notify::new(),
        })
    }

    /// Acquire the single-flight inference slot or reject if a job is active.
    pub fn try_acquire(&self, job_id: &str) -> Result<(), AppError> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(AppError::Busy);
        }
        self.cancel.store(false, Ordering::SeqCst);
        *self
            .active_job_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(job_id.to_string());
        Ok(())
    }

    pub fn release(&self) {
        // Clear job identity *before* freeing the slot so a waiter that
        // returns from `wait_until_idle` and immediately `try_acquire`s cannot
        // have its new `active_job_id` wiped by this release.
        *self
            .active_job_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        self.busy.store(false, Ordering::SeqCst);
        self.idle_notify.notify_waiters();
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Request cancel only if `job_id` is still the active worker (ignores stale IPC).
    ///
    /// Returns `true` when the cancel flag was armed for this job (caller should
    /// wait for idle). Returns `false` for stale ids so waiters do not block on
    /// an unrelated job.
    pub fn cancel_job(&self, job_id: &str) -> bool {
        let active = self
            .active_job_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if active.as_deref() == Some(job_id) {
            self.cancel.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// Unscoped cancel — tests and internal use when the active job is known.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn check_cancel(&self) -> Result<(), AppError> {
        if self.cancel.load(Ordering::SeqCst) {
            Err(AppError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Wait until the inference slot is free.
    ///
    /// Subscribes to [`Notify`] *before* re-checking `busy` so a `release()` that
    /// races between the load and `notified().await` cannot lose the wakeup
    /// (`notify_waiters` does not store a permit).
    pub async fn wait_until_idle(&self) {
        loop {
            let notified = self.idle_notify.notified();
            if !self.busy.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

/// Releases the inference slot when dropped.
pub struct ProcessingSlotGuard(pub Arc<ProcessingState>);

impl Drop for ProcessingSlotGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_sets_and_acquire_clears_token() {
        let state = ProcessingState::new();
        assert!(!state.cancel.load(Ordering::SeqCst));
        state.cancel();
        assert!(state.cancel.load(Ordering::SeqCst));
        assert!(state.check_cancel().is_err());
        state.try_acquire("job-a").unwrap();
        assert!(!state.cancel.load(Ordering::SeqCst));
        assert!(state.check_cancel().is_ok());
        state.release();
    }

    #[test]
    fn second_acquire_rejects_while_busy() {
        let state = ProcessingState::new();
        state.try_acquire("job-a").unwrap();
        assert!(state.is_busy());
        let err = state.try_acquire("job-b").unwrap_err();
        assert!(
            err.to_string().contains("already processing"),
            "got {err}"
        );
        state.release();
        assert!(!state.is_busy());
        state.try_acquire("job-b").unwrap();
        state.release();
    }

    #[test]
    fn slot_guard_releases_on_drop() {
        let state = ProcessingState::new();
        state.try_acquire("job-a").unwrap();
        {
            let _guard = ProcessingSlotGuard(Arc::clone(&state));
            assert!(state.is_busy());
        }
        assert!(!state.is_busy());
    }

    #[test]
    fn cancel_job_ignores_stale_id() {
        let state = ProcessingState::new();
        state.try_acquire("job-new").unwrap();
        assert!(!state.cancel_job("job-old"));
        assert!(state.check_cancel().is_ok());
        assert!(state.cancel_job("job-new"));
        assert!(state.check_cancel().is_err());
        state.release();
    }

    #[test]
    fn release_then_acquire_preserves_new_job_identity() {
        let state = ProcessingState::new();
        state.try_acquire("job-old").unwrap();
        state.release();
        state.try_acquire("job-new").unwrap();
        let active = state
            .active_job_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        assert_eq!(active.as_deref(), Some("job-new"));
        assert!(state.cancel_job("job-new"));
        assert!(!state.cancel_job("job-old"));
        state.release();
    }

    #[tokio::test]
    async fn wait_until_idle_unblocks_on_release() {
        let state = ProcessingState::new();
        state.try_acquire("job-a").unwrap();
        let s = Arc::clone(&state);
        let waiter = tokio::spawn(async move {
            s.wait_until_idle().await;
        });
        tokio::task::yield_now().await;
        state.release();
        waiter.await.expect("waiter panicked");
        assert!(!state.is_busy());
    }

    /// Stress the subscribe-before-check pattern: immediate release must not hang.
    #[tokio::test]
    async fn wait_until_idle_no_lost_wakeup() {
        for _ in 0..200 {
            let state = ProcessingState::new();
            state.try_acquire("job-a").unwrap();
            let s = Arc::clone(&state);
            let waiter = tokio::spawn(async move {
                s.wait_until_idle().await;
            });
            // No artificial delay — maximize the race window with release.
            state.release();
            tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
                .await
                .expect("wait_until_idle hung (lost Notify wakeup)")
                .expect("waiter panicked");
        }
    }

    /// Concurrent release + try_acquire must leave the new job's id active.
    #[tokio::test]
    async fn acquire_during_release_keeps_new_job_id() {
        for i in 0..200 {
            let state = ProcessingState::new();
            state.try_acquire("job-old").unwrap();
            let s = Arc::clone(&state);
            let new_id = format!("job-new-{i}");
            let acquirer = std::thread::spawn({
                let s = Arc::clone(&s);
                let new_id = new_id.clone();
                move || {
                    // Spin until slot free, then acquire.
                    loop {
                        if s.try_acquire(&new_id).is_ok() {
                            break;
                        }
                        std::hint::spin_loop();
                    }
                }
            });
            state.release();
            acquirer.join().expect("acquirer panicked");
            let active = state
                .active_job_id
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            assert_eq!(
                active.as_deref(),
                Some(new_id.as_str()),
                "release clobbered newly acquired job id"
            );
            assert!(state.cancel_job(&new_id));
            state.release();
        }
    }
}
