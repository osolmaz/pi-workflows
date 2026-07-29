//! Filesystem watching for the runs directory. Events are debounced into a
//! single "something changed" tick on a tokio channel; consumers rescan the
//! directory and poll their tailers, which is cheap and race-free because
//! all bundle files are either append-only or atomically replaced.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::time::Duration;
use tokio::sync::mpsc;

pub struct RunsWatcher {
    // Held for its Drop side effect: dropping stops the watcher thread.
    _watcher: RecommendedWatcher,
    rx: mpsc::Receiver<()>,
}

impl RunsWatcher {
    pub fn new(runs_dir: &Path) -> notify::Result<Self> {
        let (tx, rx) = mpsc::channel(1);
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if result.is_ok() {
                    // try_send: a pending tick already guarantees a rescan.
                    let _ = tx.try_send(());
                }
            })?;
        watcher.watch(runs_dir, RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            rx,
        })
    }

    /// Wait until something under the runs directory changed, coalescing
    /// bursts of events with a short quiet period.
    pub async fn changed(&mut self) {
        if self.rx.recv().await.is_none() {
            // Watcher gone; fall back to slow polling so the UI stays live.
            tokio::time::sleep(Duration::from_secs(2)).await;
            return;
        }
        // Absorb the burst that a single logical write produces.
        while let Ok(Some(())) =
            tokio::time::timeout(Duration::from_millis(40), self.rx.recv()).await
        {}
    }
}
