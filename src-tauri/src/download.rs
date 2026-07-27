use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

use crate::error::AppError;

pub struct DownloadState {
    busy: AtomicBool,
    cancel: AtomicBool,
    idle_notify: Notify,
}

impl DownloadState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            idle_notify: Notify::new(),
        })
    }

    /// Acquire the single-flight download slot or reject if another download is active.
    pub fn try_acquire(&self) -> Result<(), AppError> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(AppError::DownloadBusy);
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn release(&self) {
        self.busy.store(false, Ordering::SeqCst);
        self.idle_notify.notify_waiters();
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

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

    /// Wait until the download slot is free.
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

/// Releases the download slot when dropped.
pub struct DownloadSlotGuard(pub Arc<DownloadState>);

impl Drop for DownloadSlotGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_rejects_while_busy() {
        let state = DownloadState::new();
        state.try_acquire().unwrap();
        let err = state.try_acquire().unwrap_err();
        assert!(err.to_string().contains("download already in progress"));
        state.release();
        state.try_acquire().unwrap();
    }

    #[tokio::test]
    async fn cancel_download_noop_when_idle() {
        let state = DownloadState::new();
        assert!(!state.is_busy());
        state.cancel();
        state.wait_until_idle().await;
    }

    #[tokio::test]
    async fn wait_until_idle_unblocks_on_release() {
        let state = DownloadState::new();
        state.try_acquire().unwrap();
        let s = state.clone();
        let waiter = tokio::spawn(async move {
            s.wait_until_idle().await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        state.release();
        waiter.await.unwrap();
    }

    /// Stress the subscribe-before-check pattern: immediate release must not hang.
    #[tokio::test]
    async fn wait_until_idle_no_lost_wakeup() {
        for _ in 0..200 {
            let state = DownloadState::new();
            state.try_acquire().unwrap();
            let s = state.clone();
            let waiter = tokio::spawn(async move {
                s.wait_until_idle().await;
            });
            // No artificial delay — maximize the race window with release.
            state.release();
            tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
                .await
                .expect("wait_until_idle hung (lost Notify wakeup)")
                .unwrap();
        }
    }
}
