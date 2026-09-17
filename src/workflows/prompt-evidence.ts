import { canonicalJson, digest } from "./human-decision.js";

/**
 * Bounded prompt evidence.
 *
 * A workflow agent prompt is one model request. The external interface that requires a limit here is
 * the model context window: the request must fit the window together with the session context and
 * the reserved answer. One prompt therefore has a ceiling, and every step result that reaches a
 * prompt is projected to fit it.
 *
 * Projection never replaces the durable record. The complete step result stays in run state. The
 * projection only builds the bounded copy that a prompt shows, and every value it removes leaves a
 * digest and a size behind.
 *
 * Two rules keep the walk finite and predictable. A registered view runs once for its schema, and the
 * generic rules bound whatever the view returns. A view never runs twice on the same subtree, so the
 * walk cannot recurse through its own replacement.
 */

/** Ceiling for one assembled agent prompt, in characters. Shared by every prompt builder. */
export const PROMPT_CEILING_CHARS = 96_000;

/** Schema identifier of a collapsed value. */
export const EVIDENCE_REF_SCHEMA = "pi-workflows.evidence-ref.v1";

/** Longest string kept verbatim. Longer strings become a ref with a head and tail excerpt. */
export const EVIDENCE_TEXT_CHARS = 4_000;

/** Longest array kept in full. Extra items become one ref that names the count. */
export const EVIDENCE_MAX_ITEMS = 20;

/** Deepest structured value kept in full. Deeper subtrees become one ref. */
export const EVIDENCE_MAX_DEPTH = 8;

const EXCERPT_MARKER_CHARS = 40;

/** Sentinel for a view that failed. A view error falls back to the generic rules. */
const VIEW_FAILED = Symbol("evidence-view-failed");

/** A bounded stand-in for a value that was collapsed out of a prompt. */
export type EvidenceRef = {
  schema: typeof EVIDENCE_REF_SCHEMA;
  /** Digest of the collapsed value, so a reader can locate the durable record. */
  digest: string;
  /** Character count of the collapsed value. */
  chars: number;
  /** Head and tail excerpt, set only when the collapsed value was a long string. */
  text?: string;
  /** Number of array items dropped, set only when the collapsed value was an array. */
  omitted?: number;
};

/** A pure function from a typed result to the bounded evidence a prompt needs. */
export type EvidenceView = (value: Record<string, unknown>) => unknown;

/** Registered views, keyed by the versioned schema identifier of the result. */
export type EvidenceViews = ReadonlyMap<string, EvidenceView>;

/** One projected step result, as a prompt lists it. */
export type EvidenceLedgerEntry = {
  attemptId: string;
  nodeId: string;
  outcome: string;
  error?: string;
  output: unknown;
};

/** Project a value into a bounded copy. Total: it never throws and never mutates its input. */
export function projectEvidence(value: unknown, views: EvidenceViews): unknown {
  return projectValue(value, views, 0);
}

/** Build the bounded stand-in for one value. */
export function evidenceRef(value: unknown): EvidenceRef {
  const ref: EvidenceRef = {
    schema: EVIDENCE_REF_SCHEMA,
    digest: refDigest(value),
    chars: refChars(value),
  };
  if (typeof value === "string" && value.length > EVIDENCE_TEXT_CHARS) {
    return { ...ref, text: excerpt(value) };
  }
  return ref;
}

/** Whether a value is already a bounded stand-in. */
export function isEvidenceRef(value: unknown): value is EvidenceRef {
  return isPlainObject(value) && value["schema"] === EVIDENCE_REF_SCHEMA;
}

/** Project every entry of a ledger. */
export function projectLedger(
  entries: readonly EvidenceLedgerEntry[],
  views: EvidenceViews,
): EvidenceLedgerEntry[] {
  return entries.map((entry) => ({ ...entry, output: projectEvidence(entry.output, views) }));
}

/** Serialized size of a ledger in characters. */
export function ledgerChars(entries: readonly EvidenceLedgerEntry[]): number {
  try {
    return JSON.stringify(entries).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Collapse the oldest entries until the ledger fits the budget.
 *
 * The newest entries stay whole, because they are the ones a decision depends on. When even a fully
 * collapsed ledger is over budget, every entry is collapsed and the caller reports the remaining
 * overflow.
 */
export function boundLedger(
  entries: EvidenceLedgerEntry[],
  budgetChars: number,
): EvidenceLedgerEntry[] {
  const bounded = entries.map((entry) => ({ ...entry }));
  const sizes = bounded.map((entry) => entryChars(entry));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  for (let index = 0; index < bounded.length && total > budgetChars; index += 1) {
    const entry = bounded[index];
    if (entry === undefined || isEvidenceRef(entry.output)) continue;
    const collapsed: EvidenceLedgerEntry = { ...entry, output: evidenceRef(entry.output) };
    const size = entryChars(collapsed);
    total = total - (sizes[index] ?? 0) + size;
    sizes[index] = size;
    bounded[index] = collapsed;
  }
  if (ledgerChars(bounded) <= budgetChars) return bounded;
  return bounded.map((entry) => ({ ...entry, output: evidenceRef(entry.output) }));
}

function projectValue(value: unknown, views: EvidenceViews, depth: number): unknown {
  const viewed = projectRegisteredView(value, views);
  if (viewed !== VIEW_FAILED) return projectUnregistered(viewed, views, depth + 1);
  return projectUnregistered(value, views, depth);
}

function projectRegisteredView(value: unknown, views: EvidenceViews): unknown {
  const view = knownView(value, views);
  if (view === undefined) return VIEW_FAILED;
  try {
    return view(value as Record<string, unknown>);
  } catch {
    return VIEW_FAILED;
  }
}

function projectUnregistered(value: unknown, views: EvidenceViews, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > EVIDENCE_TEXT_CHARS ? evidenceRef(value) : value;
  }
  if (depth >= EVIDENCE_MAX_DEPTH && isStructured(value)) return evidenceRef(value);
  if (Array.isArray(value)) return projectArray(value, views, depth);
  if (isPlainObject(value)) return projectObject(value, views, depth);
  return projectScalar(value);
}

function projectArray(value: readonly unknown[], views: EvidenceViews, depth: number): unknown[] {
  const kept = value
    .slice(0, EVIDENCE_MAX_ITEMS)
    .map((item) => projectValue(item, views, depth + 1));
  const dropped = value.slice(EVIDENCE_MAX_ITEMS);
  if (dropped.length === 0) return kept;
  return [...kept, { ...evidenceRef(dropped), omitted: dropped.length }];
}

function projectObject(
  value: Record<string, unknown>,
  views: EvidenceViews,
  depth: number,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    projected[key] = projectValue(entry, views, depth + 1);
  }
  return projected;
}

function projectScalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "number" || type === "boolean") return value;
  return evidenceRef(value);
}

function knownView(value: unknown, views: EvidenceViews): EvidenceView | undefined {
  if (!isPlainObject(value)) return undefined;
  const schema = value["schema"];
  if (typeof schema !== "string" || schema.length === 0) return undefined;
  return views.get(schema);
}

function isStructured(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function excerpt(value: string): string {
  const keep = Math.floor((EVIDENCE_TEXT_CHARS - EXCERPT_MARKER_CHARS) / 2);
  const head = value.slice(0, keep);
  const tail = value.slice(value.length - keep);
  const omitted = value.length - head.length - tail.length;
  return `${head}\n[... ${omitted} chars omitted ...]\n${tail}`;
}

function refDigest(value: unknown): string {
  try {
    return digest(value ?? null);
  } catch {
    return digest({ unsupported: describeValue(value) });
  }
}

function refChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return canonicalJson(value ?? null).length;
  } catch {
    return 0;
  }
}

function entryChars(entry: EvidenceLedgerEntry): number {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function describeValue(value: unknown): string {
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  return typeof value;
}
