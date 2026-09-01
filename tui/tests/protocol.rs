use piw::protocol::{parse_client_request, parse_server_message};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Deserialize)]
struct ProtocolFixture {
    valid: Vec<String>,
    invalid: Vec<String>,
}

#[test]
fn rust_accepts_and_rejects_the_shared_client_protocol_fixtures() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root")
        .join("protocol/fixtures/client-v1.json");
    let fixture: ProtocolFixture =
        serde_json::from_slice(&std::fs::read(path).expect("protocol fixture"))
            .expect("valid protocol fixture");

    for line in fixture.valid {
        let value: Value = serde_json::from_str(&line).expect("fixture JSON");
        let result = if value.get("type").and_then(Value::as_str) == Some("request") {
            parse_client_request(&line).map(|_| ())
        } else {
            parse_server_message(&line).map(|_| ())
        };
        assert!(result.is_ok(), "valid fixture was rejected: {line}");
    }

    for line in fixture.invalid {
        let value: Value = serde_json::from_str(&line).expect("fixture JSON");
        let result = if value.get("type").and_then(Value::as_str) == Some("request") {
            parse_client_request(&line).map(|_| ())
        } else {
            parse_server_message(&line).map(|_| ())
        };
        assert!(result.is_err(), "invalid fixture was accepted: {line}");
    }
}
