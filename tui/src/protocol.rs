//! Strict version-1 client envelopes shared by local and remote piw transports.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PROTOCOL_ID: &str = "pi-workflows.client.v1";

const OPERATIONS: &[&str] = &[
    "run.start",
    "run.pause",
    "run.resume",
    "run.cancel",
    "run.status",
    "run.list",
    "checkpoint.answer",
    "decision.answer",
    "interaction.submit",
    "interaction.update",
    "notification.claim",
    "notification.deliver",
    "turn.claim",
    "turn.resolve",
    "controller.list",
    "controller.get",
    "controller.apply",
    "controller.reconcile",
    "controller.delete",
    "host.status",
    "host.stop",
    "view.runs.watch",
    "view.run.watch",
    "view.run.unwatch",
    "view.page",
    "view.session.watch",
    "activity.report",
    "state.status",
    "state.verify",
    "state.backup",
    "state.prune",
];

const OUTCOMES: &[&str] = &[
    "accepted",
    "adopted",
    "rejected",
    "conflict",
    "notFound",
    "claimLost",
    "unavailable",
];

const EVENTS: &[&str] = &[
    "runs",
    "run_snapshot",
    "run_patch",
    "run_page",
    "session_snapshot",
    "unavailable",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientRequest {
    pub schema: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub operation: String,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(rename = "expectedRevision", skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerHello {
    pub schema: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "packageVersion")]
    pub package_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerResponse {
    pub schema: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub outcome: String,
    pub revision: Option<u64>,
    pub receipt: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerEvent {
    pub schema: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "subscriptionId")]
    pub subscription_id: String,
    pub event: String,
    pub revision: Option<u64>,
    #[serde(rename = "runId")]
    pub run_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub enum ServerMessage {
    Hello(ServerHello),
    Response(ServerResponse),
    Event(ServerEvent),
}

pub fn parse_client_request(text: &str) -> Result<ClientRequest, String> {
    let value = parse_canonical_value(text)?;
    let request: ClientRequest =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    if request.schema != PROTOCOL_ID
        || request.message_type != "request"
        || !valid_id(&request.request_id)
        || !valid_id(&request.client_id)
        || !valid_id(&request.idempotency_key)
        || request
            .run_id
            .as_deref()
            .is_some_and(|value| !valid_id(value))
        || !OPERATIONS.contains(&request.operation.as_str())
    {
        return Err("invalid client request".to_string());
    }
    Ok(request)
}

pub fn parse_server_message(text: &str) -> Result<ServerMessage, String> {
    let value = parse_canonical_value(text)?;
    let message_type = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "client message has no type".to_string())?;
    let message = match message_type {
        "hello" => {
            ServerMessage::Hello(serde_json::from_value(value).map_err(|error| error.to_string())?)
        }
        "response" => ServerMessage::Response(
            serde_json::from_value(value).map_err(|error| error.to_string())?,
        ),
        "event" => {
            ServerMessage::Event(serde_json::from_value(value).map_err(|error| error.to_string())?)
        }
        _ => return Err("invalid client message type".to_string()),
    };
    match &message {
        ServerMessage::Hello(value)
            if value.schema != PROTOCOL_ID
                || value.message_type != "hello"
                || !valid_id(&value.connection_id)
                || value.package_version.is_empty() =>
        {
            Err("invalid client hello".to_string())
        }
        ServerMessage::Response(value)
            if value.schema != PROTOCOL_ID
                || value.message_type != "response"
                || !valid_id(&value.request_id)
                || !OUTCOMES.contains(&value.outcome.as_str())
                || value.error.as_deref().is_some_and(str::is_empty) =>
        {
            Err("invalid client response".to_string())
        }
        ServerMessage::Event(value)
            if value.schema != PROTOCOL_ID
                || value.message_type != "event"
                || !valid_id(&value.subscription_id)
                || value
                    .run_id
                    .as_deref()
                    .is_some_and(|value| !valid_id(value))
                || !EVENTS.contains(&value.event.as_str()) =>
        {
            Err("invalid client event".to_string())
        }
        _ => Ok(message),
    }
}

fn parse_canonical_value(text: &str) -> Result<Value, String> {
    if text.len() > 1024 * 1024 {
        return Err("client message exceeds 1 MiB".to_string());
    }
    let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    if canonical_json(&value)? != text {
        return Err("client message is not canonical JSON".to_string());
    }
    Ok(value)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}

pub fn encode_request(request: &ClientRequest) -> Result<String, String> {
    let value = serde_json::to_value(request).map_err(|error| error.to_string())?;
    canonical_json(&value)
}

pub fn canonical_json(value: &Value) -> Result<String, String> {
    serde_json::to_string(&sorted_value(value)).map_err(|error| error.to_string())
}

fn sorted_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), sorted_value(&object[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(array) => Value::Array(array.iter().map(sorted_value).collect()),
        _ => value.clone(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageKind {
    Steps,
    Trace,
    TraceAtStep,
    SessionEntries,
    SessionEvents,
    Settings,
    FollowUps,
    Updates,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetPatch {
    #[serde(rename = "targetType")]
    pub target_type: String,
    #[serde(rename = "targetKey")]
    pub target_key: String,
    pub patch: Vec<PatchOp>,
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
