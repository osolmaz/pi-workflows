import type { WorkflowNodeSnapshot } from "../workflows/types.js";

const NODE_TYPE_GLYPHS: Readonly<Record<WorkflowNodeSnapshot["nodeType"], string>> = {
  agent: "●",
  compute: "ƒ",
  notify: "!",
  action: "*",
  checkpoint: "◆",
};

/** A stable one-column glyph for a workflow node or action subtype. */
export function nodeTypeGlyph(
  nodeType: WorkflowNodeSnapshot["nodeType"],
  actionExecution?: WorkflowNodeSnapshot["actionExecution"],
): string {
  if (nodeType === "action" && actionExecution === "shell") {
    return "$";
  }
  return NODE_TYPE_GLYPHS[nodeType];
}

/** The graph viewer badge keeps the readable type name beside its glyph. */
export function nodeTypeBadge(
  nodeType: WorkflowNodeSnapshot["nodeType"],
  actionExecution?: WorkflowNodeSnapshot["actionExecution"],
): string {
  return `${nodeTypeGlyph(nodeType, actionExecution)} ${nodeType}`;
}
