use piw::render::{render_graph_lines, GraphNodeStyle, GraphView};
use piw::state::types::{DefinitionSnapshot, RunState, WorkflowDisplay};
use serde::Deserialize;
use std::path::PathBuf;

const FIXTURE_NOW_MS: i64 = 1_767_225_660_000;

#[derive(Deserialize)]
struct LayoutFixture {
    name: String,
    snapshot: DefinitionSnapshot,
    state: RunState,
    frames: Vec<Frame>,
}

#[derive(Deserialize)]
struct Frame {
    #[serde(rename = "stepIndex")]
    step_index: i64,
    #[serde(rename = "nodeStyle")]
    node_style: String,
    lines: Vec<String>,
}

#[test]
fn rust_renderer_matches_every_typescript_fixture() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root")
        .join("fixtures/layout");
    let mut paths = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    assert!(!paths.is_empty());

    for path in paths {
        let fixture: LayoutFixture =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let display = WorkflowDisplay {
            status: fixture.state.status,
            activity: None,
            controls: Vec::new(),
            reason: None,
            reason_content: None,
        };
        let view = GraphView {
            state: &fixture.state,
            display: &display,
            snapshot: Some(&fixture.snapshot),
            graph_steps: None,
            taken_transitions: None,
        };
        for frame in fixture.frames {
            let style = match frame.node_style.as_str() {
                "line" => GraphNodeStyle::Line,
                "box" => GraphNodeStyle::Box,
                other => panic!("unsupported node style {other}"),
            };
            let actual = render_graph_lines(&view, frame.step_index, FIXTURE_NOW_MS, style);
            assert_eq!(
                actual.len(),
                frame.lines.len(),
                "fixture {} row count at step {} ({})",
                fixture.name,
                frame.step_index,
                frame.node_style,
            );
            for (row, (actual, expected)) in actual.iter().zip(&frame.lines).enumerate() {
                assert_eq!(
                    actual, expected,
                    "fixture {} row {} at step {} ({})",
                    fixture.name, row, frame.step_index, frame.node_style,
                );
            }
        }
    }
}
