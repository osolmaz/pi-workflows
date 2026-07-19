/**
 * Structural verifier for the boxed graph renderer. Instead of asserting on
 * screenshots, it re-reads the rendered characters: every node must sit in an
 * unbroken box, and every declared workflow edge must be traceable through
 * the actual box-drawing characters from the source box to an arrow adjacent
 * to the target box. A rendering bug (broken line, misplaced arrow, label
 * overwriting an edge) makes tracing fail.
 */

import { CHAR_TO_MASK, DOWN, LEFT, RIGHT, UP } from "../../src/render/canvas.js";
import { expandEdges } from "../../src/render/graph.js";
import type { WorkflowDefinitionSnapshot } from "../../src/workflows/types.js";

type Rect = {
  nodeId: string;
  left: number;
  right: number;
  top: number;
  mid: number;
  bottom: number;
};

const LIGHT = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
const HEAVY = { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" };
const VERTICAL_BORDERS = new Set([LIGHT.v, HEAVY.v]);

export type GraphVerifyResult = {
  /** Human-readable problems; empty means the render passed. */
  problems: string[];
};

export function verifyBoxedGraphRender(
  snapshot: WorkflowDefinitionSnapshot,
  strippedLines: string[],
): GraphVerifyResult {
  const problems: string[] = [];
  const edges = expandEdges(snapshot);
  const labels = [
    ...new Set(edges.map((edge) => edge.label).filter((label) => label !== undefined)),
  ];
  const grid = strippedLines.map((line) => [...line]);
  const rects = new Map<string, Rect>();

  for (const nodeId of Object.keys(snapshot.nodes)) {
    const rect = findNodeRect(grid, nodeId, problems);
    if (rect) {
      rects.set(nodeId, rect);
      checkBoxIntegrity(grid, rect, problems);
    }
  }

  const traceGrid = healLabels(strippedLines, labels).map((line) => [...line]);
  for (const [nodeId, rect] of rects) {
    const expected = edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
    if (expected.length === 0) {
      continue;
    }
    const reached = traceFromNode(traceGrid, rect, rects);
    for (const target of expected) {
      if (!reached.has(target)) {
        problems.push(
          `edge ${nodeId} -> ${target}: no traceable path (reached: ${[...reached].join(", ") || "none"})`,
        );
      }
    }
  }

  return { problems };
}

/** Locate a node's box from its unique "nodeId [" label occurrence. */
function findNodeRect(grid: string[][], nodeId: string, problems: string[]): Rect | null {
  const needle = ` ${nodeId} [`;
  const hits: { row: number; col: number }[] = [];
  for (const [row, chars] of grid.entries()) {
    const line = chars.join("");
    let from = 0;
    for (;;) {
      const col = line.indexOf(needle, from);
      if (col === -1) {
        break;
      }
      hits.push({ row, col });
      from = col + 1;
    }
  }
  if (hits.length !== 1) {
    problems.push(`node ${nodeId}: expected exactly 1 label occurrence, found ${hits.length}`);
    return null;
  }
  const { row, col } = hits[0] as { row: number; col: number };
  const chars = grid[row] as string[];
  let left = col;
  while (left >= 0 && !VERTICAL_BORDERS.has(chars[left] as string)) {
    left -= 1;
  }
  let right = col + needle.length;
  while (right < chars.length && !VERTICAL_BORDERS.has(chars[right] as string)) {
    right += 1;
  }
  if (left < 0 || right >= chars.length + 1 || !VERTICAL_BORDERS.has(chars[right] ?? "")) {
    problems.push(`node ${nodeId}: label row has no enclosing box borders`);
    return null;
  }
  return { nodeId, left, right, top: row - 1, mid: row, bottom: row + 1 };
}

function checkBoxIntegrity(grid: string[][], rect: Rect, problems: string[]): void {
  const charAt = (x: number, y: number) => grid[y]?.[x] ?? " ";
  const style = charAt(rect.left, rect.mid) === HEAVY.v ? HEAVY : LIGHT;
  const rows: [number, string, string, string][] = [
    [rect.top, style.tl, style.h, style.tr],
    [rect.bottom, style.bl, style.h, style.br],
  ];
  for (const [y, first, middle, last] of rows) {
    if (charAt(rect.left, y) !== first || charAt(rect.right, y) !== last) {
      problems.push(`node ${rect.nodeId}: box corners broken on row ${y}`);
    }
    for (let x = rect.left + 1; x < rect.right; x += 1) {
      if (charAt(x, y) !== middle) {
        problems.push(`node ${rect.nodeId}: box border broken at (${x}, ${y})`);
        break;
      }
    }
  }
}

/**
 * Switch-case labels are drawn over long horizontal runs (`── y ──`).
 * Restore the line underneath so tracing sees a continuous edge. Only runs
 * flanked by `─` on both sides are healed, so a genuinely broken line
 * cannot be papered over.
 */
function healLabels(lines: string[], labels: string[]): string[] {
  return lines.map((line) => {
    let healed = line;
    for (const label of labels) {
      const escaped = label.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
      healed = healed.replace(
        new RegExp(`(?<=─) ${escaped} (?=─)`, "g"),
        "─".repeat(label.length + 2),
      );
    }
    return healed;
  });
}

type Direction = "up" | "down" | "left" | "right";

const MOVES: Record<Direction, { dx: number; dy: number; enterMask: number; exitMask: number }> = {
  up: { dx: 0, dy: -1, enterMask: DOWN, exitMask: UP },
  down: { dx: 0, dy: 1, enterMask: UP, exitMask: DOWN },
  left: { dx: -1, dy: 0, enterMask: RIGHT, exitMask: LEFT },
  right: { dx: 1, dy: 0, enterMask: LEFT, exitMask: RIGHT },
};

const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

/**
 * Directional BFS along box-drawing characters, starting from every port
 * below the node's box (both forward edges and loop edges exit downward).
 * Returns the node ids whose entry arrows are reachable.
 */
function traceFromNode(grid: string[][], rect: Rect, rects: Map<string, Rect>): Set<string> {
  const reached = new Set<string>();
  const queue: { x: number; y: number; dir: Direction }[] = [];
  for (let x = rect.left; x <= rect.right; x += 1) {
    queue.push({ x, y: rect.bottom + 1, dir: "down" });
  }

  const seen = new Set<string>();
  while (queue.length > 0) {
    const { x, y, dir } = queue.shift() as { x: number; y: number; dir: Direction };
    const key = `${x},${y},${dir}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const char = grid[y]?.[x] ?? " ";
    if (char === "▼" && dir === "down") {
      const target = nodeWithTopBorderAt(rects, x, y + 1);
      if (target) {
        reached.add(target);
      }
      continue;
    }
    const mask = CHAR_TO_MASK[char];
    if (mask === undefined || (mask & MOVES[dir].enterMask) === 0) {
      continue;
    }
    // ┼ is a crossing of two independent edges, never a junction: only
    // straight movement is allowed through it.
    const exits: Direction[] =
      mask === (UP | DOWN | LEFT | RIGHT)
        ? [dir]
        : (Object.keys(MOVES) as Direction[]).filter(
            (exit) => exit !== OPPOSITE[dir] && (mask & MOVES[exit].exitMask) !== 0,
          );
    for (const exit of exits) {
      queue.push({ x: x + MOVES[exit].dx, y: y + MOVES[exit].dy, dir: exit });
    }
  }
  return reached;
}

function nodeWithTopBorderAt(rects: Map<string, Rect>, x: number, y: number): string | null {
  for (const rect of rects.values()) {
    if (rect.top === y && x >= rect.left && x <= rect.right) {
      return rect.nodeId;
    }
  }
  return null;
}
