//! Incremental NDJSON tailing. `trace.ndjson` and `session/entries.ndjson`
//! are append-only, so a tailer only ever reads bytes past its offset. A
//! partial trailing line (a writer mid-append) is buffered until the newline
//! arrives. Truncation (which the format forbids) resets the tailer.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub struct NdjsonTailer {
    path: PathBuf,
    /// When set, the path must canonicalize inside this directory on every
    /// poll: the file name comes from an untrusted manifest and could be a
    /// symlink out of the bundle.
    base: Option<PathBuf>,
    offset: u64,
    partial: Vec<u8>,
}

impl NdjsonTailer {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            base: None,
            offset: 0,
            partial: Vec::new(),
        }
    }

    /// A tailer that refuses to read once `path` resolves outside `base`.
    pub fn contained(path: &Path, base: &Path) -> Self {
        Self {
            base: Some(base.to_path_buf()),
            ..Self::new(path)
        }
    }

    /// Read complete new lines appended since the last poll and parse each
    /// as `T`. Unparsable lines are skipped.
    pub fn poll<T: serde::de::DeserializeOwned>(&mut self) -> std::io::Result<Vec<T>> {
        let path = match &self.base {
            Some(base) => {
                // A missing file canonicalizes to None too; treat both the
                // not-yet-written and the escaping case as "nothing to read".
                match crate::bundle::reader::contained_path(base, &self.path) {
                    Some(path) => path,
                    None => return Ok(Vec::new()),
                }
            }
            None => self.path.clone(),
        };
        let mut file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let len = file.metadata()?.len();
        if len < self.offset {
            // Truncated (should never happen for append-only files): re-read.
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buffer = Vec::with_capacity((len - self.offset) as usize);
        file.take(len - self.offset).read_to_end(&mut buffer)?;
        self.offset = len;
        self.partial.extend_from_slice(&buffer);

        let mut records = Vec::new();
        while let Some(newline) = self.partial.iter().position(|&byte| byte == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=newline).collect();
            let line = &line[..line.len() - 1];
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            if let Ok(record) = serde_json::from_slice::<T>(line) {
                records.push(record);
            }
        }
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[derive(serde::Deserialize, PartialEq, Debug)]
    struct Row {
        seq: u64,
    }

    #[test]
    fn tails_appends_and_buffers_partial_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trace.ndjson");
        let mut tailer = NdjsonTailer::new(&path);
        assert_eq!(tailer.poll::<Row>().unwrap(), Vec::<Row>::new());

        std::fs::write(&path, "{\"seq\":1}\n{\"seq\":2}\n{\"se").unwrap();
        assert_eq!(
            tailer.poll::<Row>().unwrap(),
            vec![Row { seq: 1 }, Row { seq: 2 }]
        );

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"q\":3}\n").unwrap();
        drop(file);
        assert_eq!(tailer.poll::<Row>().unwrap(), vec![Row { seq: 3 }]);
        assert_eq!(tailer.poll::<Row>().unwrap(), Vec::<Row>::new());
    }
}
