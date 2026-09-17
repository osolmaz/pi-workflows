import { MAX_COMMAND_BATCH_ITEMS } from "./command-batch.js";
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
 * Two rules keep the walk finite and predictable. A registered view runs once per schema on a path,
 * and the generic rules bound whatever the view returns. A view result also opens a fresh depth
 * budget, because a view is a bounded replacement for a whole subtree and its fields must not depend
 * on how deeply the prompt happens to nest the result.
 */

/** Ceiling for one authored agent prompt, in characters. Shared by every prompt builder. */
export const PROMPT_CEILING_CHARS = 96_000;

/** Schema identifier of a collapsed value. */
export const EVIDENCE_REF_SCHEMA = "pi-workflows.evidence-ref.v1";

/** Longest string kept verbatim. Longer strings become a ref with a head and tail excerpt. */
export const EVIDENCE_TEXT_CHARS = 4_000;

/**
 * Longest array kept in full. Extra items become one ref that names the count.
 *
 * The largest list that a registered view carries whole is a command batch, whose own limit is
 * `MAX_COMMAND_BATCH_ITEMS`. A smaller cap here would drop checks that a view already named, and the
 * size budget, not this cap, is what bounds one prompt. The cap therefore follows that limit.
 */
export const EVIDENCE_MAX_ITEMS = MAX_COMMAND_BATCH_ITEMS;

/** Most fields kept per object. Extra fields become one ref that names the count. */
export const EVIDENCE_MAX_FIELDS = 200;

/** Deepest structured value kept in full. Deeper subtrees become one ref. */
export const EVIDENCE_MAX_DEPTH = 8;

const EXCERPT_MARKER_CHARS = 40;

/** Sentinel for a view that failed. A view error falls back to the generic rules. */
const VIEW_FAILED = Symbol("evidence-view-failed");

const NO_APPLIED_VIEWS: ReadonlySet<string> = new Set();

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
  return projectValue(value, views, 0, NO_APPLIED_VIEWS);
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

/** Serialized size of one value in characters. An unrepresentable value reads as unbounded. */
export function evidenceChars(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Collapse the largest fields of one projected object until it fits the budget.
 *
 * The projection bounds every string, array, object width, and depth, but a value can still be large
 * overall. This bounds the whole value, which is what one prompt line needs. It collapses the largest
 * field first, so the small fields, which are the decisive ones, stay readable. A value that is not
 * a plain object is returned unchanged.
 */
export function boundEvidence(value: unknown, budgetChars: number): unknown {
  if (!isPlainObject(value)) return value;
  const bounded: Record<string, unknown> = { ...value };
  const keys = Object.keys(bounded).sort(
    (left, right) => evidenceChars(bounded[right]) - evidenceChars(bounded[left]),
  );
  for (const key of keys) {
    if (evidenceChars(bounded) <= budgetChars) break;
    if (isEvidenceRef(bounded[key])) continue;
    bounded[key] = evidenceRef(bounded[key]);
  }
  return bounded;
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
 * The newest entries stay whole, because they are the ones a decision depends on. When no shape fits,
 * the smallest one this walk built is returned, and the caller reports the remaining overflow.
 *
 * Collapsing one entry adds a digest and a size in place of its output, so a reference to a tiny
 * output is larger than the output itself. The smallest shape is therefore not always the fully
 * collapsed one, and callers read this result as the room the ledger needs at least.
 */
export function boundLedger(
  entries: EvidenceLedgerEntry[],
  budgetChars: number,
): EvidenceLedgerEntry[] {
  const bounded = entries.map((entry) => ({ ...entry }));
  let total = ledgerChars(bounded);
  let smallestChars = total;
  let smallest: EvidenceLedgerEntry[] | undefined;
  for (let index = 0; index < bounded.length && total > budgetChars; index += 1) {
    const entry = bounded[index];
    if (entry === undefined || isEvidenceRef(entry.output)) continue;
    bounded[index] = { ...entry, output: evidenceRef(entry.output) };
    total = ledgerChars(bounded);
    if (total <= budgetChars) return bounded;
    if (total < smallestChars) {
      smallestChars = total;
      smallest = bounded.map((item) => ({ ...item }));
    }
  }
  return smallest ?? entries.map((entry) => ({ ...entry }));
}

function projectValue(
  value: unknown,
  views: EvidenceViews,
  depth: number,
  applied: ReadonlySet<string>,
): unknown {
  const schema = knownSchema(value, views, applied);
  if (schema !== undefined) {
    const viewed = callView(views, schema, value);
    if (viewed !== VIEW_FAILED) {
      return projectUnregistered(viewed, views, 0, withApplied(applied, schema));
    }
  }
  return projectUnregistered(value, views, depth, applied);
}

function projectUnregistered(
  value: unknown,
  views: EvidenceViews,
  depth: number,
  applied: ReadonlySet<string>,
): unknown {
  if (typeof value === "string") {
    return value.length > EVIDENCE_TEXT_CHARS ? evidenceRef(value) : value;
  }
  if (depth >= EVIDENCE_MAX_DEPTH && isStructured(value)) return evidenceRef(value);
  if (Array.isArray(value)) return projectArray(value, views, depth, applied);
  if (isPlainObject(value)) return projectObject(value, views, depth, applied);
  return projectScalar(value);
}

function projectArray(
  value: readonly unknown[],
  views: EvidenceViews,
  depth: number,
  applied: ReadonlySet<string>,
): unknown[] {
  const kept = value
    .slice(0, EVIDENCE_MAX_ITEMS)
    .map((item) => projectValue(item, views, depth + 1, applied));
  const dropped = value.slice(EVIDENCE_MAX_ITEMS);
  if (dropped.length === 0) return kept;
  return [...kept, { ...evidenceRef(dropped), omitted: dropped.length }];
}

function projectObject(
  value: Record<string, unknown>,
  views: EvidenceViews,
  depth: number,
  applied: ReadonlySet<string>,
): Record<string, unknown> {
  const entries = Object.entries(value);
  // A null prototype keeps a recorded `__proto__` field an ordinary field instead of a setter.
  const projected: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of entries.slice(0, EVIDENCE_MAX_FIELDS)) {
    projected[key] = projectValue(entry, views, depth + 1, applied);
  }
  const dropped = entries.slice(EVIDENCE_MAX_FIELDS);
  if (dropped.length > 0) {
    projected[omittedFieldsKey(projected)] = {
      ...evidenceRef(Object.fromEntries(dropped)),
      omitted: dropped.length,
    };
  }
  return projected;
}

function omittedFieldsKey(projected: Record<string, unknown>): string {
  let key = "omittedFields";
  let index = 2;
  while (Object.hasOwn(projected, key)) {
    key = `omittedFields${index}`;
    index += 1;
  }
  return key;
}

function projectScalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "number" || type === "boolean") return value;
  return evidenceRef(value);
}

function knownSchema(
  value: unknown,
  views: EvidenceViews,
  applied: ReadonlySet<string>,
): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const schema = value["schema"];
  if (typeof schema !== "string" || schema.length === 0) return undefined;
  if (applied.has(schema)) return undefined;
  return views.has(schema) ? schema : undefined;
}

function callView(views: EvidenceViews, schema: string, value: unknown): unknown {
  const view = views.get(schema);
  if (view === undefined) return VIEW_FAILED;
  try {
    return view(value as Record<string, unknown>);
  } catch {
    return VIEW_FAILED;
  }
}

function withApplied(applied: ReadonlySet<string>, schema: string): ReadonlySet<string> {
  const next = new Set(applied);
  next.add(schema);
  return next;
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

function describeValue(value: unknown): string {
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  return typeof value;
}
