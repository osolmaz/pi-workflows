import type { WorkflowDefinitionSnapshot } from "../workflows/types.js";

/**
 * Graph layout for the terminal viewer, ported from the acpx replay viewer's
 * view-model (expand switch edges, classify back edges via shortest levels,
 * longest-path layering with terminal tail pull-down, barycenter ordering).
 * The one addition is virtual pass-through cells so every forward edge spans
 * exactly one rank, which keeps text routing local to each rank gap.
 */

export type GraphEdge = {
  edgeId: string;
  from: string;
  to: string;
  /** Switch case key for labelled branches. */
  label?: string;
  isBackEdge: boolean;
};

export type GraphCell = { kind: "node"; nodeId: string } | { kind: "virtual"; edgeId: string };

export type GraphSegment = {
  edgeId: string;
  /** Rank index the segment starts at; it ends at `rank + 1`. */
  rank: number;
  fromCell: number;
  toCell: number;
  /** Label to draw on this segment (only on the first segment of an edge). */
  label?: string;
};

export type GraphLayout = {
  ranks: GraphCell[][];
  edges: GraphEdge[];
  /** Forward-edge segments between adjacent ranks. */
  segments: GraphSegment[];
  /** Rank index of every real node. */
  rankOfNode: Map<string, number>;
};

export function expandEdges(snapshot: WorkflowDefinitionSnapshot): GraphEdge[] {
  return snapshot.edges.flatMap((edge, index) => {
    if ("to" in edge) {
      return [
        {
          edgeId: `${edge.from}->${edge.to}#${index}.0`,
          from: edge.from,
          to: edge.to,
          isBackEdge: false,
        },
      ];
    }
    return Object.entries(edge.switch.cases).map(([caseKey, target], branch) => ({
      edgeId: `${edge.from}->${target}#${index}.${branch}`,
      from: edge.from,
      to: target,
      label: caseKey,
      isBackEdge: false,
    }));
  });
}

function bfsOrder(snapshot: WorkflowDefinitionSnapshot, edges: GraphEdge[]): string[] {
  const queue = [snapshot.startAt];
  const visited = new Set<string>();
  const ordered: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    ordered.push(nodeId);
    for (const edge of edges) {
      if (edge.from === nodeId) {
        queue.push(edge.to);
      }
    }
  }
  for (const nodeId of Object.keys(snapshot.nodes)) {
    if (!visited.has(nodeId)) {
      visited.add(nodeId);
      ordered.push(nodeId);
    }
  }
  return ordered;
}

/**
 * DFS cycle detection: an edge is a back edge only when it closes a real
 * cycle (its target is an ancestor on the DFS stack). This improves on the
 * acpx viewer's shortest-level heuristic, which misclassifies the rejoining
 * edge of an uneven diamond as a loop.
 */
function markBackEdges(edges: GraphEdge[], orderedNodeIds: string[]): void {
  const color = new Map<string, "gray" | "black">();
  const visit = (nodeId: string): void => {
    color.set(nodeId, "gray");
    for (const edge of edges) {
      if (edge.from !== nodeId) {
        continue;
      }
      const targetColor = color.get(edge.to);
      if (targetColor === "gray") {
        edge.isBackEdge = true;
      } else if (targetColor === undefined) {
        visit(edge.to);
      }
    }
    color.set(nodeId, "black");
  };
  for (const nodeId of orderedNodeIds) {
    if (!color.has(nodeId)) {
      visit(nodeId);
    }
  }
}

function computeLongestLevels(
  startAt: string,
  orderedNodeIds: string[],
  forwardEdges: GraphEdge[],
): Map<string, number> {
  // orderedNodeIds is BFS order; iterate repeatedly until fixed point to get
  // longest-path levels without a separate topological sort (graphs are tiny).
  const levels = new Map<string, number>([[startAt, 0]]);
  for (let pass = 0; pass < orderedNodeIds.length + 1; pass += 1) {
    let changed = false;
    for (const edge of forwardEdges) {
      const fromLevel = levels.get(edge.from);
      if (fromLevel === undefined) {
        continue;
      }
      const proposed = fromLevel + 1;
      if (proposed > (levels.get(edge.to) ?? -1)) {
        levels.set(edge.to, proposed);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return levels;
}

/**
 * Nodes on a straight single-path tail into a terminal node sink to the
 * bottom ranks, matching the acpx viewer's tail pull-down.
 */
function computeTailDepths(
  orderedNodeIds: string[],
  forwardEdges: GraphEdge[],
  terminalNodeIds: Set<string>,
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const edge of forwardEdges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const memo = new Map<string, number | null>();
  const visit = (nodeId: string): number | null => {
    const existing = memo.get(nodeId);
    if (existing !== undefined) {
      return existing;
    }
    if (terminalNodeIds.has(nodeId)) {
      memo.set(nodeId, 0);
      return 0;
    }
    const targets = outgoing.get(nodeId) ?? [];
    if (targets.length !== 1) {
      memo.set(nodeId, null);
      return null;
    }
    // Break potential cycles before recursing.
    memo.set(nodeId, null);
    const childDepth = visit(targets[0] as string);
    const depth = childDepth === null ? null : childDepth + 1;
    memo.set(nodeId, depth);
    return depth;
  };
  for (const nodeId of orderedNodeIds) {
    visit(nodeId);
  }
  const depths = new Map<string, number>();
  for (const [nodeId, depth] of memo) {
    if (depth !== null) {
      depths.set(nodeId, depth);
    }
  }
  return depths;
}

function computeNodeRanks(
  snapshot: WorkflowDefinitionSnapshot,
  orderedNodeIds: string[],
  edges: GraphEdge[],
): Map<string, number> {
  const forwardEdges = edges.filter((edge) => !edge.isBackEdge);
  const longest = computeLongestLevels(snapshot.startAt, orderedNodeIds, forwardEdges);
  const outgoingCounts = new Map<string, number>();
  for (const edge of forwardEdges) {
    outgoingCounts.set(edge.from, (outgoingCounts.get(edge.from) ?? 0) + 1);
  }
  const terminalNodeIds = new Set(
    orderedNodeIds.filter((nodeId) => (outgoingCounts.get(nodeId) ?? 0) === 0),
  );
  const tailDepths = computeTailDepths(orderedNodeIds, forwardEdges, terminalNodeIds);

  const rankOfNode = new Map<string, number>();
  let fallback = Math.max(0, ...longest.values());
  for (const nodeId of orderedNodeIds) {
    const base = longest.get(nodeId);
    if (base === undefined) {
      fallback += 1;
      rankOfNode.set(nodeId, fallback);
    } else {
      rankOfNode.set(nodeId, base);
    }
  }
  const maxRank = Math.max(0, ...rankOfNode.values());
  for (const nodeId of orderedNodeIds) {
    const tailDepth = tailDepths.get(nodeId);
    if (tailDepth !== undefined) {
      rankOfNode.set(nodeId, Math.max(rankOfNode.get(nodeId) ?? 0, maxRank - tailDepth));
    }
  }
  return rankOfNode;
}

type CellRef = { rank: number; index: number };

/**
 * Build ranks with virtual pass-through cells so every forward edge connects
 * adjacent ranks, then order cells within ranks by neighbor barycenter.
 */
export function layoutGraph(snapshot: WorkflowDefinitionSnapshot): GraphLayout {
  const edges = expandEdges(snapshot);
  const orderedNodeIds = bfsOrder(snapshot, edges);
  markBackEdges(edges, orderedNodeIds);
  const rankOfNode = computeNodeRanks(snapshot, orderedNodeIds, edges);

  const rankCount = Math.max(0, ...rankOfNode.values()) + 1;
  const ranks: GraphCell[][] = Array.from({ length: rankCount }, () => []);
  const cellRef = new Map<string, CellRef>();
  for (const nodeId of orderedNodeIds) {
    const rank = rankOfNode.get(nodeId) ?? 0;
    cellRef.set(nodeId, { rank, index: (ranks[rank] as GraphCell[]).length });
    (ranks[rank] as GraphCell[]).push({ kind: "node", nodeId });
  }

  // Chain each long forward edge through virtual cells in intermediate ranks.
  const segments: GraphSegment[] = [];
  for (const edge of edges) {
    if (edge.isBackEdge) {
      continue;
    }
    const fromRank = rankOfNode.get(edge.from);
    const toRank = rankOfNode.get(edge.to);
    if (fromRank === undefined || toRank === undefined || toRank <= fromRank) {
      continue;
    }
    let previous = cellRef.get(edge.from) as CellRef;
    for (let rank = fromRank + 1; rank < toRank; rank += 1) {
      const index = (ranks[rank] as GraphCell[]).length;
      (ranks[rank] as GraphCell[]).push({ kind: "virtual", edgeId: edge.edgeId });
      segments.push({
        edgeId: edge.edgeId,
        rank: previous.rank,
        fromCell: previous.index,
        toCell: index,
        ...(previous.rank === fromRank && edge.label !== undefined ? { label: edge.label } : {}),
      });
      previous = { rank, index };
    }
    const target = cellRef.get(edge.to) as CellRef;
    segments.push({
      edgeId: edge.edgeId,
      rank: previous.rank,
      fromCell: previous.index,
      toCell: target.index,
      ...(previous.rank === fromRank && edge.label !== undefined ? { label: edge.label } : {}),
    });
  }

  orderRanksByBarycenter(ranks, segments);
  return { ranks, edges, segments, rankOfNode };
}

/** Sweep up and down, sorting each rank by the mean position of neighbors. */
function orderRanksByBarycenter(ranks: GraphCell[][], segments: GraphSegment[]): void {
  const reindex = (rank: number, order: number[]) => {
    const cells = ranks[rank] as GraphCell[];
    const inverse = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    ranks[rank] = order.map((oldIndex) => cells[oldIndex] as GraphCell);
    for (const segment of segments) {
      if (segment.rank === rank) {
        segment.fromCell = inverse.get(segment.fromCell) as number;
      }
      if (segment.rank === rank - 1) {
        segment.toCell = inverse.get(segment.toCell) as number;
      }
    }
  };

  const sortRank = (rank: number, direction: "down" | "up") => {
    const cells = ranks[rank] as GraphCell[];
    if (cells.length < 2) {
      return;
    }
    const scores = cells.map((_cell, index) => {
      const neighbors = segments
        .filter((segment) =>
          direction === "down"
            ? segment.rank === rank - 1 && segment.toCell === index
            : segment.rank === rank && segment.fromCell === index,
        )
        .map((segment) => (direction === "down" ? segment.fromCell : segment.toCell));
      const score =
        neighbors.length === 0
          ? Number.MAX_SAFE_INTEGER
          : neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length;
      return { index, score };
    });
    const order = scores
      .toSorted((left, right) => left.score - right.score || left.index - right.index)
      .map((entry) => entry.index);
    if (order.some((oldIndex, newIndex) => oldIndex !== newIndex)) {
      reindex(rank, order);
    }
  };

  for (let pass = 0; pass < 4; pass += 1) {
    for (let rank = 1; rank < ranks.length; rank += 1) {
      sortRank(rank, "down");
    }
    for (let rank = ranks.length - 2; rank >= 0; rank -= 1) {
      sortRank(rank, "up");
    }
  }
}
