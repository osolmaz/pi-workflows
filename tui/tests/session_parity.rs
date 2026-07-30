use piw::bundle::types::{SessionEntryRecord, SessionEventRecord};
use piw::format::parse_timestamp_ms;
use piw::session::{reduce_session_events, SessionReplayIndex};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Deserialize)]
struct FixturePosition {
    #[serde(rename = "throughSeq")]
    through_seq: u64,
    expected: Value,
}

#[derive(Deserialize)]
struct Fixture {
    schema: String,
    entries: Vec<SessionEntryRecord>,
    events: Vec<SessionEventRecord>,
    positions: Vec<FixturePosition>,
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/session-events")
}

#[test]
fn temporal_reducer_matches_typescript_fixtures() {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no session event fixtures found");

    for path in paths {
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        assert_eq!(fixture.schema, "pi-workflows.session-event-fixture.v1");
        let index = SessionReplayIndex::new(&fixture.entries, &fixture.events, 2);
        for position in fixture.positions {
            let actual =
                reduce_session_events(&fixture.entries, &fixture.events, position.through_seq);
            assert_eq!(
                serde_json::to_value(&actual).unwrap(),
                position.expected,
                "{} at seq {}",
                path.display(),
                position.through_seq
            );
            assert_eq!(index.state_at_seq(position.through_seq), actual);
        }
        if let Some(event) = fixture.events.get(4) {
            let at = parse_timestamp_ms(&event.at).unwrap();
            assert_eq!(index.seq_at_or_before(at), event.seq);
        }
    }
}
