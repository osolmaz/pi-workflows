use crate::source::WindowCursor;
use crate::state::reader::{LoadedRun, ProjectionReader};
use anyhow::Result;
use std::path::Path;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;

#[derive(Debug, Clone)]
pub struct LoadRequest {
    pub run_id: String,
    pub cursor: WindowCursor,
    pub generation: u64,
}

pub struct LoadResult {
    pub run_id: String,
    pub generation: u64,
    pub loaded: std::result::Result<LoadedRun, String>,
}

#[derive(Default)]
struct Mailbox {
    pending: Option<LoadRequest>,
    shutdown: bool,
}

pub struct SourceLoader {
    mailbox: Arc<(Mutex<Mailbox>, Condvar)>,
    results: mpsc::Receiver<LoadResult>,
    worker: Option<JoinHandle<()>>,
}

impl SourceLoader {
    pub fn new(database_path: &Path) -> Result<Self> {
        let reader = ProjectionReader::open(database_path)?;
        let mailbox = Arc::new((Mutex::new(Mailbox::default()), Condvar::new()));
        let worker_mailbox = Arc::clone(&mailbox);
        let (result_tx, results) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("piw-projection-reader".to_string())
            .spawn(move || worker_loop(reader, worker_mailbox, result_tx))?;
        Ok(Self {
            mailbox,
            results,
            worker: Some(worker),
        })
    }

    pub fn submit(&self, request: LoadRequest) {
        let (lock, wake) = &*self.mailbox;
        let mut mailbox = lock.lock().unwrap();
        mailbox.pending = Some(request);
        wake.notify_one();
    }

    pub fn drain(&self) -> Vec<LoadResult> {
        self.results.try_iter().collect()
    }
}

impl Drop for SourceLoader {
    fn drop(&mut self) {
        let (lock, wake) = &*self.mailbox;
        {
            let mut mailbox = lock.lock().unwrap();
            mailbox.shutdown = true;
            mailbox.pending = None;
            wake.notify_all();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn worker_loop(
    reader: ProjectionReader,
    mailbox: Arc<(Mutex<Mailbox>, Condvar)>,
    results: mpsc::Sender<LoadResult>,
) {
    loop {
        let request = {
            let (lock, wake) = &*mailbox;
            let mut state = lock.lock().unwrap();
            while state.pending.is_none() && !state.shutdown {
                state = wake.wait(state).unwrap();
            }
            if state.shutdown {
                return;
            }
            state.pending.take()
        };
        let Some(request) = request else {
            continue;
        };
        let loaded = reader
            .read_window(
                &request.run_id,
                request.cursor.step,
                request.cursor.trace,
                request.cursor.session_entry,
                request.cursor.session_event,
            )
            .map_err(|error| error.to_string());
        if results
            .send(LoadResult {
                run_id: request.run_id,
                generation: request.generation,
                loaded,
            })
            .is_err()
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_request_slot_keeps_only_the_newest_selection() {
        let mut mailbox = Mailbox {
            pending: Some(LoadRequest {
                run_id: "older".to_string(),
                cursor: WindowCursor::default(),
                generation: 1,
            }),
            shutdown: false,
        };
        mailbox.pending = Some(LoadRequest {
            run_id: "newer".to_string(),
            cursor: WindowCursor::default(),
            generation: 2,
        });
        let pending = mailbox.pending.take().expect("newest pending request");
        assert_eq!(pending.run_id, "newer");
        assert_eq!(pending.generation, 2);
        assert!(mailbox.pending.is_none());
    }
}
