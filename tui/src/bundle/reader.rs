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

/// True when a manifest-relative path stays inside the bundle directory:
/// relative, and made of plain name components only (no `..`, no roots).
fn is_contained(relative: &str) -> bool {
    let path = Path::new(relative);
    !relative.is_empty()
        && path.is_relative()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

/// Resolve a bundle file to its canonical path, requiring the target to stay
/// inside the bundle after following symlinks. The lexical check above
/// rejects `..` and absolute components, but a plain-looking name can still
/// be a symlink pointing outside the bundle.
pub fn contained_path(bundle_dir: &Path, path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    let base = bundle_dir.canonicalize().ok()?;
    canonical.starts_with(&base).then_some(canonical)
}

/// Read a bundle document, refusing targets that resolve outside the bundle.
pub fn read_contained(bundle_dir: &Path, path: &Path) -> Option<String> {
    std::fs::read_to_string(contained_path(bundle_dir, path)?).ok()
}

pub fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = dir.join("manifest.json");
    // The manifest itself gets the same symlink containment as the documents
    // it names: a manifest.json pointing outside the bundle must not be read.
    let raw = read_contained(dir, &path)
        .with_context(|| format!("reading {} inside the bundle", path.display()))?;
    let manifest: Manifest =
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
    anyhow::ensure!(
        manifest.schema == RUN_BUNDLE_SCHEMA,
        "unsupported bundle schema {:?} in {}",
        manifest.schema,
        path.display()
    );
    // Manifest paths are attacker-adjacent input (bundles can be copied
    // around); a path escaping the bundle directory must never be read.
    let entries = [
        Some(&manifest.paths.workflow),
        Some(&manifest.paths.state),
        Some(&manifest.paths.trace),
        manifest.paths.session.as_ref(),
        manifest.paths.artifacts.as_ref(),
    ];
    for entry in entries.into_iter().flatten() {
        anyhow::ensure!(
            is_contained(entry),
            "manifest path {entry:?} escapes the bundle in {}",
            path.display()
        );
    }
    Ok(manifest)
}

fn read_json<T: serde::de::DeserializeOwned>(bundle_dir: &Path, path: &Path) -> Result<T> {
    let raw = read_contained(bundle_dir, path)
        .with_context(|| format!("reading {} inside the bundle", path.display()))?;
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
    let state: RunState = read_json(dir, &paths.state)?;
    let snapshot: Option<DefinitionSnapshot> = read_json(dir, &paths.workflow).ok();
    let trace: Vec<TraceEvent> = read_contained(dir, &paths.trace)
        .map(|raw| parse_ndjson(&raw))
        .unwrap_or_default();
    let session_binding = paths
        .session_binding()
        .and_then(|path| read_json(dir, &path).ok());
    let session_entries = paths
        .session_entries()
        .and_then(|path| read_contained(dir, &path))
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
                // The declared size is a cheap first filter; the read below
                // re-checks the actual file size, which a malformed bundle
                // can understate.
                let text = if reference.bytes <= max_bytes {
                    read_artifact_checked(bundle_dir, &reference.path, max_bytes)
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

/// Read an artifact file, refusing paths that escape the bundle directory
/// and files whose actual size exceeds `max_bytes` (the size declared by the
/// reference is untrusted).
pub fn read_artifact_checked(bundle_dir: &Path, relative: &str, max_bytes: u64) -> Option<String> {
    let canonical = contained_path(bundle_dir, &bundle_dir.join(relative))?;
    if std::fs::metadata(&canonical).ok()?.len() > max_bytes {
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
