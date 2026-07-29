//! Golden-fixture parity with the TypeScript reference implementation. Every
//! fixture in ../fixtures/layout/ pins the layout structures and the
//! ANSI-stripped render output; the Rust port must reproduce both exactly.
//! Regenerate fixtures with `npm run fixtures` and update both sides together.

use piw::bundle::types::{DefinitionSnapshot, RunState};
use piw::render::{render_graph_lines, GraphNodeStyle, GraphView};
use piw::{format, layout};
use serde_json::Value;
use std::path::PathBuf;

/// The frozen clock the fixtures were rendered with.
const NOW: &str = "2026-01-01T00:01:00.000Z";

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("layout")
}

fn load_fixtures() -> Vec<(String, Value)> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures/layout must exist; run `npm run fixtures`")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    entries.sort();
    assert!(!entries.is_empty(), "no fixtures found");
    entries
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let raw = std::fs::read_to_string(&path).unwrap();
            (name, serde_json::from_str(&raw).unwrap())
        })
        .collect()
}

#[test]
fn layout_matches_typescript_reference() {
    for (name, fixture) in load_fixtures() {
        let snapshot: DefinitionSnapshot =
            serde_json::from_value(fixture["snapshot"].clone()).unwrap();
        let layout = layout::layout_graph(&snapshot);
        let actual = serde_json::json!({
            "ranks": layout.ranks,
            "edges": layout.edges,
            "segments": layout.segments,
            "rankOfNode": layout.rank_of_node,
        });
        assert_eq!(
            actual, fixture["layout"],
            "layout mismatch for fixture {name}"
        );
    }
}

#[test]
fn render_matches_typescript_reference() {
    let now_ms = format::parse_timestamp_ms(NOW).unwrap();
    for (name, fixture) in load_fixtures() {
        let snapshot: DefinitionSnapshot =
            serde_json::from_value(fixture["snapshot"].clone()).unwrap();
        let state: RunState = serde_json::from_value(fixture["state"].clone()).unwrap();
        let view = GraphView {
            state: &state,
            snapshot: Some(&snapshot),
        };
        for frame in fixture["frames"].as_array().unwrap() {
            let step_index = frame["stepIndex"].as_i64().unwrap();
            let node_style = match frame["nodeStyle"].as_str().unwrap() {
                "box" => GraphNodeStyle::Box,
                _ => GraphNodeStyle::Line,
            };
            let expected: Vec<String> = frame["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| line.as_str().unwrap().to_string())
                .collect();
            let actual = render_graph_lines(&view, step_index, now_ms, node_style);
            assert_eq!(
                actual, expected,
                "render mismatch for fixture {name} at stepIndex {step_index} ({:?})",
                frame["nodeStyle"]
            );
        }
    }
}
