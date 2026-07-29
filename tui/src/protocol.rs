//! Wire types for the live replay protocol (`pi-workflows.replay.v1`), plus
//! the JSON Patch subset (with the `append` extension op) used for view
//! synchronization. See `docs/live-replay-protocol.md`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_ID: &str = "pi-workflows.replay.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    WatchRuns,
    WatchRun {
        #[serde(rename = "runId")]
        run_id: String,
    },
    UnwatchRun {
        #[serde(rename = "runId")]
        run_id: String,
    },
    FetchArtifact {
        #[serde(rename = "runId")]
        run_id: String,
        path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Hello {
        protocol: String,
    },
    Runs {
        runs: Vec<Value>,
    },
    RunSnapshot {
        #[serde(rename = "runId")]
        run_id: String,
        revision: u64,
        view: Value,
    },
    RunPatch {
        #[serde(rename = "runId")]
        run_id: String,
        revision: u64,
        patch: Vec<PatchOp>,
    },
    Artifact {
        #[serde(rename = "runId")]
        run_id: String,
        path: String,
        content: String,
    },
    Error {
        message: String,
        #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
    },
}

/// RFC 6902 ops we use, plus `append` (add a batch of items to an array).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PatchOp {
    Add { path: String, value: Value },
    Replace { path: String, value: Value },
    Remove { path: String },
    Append { path: String, value: Vec<Value> },
}

/// Apply a patch to a view document in place. Returns an error message on
/// the first op that does not apply (the caller should resnapshot).
pub fn apply_patch(target: &mut Value, patch: &[PatchOp]) -> Result<(), String> {
    for op in patch {
        match op {
            PatchOp::Add { path, value } => {
                set_path(target, path, value.clone(), false)?;
            }
            PatchOp::Replace { path, value } => {
                set_path(target, path, value.clone(), true)?;
            }
            PatchOp::Remove { path } => {
                remove_path(target, path)?;
            }
            PatchOp::Append { path, value } => {
                let array = resolve_path(target, path)?
                    .as_array_mut()
                    .ok_or_else(|| format!("append target {path} is not an array"))?;
                array.extend(value.iter().cloned());
            }
        }
    }
    Ok(())
}

fn unescape_token(token: &str) -> String {
    token.replace("~1", "/").replace("~0", "~")
}

fn resolve_path<'a>(target: &'a mut Value, path: &str) -> Result<&'a mut Value, String> {
    let mut current = target;
    for token in path.split('/').skip(1) {
        let token = unescape_token(token);
        current = match current {
            Value::Object(object) => object
                .get_mut(&token)
                .ok_or_else(|| format!("missing key {token} in {path}"))?,
            Value::Array(array) => {
                let index: usize = token
                    .parse()
                    .map_err(|_| format!("bad array index {token} in {path}"))?;
                array
                    .get_mut(index)
                    .ok_or_else(|| format!("index {index} out of bounds in {path}"))?
            }
            _ => return Err(format!("cannot traverse into scalar at {token} in {path}")),
        };
    }
    Ok(current)
}

fn set_path(target: &mut Value, path: &str, value: Value, replace: bool) -> Result<(), String> {
    if path.is_empty() {
        *target = value;
        return Ok(());
    }
    let Some((parent_path, key)) = path.rsplit_once('/') else {
        return Err(format!("bad path {path}"));
    };
    let parent = resolve_path(target, parent_path)?;
    let key = unescape_token(key);
    match parent {
        Value::Object(object) => {
            if replace && !object.contains_key(&key) {
                return Err(format!("missing key {key} in {path}"));
            }
            object.insert(key, value);
            Ok(())
        }
        Value::Array(array) => {
            if !replace && key == "-" {
                array.push(value);
                return Ok(());
            }
            let index: usize = key
                .parse()
                .map_err(|_| format!("bad array index {key} in {path}"))?;
            if replace {
                let member = array
                    .get_mut(index)
                    .ok_or_else(|| format!("index {index} out of bounds in {path}"))?;
                *member = value;
                return Ok(());
            }
            if index > array.len() {
                return Err(format!("index {index} out of bounds in {path}"));
            }
            array.insert(index, value);
            Ok(())
        }
        _ => Err(format!("cannot set {key} on scalar in {path}")),
    }
}

fn remove_path(target: &mut Value, path: &str) -> Result<(), String> {
    let Some((parent_path, key)) = path.rsplit_once('/') else {
        return Err(format!("bad path {path}"));
    };
    let parent = resolve_path(target, parent_path)?;
    let key = unescape_token(key);
    match parent {
        Value::Object(object) => {
            object
                .remove(&key)
                .ok_or_else(|| format!("missing key {key} in {path}"))?;
            Ok(())
        }
        Value::Array(array) => {
            let index: usize = key
                .parse()
                .map_err(|_| format!("bad array index {key} in {path}"))?;
            if index >= array.len() {
                return Err(format!("index {index} out of bounds in {path}"));
            }
            array.remove(index);
            Ok(())
        }
        _ => Err(format!("cannot remove {key} from scalar in {path}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applies_replace_append_and_remove() {
        let mut view = json!({ "state": { "status": "running" }, "events": [1] });
        apply_patch(
            &mut view,
            &[
                PatchOp::Replace {
                    path: "/state/status".into(),
                    value: json!("completed"),
                },
                PatchOp::Append {
                    path: "/events".into(),
                    value: vec![json!(2), json!(3)],
                },
                PatchOp::Add {
                    path: "/session".into(),
                    value: json!({ "binding": null, "entries": [] }),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            view,
            json!({
                "state": { "status": "completed" },
                "events": [1, 2, 3],
                "session": { "binding": null, "entries": [] }
            })
        );
        apply_patch(
            &mut view,
            &[PatchOp::Remove {
                path: "/session".into(),
            }],
        )
        .unwrap();
        assert!(view.get("session").is_none());
    }

    #[test]
    fn array_add_inserts_but_replace_overwrites() {
        let mut view = json!({ "events": [1, 2] });
        apply_patch(
            &mut view,
            &[
                PatchOp::Add {
                    path: "/events/1".into(),
                    value: json!(3),
                },
                PatchOp::Replace {
                    path: "/events/0".into(),
                    value: json!(4),
                },
            ],
        )
        .unwrap();
        assert_eq!(view, json!({ "events": [4, 3, 2] }));
    }

    #[test]
    fn escapes_json_pointer_tokens() {
        let mut view = json!({ "a/b": { "c~d": 1 } });
        apply_patch(
            &mut view,
            &[PatchOp::Replace {
                path: "/a~1b/c~0d".into(),
                value: json!(2),
            }],
        )
        .unwrap();
        assert_eq!(view, json!({ "a/b": { "c~d": 2 } }));
    }

    #[test]
    fn gap_or_missing_path_errors() {
        let mut view = json!({ "events": [] });
        assert!(apply_patch(
            &mut view,
            &[PatchOp::Replace {
                path: "/missing/deep".into(),
                value: json!(1),
            }],
        )
        .is_err());
    }
}
