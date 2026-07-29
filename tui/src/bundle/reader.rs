//! Reading run bundles from disk: manifest discovery, full bundle loads,
//! and artifact resolution. Malformed bundles are skipped, matching the
//! TypeScript store's `listRunBundles` behavior.

use crate::bundle::types::{
    as_artifact_ref, DefinitionSnapshot, Manifest, RunState, SessionBinding, SessionEntryRecord,
    TraceEvent, RUN_BUNDLE_SCHEMA,
};
use anyhow::{Context, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct BundlePaths {
    pub dir: PathBuf,
    pub workflow: PathBuf,
    pub state: PathBuf,
    pub trace: PathBuf,
    pub session: Option<PathBuf>,
    pub artifacts: Option<PathBuf>,
}

impl BundlePaths {
    pub fn from_manifest(dir: &Path, manifest: &Manifest) -> Self {
        Self {
            dir: dir.to_path_buf(),
            workflow: dir.join(&manifest.paths.workflow),
            state: dir.join(&manifest.paths.state),
            trace: dir.join(&manifest.paths.trace),
            session: manifest.paths.session.as_ref().map(|p| dir.join(p)),
            artifacts: manifest.paths.artifacts.as_ref().map(|p| dir.join(p)),
        }
    }

    pub fn session_binding(&self) -> Option<PathBuf> {
        self.session.as_ref().map(|dir| dir.join("binding.json"))
    }

    pub fn session_entries(&self) -> Option<PathBuf> {
        self.session.as_ref().map(|dir| dir.join("entries.ndjson"))
    }
}

#[derive(Debug, Clone)]
pub struct LoadedBundle {
    pub manifest: Manifest,
    pub paths: BundlePaths,
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub trace: Vec<TraceEvent>,
    pub session_binding: Option<SessionBinding>,
    pub session_entries: Vec<SessionEntryRecord>,
}

pub fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = dir.join("manifest.json");
    let raw =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let manifest: Manifest =
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
    anyhow::ensure!(
        manifest.schema == RUN_BUNDLE_SCHEMA,
        "unsupported bundle schema {:?} in {}",
        manifest.schema,
        path.display()
    );
    Ok(manifest)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let raw =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))
}

/// Parse NDJSON, skipping blank lines and a trailing partial line (a writer
/// may be mid-append when we read).
pub fn parse_ndjson<T: serde::de::DeserializeOwned>(raw: &str) -> Vec<T> {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

pub fn read_bundle(dir: &Path) -> Result<LoadedBundle> {
    let manifest = read_manifest(dir)?;
    let paths = BundlePaths::from_manifest(dir, &manifest);
    let state: RunState = read_json(&paths.state)?;
    let snapshot: Option<DefinitionSnapshot> = read_json(&paths.workflow).ok();
    let trace: Vec<TraceEvent> = std::fs::read_to_string(&paths.trace)
        .map(|raw| parse_ndjson(&raw))
        .unwrap_or_default();
    let session_binding = paths
        .session_binding()
        .and_then(|path| read_json(&path).ok());
    let session_entries = paths
        .session_entries()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|raw| parse_ndjson(&raw))
        .unwrap_or_default();
    Ok(LoadedBundle {
        manifest,
        paths,
        state,
        snapshot,
        trace,
        session_binding,
        session_entries,
    })
}

/// List all readable bundles in a runs directory, newest first (by
/// `startedAt`, then run id, matching the TypeScript store).
pub fn list_bundles(runs_dir: &Path) -> Vec<(PathBuf, Manifest)> {
    let Ok(entries) = std::fs::read_dir(runs_dir) else {
        return Vec::new();
    };
    let mut bundles: Vec<(PathBuf, Manifest)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let dir = entry.path();
            read_manifest(&dir).ok().map(|manifest| (dir, manifest))
        })
        .collect();
    bundles.sort_by(|a, b| {
        b.1.started_at
            .cmp(&a.1.started_at)
            .then_with(|| b.1.run_id.cmp(&a.1.run_id))
    });
    bundles
}

/// Compact placeholder for an artifact reference, matching the TypeScript
/// viewer: `«artifact 12.3KB artifacts/sha256/…»`.
pub fn artifact_placeholder(path: &str, bytes: u64) -> String {
    let size = if bytes < 1024 {
        format!("{bytes}B")
    } else {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    };
    format!("«artifact {size} {path}»")
}

/// Resolve `$artifact` references in a value by inlining artifact file
/// contents (up to `max_bytes` per artifact) from the bundle directory.
/// References that escape the bundle directory or exceed the limit are
/// replaced by placeholders.
pub fn resolve_artifacts(value: &Value, bundle_dir: &Path, max_bytes: u64) -> Value {
    match value {
        Value::Object(_) => {
            if let Some(reference) = as_artifact_ref(value) {
                let text = if reference.bytes <= max_bytes {
                    read_artifact_checked(bundle_dir, &reference.path)
                } else {
                    None
                };
                return match text {
                    Some(text) => Value::String(text),
                    None => Value::String(artifact_placeholder(&reference.path, reference.bytes)),
                };
            }
            if let Some(inner) = crate::bundle::types::as_escaped(value) {
                return resolve_artifacts(inner, bundle_dir, max_bytes);
            }
            let object = value.as_object().unwrap();
            Value::Object(
                object
                    .iter()
                    .map(|(key, value)| {
                        (key.clone(), resolve_artifacts(value, bundle_dir, max_bytes))
                    })
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve_artifacts(item, bundle_dir, max_bytes))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Read an artifact file, refusing paths that escape the bundle directory.
pub fn read_artifact_checked(bundle_dir: &Path, relative: &str) -> Option<String> {
    let resolved = bundle_dir.join(relative);
    let canonical = resolved.canonicalize().ok()?;
    let base = bundle_dir.canonicalize().ok()?;
    if !canonical.starts_with(&base) {
        return None;
    }
    std::fs::read_to_string(canonical).ok()
}

/// Replace `$artifact` references with compact placeholders for previews,
/// mirroring the TypeScript viewer's `withArtifactPlaceholders`.
pub fn with_artifact_placeholders(value: &Value) -> Value {
    match value {
        Value::Object(_) => {
            if let Some(reference) = as_artifact_ref(value) {
                return Value::String(artifact_placeholder(&reference.path, reference.bytes));
            }
            if let Some(inner) = crate::bundle::types::as_escaped(value) {
                return with_artifact_placeholders(inner);
            }
            let object = value.as_object().unwrap();
            Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), with_artifact_placeholders(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(with_artifact_placeholders).collect()),
        other => other.clone(),
    }
}
