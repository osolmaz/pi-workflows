//! Faithful port of `src/render/graph.ts`: expand switch edges, classify
//! back edges via DFS, longest-path layering with terminal tail pull-down,
//! virtual pass-through cells, and barycenter ordering. Behavior is pinned
//! against the golden fixtures in `fixtures/layout/` — any divergence is a
//! bug in this port, not a stylistic choice.

use crate::bundle::types::{DefinitionSnapshot, EdgeDef};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphEdge {
    #[serde(rename = "edgeId")]
    pub edge_id: String,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "isBackEdge")]
    pub is_back_edge: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GraphCell {
    Node {
        #[serde(rename = "nodeId")]
        node_id: String,
    },
    Virtual {
        #[serde(rename = "edgeId")]
        edge_id: String,
    },
}

impl GraphCell {
    pub fn is_node(&self) -> bool {
        matches!(self, GraphCell::Node { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSegment {
    #[serde(rename = "edgeId")]
    pub edge_id: String,
    pub rank: usize,
    #[serde(rename = "fromCell")]
    pub from_cell: usize,
    #[serde(rename = "toCell")]
    pub to_cell: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphLayout {
    pub ranks: Vec<Vec<GraphCell>>,
    pub edges: Vec<GraphEdge>,
    pub segments: Vec<GraphSegment>,
    pub rank_of_node: HashMap<String, usize>,
}

pub fn expand_edges(snapshot: &DefinitionSnapshot) -> Vec<GraphEdge> {
    let mut edges = Vec::new();
    for (index, edge) in snapshot.edges.iter().enumerate() {
        match edge {
            EdgeDef::Simple { from, to } => edges.push(GraphEdge {
                edge_id: format!("{from}->{to}#{index}.0"),
                from: from.clone(),
                to: to.clone(),
                label: None,
                is_back_edge: false,
            }),
            EdgeDef::Switch { from, switch } => {
                for (branch, (case_key, target)) in switch.cases.iter().enumerate() {
                    let target = target.as_str().unwrap_or_default().to_string();
                    edges.push(GraphEdge {
                        edge_id: format!("{from}->{target}#{index}.{branch}"),
                        from: from.clone(),
                        to: target,
                        // Case keys are author-controlled text from the bundle;
                        // scrub them so drawing a label can't emit escapes.
                        label: Some(crate::format::sanitize_text(case_key)),
                        is_back_edge: false,
                    });
                }
            }
        }
    }
    edges
}

fn bfs_order(snapshot: &DefinitionSnapshot, edges: &[GraphEdge]) -> Vec<String> {
    let mut queue = std::collections::VecDeque::from([snapshot.start_at.clone()]);
    let mut visited = HashSet::new();
    let mut ordered = Vec::new();
    while let Some(node_id) = queue.pop_front() {
        if !visited.insert(node_id.clone()) {
            continue;
        }
        ordered.push(node_id.clone());
        for edge in edges {
            if edge.from == node_id {
                queue.push_back(edge.to.clone());
            }
        }
    }
    for node_id in snapshot.node_ids() {
        if visited.insert(node_id.to_string()) {
            ordered.push(node_id.to_string());
        }
    }
    ordered
}

/// DFS cycle detection: an edge is a back edge only when it closes a real
/// cycle (its target is an ancestor on the DFS stack).
fn mark_back_edges(edges: &mut [GraphEdge], ordered_node_ids: &[String]) {
    #[derive(Clone, Copy, PartialEq)]
    enum Color {
        Gray,
        Black,
    }
    fn visit(node_id: &str, edges: &mut [GraphEdge], color: &mut HashMap<String, Color>) {
        color.insert(node_id.to_string(), Color::Gray);
        for index in 0..edges.len() {
            if edges[index].from != node_id {
                continue;
            }
            let target = edges[index].to.clone();
            match color.get(&target) {
                Some(Color::Gray) => edges[index].is_back_edge = true,
                None => visit(&target, edges, color),
                Some(Color::Black) => {}
            }
        }
        color.insert(node_id.to_string(), Color::Black);
    }
    let mut color = HashMap::new();
    for node_id in ordered_node_ids {
        if !color.contains_key(node_id) {
            visit(node_id, edges, &mut color);
        }
    }
}

fn compute_longest_levels(
    start_at: &str,
    ordered_node_ids: &[String],
    forward_edges: &[&GraphEdge],
) -> HashMap<String, i64> {
    let mut levels = HashMap::from([(start_at.to_string(), 0_i64)]);
    for _pass in 0..=ordered_node_ids.len() {
        let mut changed = false;
        for edge in forward_edges {
            let Some(&from_level) = levels.get(&edge.from) else {
                continue;
            };
            let proposed = from_level + 1;
            if proposed > levels.get(&edge.to).copied().unwrap_or(-1) {
                levels.insert(edge.to.clone(), proposed);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    levels
}

/// Nodes on a straight single-path tail into a terminal node sink to the
/// bottom ranks.
fn compute_tail_depths(
    ordered_node_ids: &[String],
    forward_edges: &[&GraphEdge],
    terminal_node_ids: &HashSet<String>,
) -> HashMap<String, i64> {
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in forward_edges {
        outgoing.entry(&edge.from).or_default().push(&edge.to);
    }
    fn visit(
        node_id: &str,
        outgoing: &HashMap<&str, Vec<&str>>,
        terminal: &HashSet<String>,
        memo: &mut HashMap<String, Option<i64>>,
    ) -> Option<i64> {
        if let Some(existing) = memo.get(node_id) {
            return *existing;
        }
        if terminal.contains(node_id) {
            memo.insert(node_id.to_string(), Some(0));
            return Some(0);
        }
        let targets = outgoing.get(node_id).map(Vec::as_slice).unwrap_or(&[]);
        if targets.len() != 1 {
            memo.insert(node_id.to_string(), None);
            return None;
        }
        // Break potential cycles before recursing.
        memo.insert(node_id.to_string(), None);
        let child = targets[0].to_string();
        let depth = visit(&child, outgoing, terminal, memo).map(|value| value + 1);
        memo.insert(node_id.to_string(), depth);
        depth
    }
    let mut memo = HashMap::new();
    for node_id in ordered_node_ids {
        visit(node_id, &outgoing, terminal_node_ids, &mut memo);
    }
    memo.into_iter()
        .filter_map(|(node_id, depth)| depth.map(|value| (node_id, value)))
        .collect()
}

fn compute_node_ranks(
    snapshot: &DefinitionSnapshot,
    ordered_node_ids: &[String],
    edges: &[GraphEdge],
) -> HashMap<String, usize> {
    let forward_edges: Vec<&GraphEdge> = edges.iter().filter(|edge| !edge.is_back_edge).collect();
    let longest = compute_longest_levels(&snapshot.start_at, ordered_node_ids, &forward_edges);
    let mut outgoing_counts: HashMap<&str, usize> = HashMap::new();
    for edge in &forward_edges {
        *outgoing_counts.entry(&edge.from).or_default() += 1;
    }
    let terminal_node_ids: HashSet<String> = ordered_node_ids
        .iter()
        .filter(|node_id| outgoing_counts.get(node_id.as_str()).copied().unwrap_or(0) == 0)
        .cloned()
        .collect();
    let tail_depths = compute_tail_depths(ordered_node_ids, &forward_edges, &terminal_node_ids);

    let mut rank_of_node: HashMap<String, i64> = HashMap::new();
    let mut fallback = longest.values().copied().max().unwrap_or(0).max(0);
    for node_id in ordered_node_ids {
        match longest.get(node_id) {
            Some(&base) => {
                rank_of_node.insert(node_id.clone(), base);
            }
            None => {
                fallback += 1;
                rank_of_node.insert(node_id.clone(), fallback);
            }
        }
    }
    let max_rank = rank_of_node.values().copied().max().unwrap_or(0).max(0);
    for node_id in ordered_node_ids {
        if let Some(&tail_depth) = tail_depths.get(node_id) {
            let current = rank_of_node.get(node_id).copied().unwrap_or(0);
            rank_of_node.insert(node_id.clone(), current.max(max_rank - tail_depth));
        }
    }
    rank_of_node
        .into_iter()
        .map(|(node_id, rank)| (node_id, rank.max(0) as usize))
        .collect()
}

#[derive(Clone, Copy)]
struct CellRef {
    rank: usize,
    index: usize,
}

/// Build ranks with virtual pass-through cells so every forward edge connects
/// adjacent ranks, then order cells within ranks by neighbor barycenter.
pub fn layout_graph(snapshot: &DefinitionSnapshot) -> GraphLayout {
    let mut edges = expand_edges(snapshot);
    let ordered_node_ids = bfs_order(snapshot, &edges);
    mark_back_edges(&mut edges, &ordered_node_ids);
    let rank_of_node = compute_node_ranks(snapshot, &ordered_node_ids, &edges);

    let rank_count = rank_of_node.values().copied().max().unwrap_or(0) + 1;
    let mut ranks: Vec<Vec<GraphCell>> = vec![Vec::new(); rank_count];
    let mut cell_ref: HashMap<String, CellRef> = HashMap::new();
    for node_id in &ordered_node_ids {
        let rank = rank_of_node.get(node_id).copied().unwrap_or(0);
        cell_ref.insert(
            node_id.clone(),
            CellRef {
                rank,
                index: ranks[rank].len(),
            },
        );
        ranks[rank].push(GraphCell::Node {
            node_id: node_id.clone(),
        });
    }

    // Chain each long forward edge through virtual cells in intermediate ranks.
    let mut segments: Vec<GraphSegment> = Vec::new();
    for edge in &edges {
        if edge.is_back_edge {
            continue;
        }
        let (Some(&from_rank), Some(&to_rank)) =
            (rank_of_node.get(&edge.from), rank_of_node.get(&edge.to))
        else {
            continue;
        };
        if to_rank <= from_rank {
            continue;
        }
        let mut previous = cell_ref[&edge.from];
        // Index loop kept deliberately: `rank` also feeds the CellRef chain.
        #[allow(clippy::needless_range_loop)]
        for rank in (from_rank + 1)..to_rank {
            let index = ranks[rank].len();
            ranks[rank].push(GraphCell::Virtual {
                edge_id: edge.edge_id.clone(),
            });
            segments.push(GraphSegment {
                edge_id: edge.edge_id.clone(),
                rank: previous.rank,
                from_cell: previous.index,
                to_cell: index,
                label: if previous.rank == from_rank {
                    edge.label.clone()
                } else {
                    None
                },
            });
            previous = CellRef { rank, index };
        }
        let target = cell_ref[&edge.to];
        segments.push(GraphSegment {
            edge_id: edge.edge_id.clone(),
            rank: previous.rank,
            from_cell: previous.index,
            to_cell: target.index,
            label: if previous.rank == from_rank {
                edge.label.clone()
            } else {
                None
            },
        });
    }

    order_ranks_by_barycenter(&mut ranks, &mut segments);
    GraphLayout {
        ranks,
        edges,
        segments,
        rank_of_node,
    }
}

/// JS `Number.MAX_SAFE_INTEGER`, used as the "no neighbors" score.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    Down,
    Up,
}

/// Sweep up and down, sorting each rank by the mean position of neighbors.
fn order_ranks_by_barycenter(ranks: &mut [Vec<GraphCell>], segments: &mut [GraphSegment]) {
    fn reindex(
        ranks: &mut [Vec<GraphCell>],
        segments: &mut [GraphSegment],
        rank: usize,
        order: &[usize],
    ) {
        let cells = std::mem::take(&mut ranks[rank]);
        let mut inverse = vec![0usize; order.len()];
        for (new_index, &old_index) in order.iter().enumerate() {
            inverse[old_index] = new_index;
        }
        ranks[rank] = order.iter().map(|&old| cells[old].clone()).collect();
        for segment in segments.iter_mut() {
            if segment.rank == rank {
                segment.from_cell = inverse[segment.from_cell];
            }
            if rank > 0 && segment.rank == rank - 1 {
                segment.to_cell = inverse[segment.to_cell];
            }
        }
    }

    fn sort_rank(
        ranks: &mut [Vec<GraphCell>],
        segments: &mut [GraphSegment],
        rank: usize,
        direction: Direction,
    ) {
        let len = ranks[rank].len();
        if len < 2 {
            return;
        }
        let mut scores: Vec<(usize, f64)> = Vec::with_capacity(len);
        for index in 0..len {
            let neighbors: Vec<usize> = segments
                .iter()
                .filter(|segment| match direction {
                    Direction::Down => {
                        rank > 0 && segment.rank == rank - 1 && segment.to_cell == index
                    }
                    Direction::Up => segment.rank == rank && segment.from_cell == index,
                })
                .map(|segment| match direction {
                    Direction::Down => segment.from_cell,
                    Direction::Up => segment.to_cell,
                })
                .collect();
            let score = if neighbors.is_empty() {
                MAX_SAFE_INTEGER
            } else {
                neighbors.iter().sum::<usize>() as f64 / neighbors.len() as f64
            };
            scores.push((index, score));
        }
        let mut order: Vec<(usize, f64)> = scores.clone();
        order.sort_by(|left, right| {
            left.1
                .partial_cmp(&right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.0.cmp(&right.0))
        });
        let order: Vec<usize> = order.into_iter().map(|(index, _)| index).collect();
        if order.iter().enumerate().any(|(new, &old)| new != old) {
            reindex(ranks, segments, rank, &order);
        }
    }

    for _pass in 0..4 {
        for rank in 1..ranks.len() {
            sort_rank(ranks, segments, rank, Direction::Down);
        }
        for rank in (0..ranks.len().saturating_sub(1)).rev() {
            sort_rank(ranks, segments, rank, Direction::Up);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_case_labels_are_scrubbed_of_escapes() {
        let snapshot: DefinitionSnapshot = serde_json::from_value(serde_json::json!({
            "schema": "pi-workflows.workflow.v1",
            "name": "test",
            "startAt": "a",
            "nodes": { "a": { "nodeType": "agent" }, "b": { "nodeType": "agent" } },
            "edges": [
                { "from": "a", "switch": { "on": "x", "cases": { "\u{1b}]52;c;evil\u{7}ok": "b" } } },
            ],
        }))
        .unwrap();
        let edges = expand_edges(&snapshot);
        assert_eq!(edges[0].label.as_deref(), Some("]52;c;evilok"));
    }
}
