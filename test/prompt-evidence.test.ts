import { describe, expect, it } from "vitest";
import {
  EVIDENCE_MAX_DEPTH,
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_REF_SCHEMA,
  EVIDENCE_TEXT_CHARS,
  PROMPT_CEILING_CHARS,
  boundLedger,
  evidenceRef,
  isEvidenceRef,
  ledgerChars,
  projectEvidence,
  projectLedger,
  type EvidenceLedgerEntry,
  type EvidenceViews,
} from "../src/workflows/prompt-evidence.js";

const NO_VIEWS: EvidenceViews = new Map();

function longText(chars = EVIDENCE_TEXT_CHARS + 500): string {
  return `HEAD${"x".repeat(chars)}TAIL`;
}

function entry(index: number, output: unknown): EvidenceLedgerEntry {
  return {
    attemptId: `attempt-${index}`,
    nodeId: `node-${index}`,
    outcome: "ok",
    output,
  };
}

function deep(value: unknown, depth: number): unknown {
  let nested = value;
  for (let index = 0; index < depth; index += 1) nested = { nested };
  return nested;
}

describe("projectEvidence", () => {
  it("returns small values unchanged", () => {
    const value = { route: "ready", counts: [1, 2, 3], nested: { ok: true } };
    expect(projectEvidence(value, NO_VIEWS)).toEqual(value);
  });

  it("keeps a string at the limit and collapses a longer string", () => {
    const atLimit = "x".repeat(EVIDENCE_TEXT_CHARS);
    expect(projectEvidence(atLimit, NO_VIEWS)).toBe(atLimit);
    const projected = projectEvidence(longText(), NO_VIEWS);
    if (!isEvidenceRef(projected)) throw new Error("a long string must become a ref");
    expect(projected.schema).toBe(EVIDENCE_REF_SCHEMA);
    expect(projected.chars).toBe(longText().length);
    expect(projected.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(projected.text).toContain("chars omitted");
    expect(projected.text?.startsWith("HEAD")).toBe(true);
    expect(projected.text?.endsWith("TAIL")).toBe(true);
    expect(projected.text?.length).toBeLessThanOrEqual(EVIDENCE_TEXT_CHARS);
  });

  it("keeps the first items of a long array and names the rest", () => {
    const items = Array.from({ length: EVIDENCE_MAX_ITEMS + 5 }, (_, index) => `item-${index}`);
    const projected = projectEvidence(items, NO_VIEWS);
    if (!Array.isArray(projected)) throw new Error("an array must stay an array");
    expect(projected).toHaveLength(EVIDENCE_MAX_ITEMS + 1);
    expect(projected[0]).toBe("item-0");
    expect(projected[EVIDENCE_MAX_ITEMS - 1]).toBe(`item-${EVIDENCE_MAX_ITEMS - 1}`);
    expect(projected[EVIDENCE_MAX_ITEMS]).toMatchObject({
      schema: EVIDENCE_REF_SCHEMA,
      omitted: 5,
    });
  });

  it("collapses a subtree deeper than the depth limit", () => {
    const shallow = projectEvidence(deep("leaf", EVIDENCE_MAX_DEPTH - 1), NO_VIEWS);
    expect(JSON.stringify(shallow)).toContain("leaf");
    const deepValue = projectEvidence(deep("leaf", EVIDENCE_MAX_DEPTH + 2), NO_VIEWS);
    expect(JSON.stringify(deepValue)).toContain(EVIDENCE_REF_SCHEMA);
  });

  it("replaces a registered schema with its view and bounds the view result", () => {
    const views: EvidenceViews = new Map([
      ["test.v1", (value) => ({ route: value.route, blob: value.blob })],
    ]);
    const value = { schema: "test.v1", route: "ready", blob: longText(200_000), drop: "me" };
    const projected = projectEvidence(value, views) as Record<string, unknown>;
    expect(projected.route).toBe("ready");
    expect(projected.drop).toBeUndefined();
    expect(isEvidenceRef(projected.blob)).toBe(true);
  });

  it("walks a value whose schema has no registered view", () => {
    const value = { schema: "unregistered.v1", blob: longText() };
    const projected = projectEvidence(value, NO_VIEWS) as Record<string, unknown>;
    expect(projected.schema).toBe("unregistered.v1");
    expect(isEvidenceRef(projected.blob)).toBe(true);
  });

  it("falls back to the generic rules when a view fails", () => {
    const views: EvidenceViews = new Map([
      [
        "test.v1",
        () => {
          throw new Error("view failed");
        },
      ],
    ]);
    const projected = projectEvidence({ schema: "test.v1", blob: longText() }, views) as Record<
      string,
      unknown
    >;
    expect(projected.schema).toBe("test.v1");
    expect(isEvidenceRef(projected.blob)).toBe(true);
  });

  it("terminates on a cycle and on values JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(projectEvidence(cyclic, NO_VIEWS))).not.toThrow();
    for (const value of [1n, Symbol("s"), () => "f", undefined]) {
      expect(() => JSON.stringify(projectEvidence({ value }, NO_VIEWS))).not.toThrow();
    }
    expect(projectEvidence({ value: undefined }, NO_VIEWS)).toEqual({ value: null });
  });

  it("is deterministic and does not mutate the input", () => {
    const value = Object.freeze({
      schema: "test.v1",
      long: Object.freeze(longText()),
      nested: Object.freeze({ list: Object.freeze([1, 2, 3]) }),
    });
    const first = projectEvidence(value, NO_VIEWS);
    expect(projectEvidence(value, NO_VIEWS)).toEqual(first);
    expect(value.long).toBe(longText());
    expect(value.nested.list).toEqual([1, 2, 3]);
  });

  it("builds a stable ref for a collapsed value", () => {
    const ref = evidenceRef({ a: 1 });
    expect(ref).toEqual(evidenceRef({ a: 1 }));
    expect(ref.chars).toBe(JSON.stringify({ a: 1 }).length);
  });
});

describe("projectLedger", () => {
  it("projects every entry output", () => {
    const ledger = projectLedger([entry(1, { blob: longText() })], NO_VIEWS);
    const first = ledger[0];
    if (first === undefined) throw new Error("the ledger must keep its entry");
    expect(isEvidenceRef((first.output as { blob: unknown }).blob)).toBe(true);
    expect(first.nodeId).toBe("node-1");
  });
});

describe("boundLedger", () => {
  it("collapses the oldest entries first and keeps the newest whole", () => {
    const ledger = [
      entry(1, { text: "old".repeat(1_000) }),
      entry(2, { text: "middle".repeat(1_000) }),
      entry(3, { text: "newest" }),
    ];
    // Three collapsed entries fit in 700 characters; the two raw entries do not.
    const bounded = boundLedger(ledger, 700);
    expect(ledgerChars(bounded)).toBeLessThanOrEqual(700);
    expect(isEvidenceRef(bounded[0]?.output)).toBe(true);
    expect(isEvidenceRef(bounded[1]?.output)).toBe(true);
    expect(bounded[2]?.output).toEqual({ text: "newest" });
  });

  it("leaves a ledger that already fits unchanged", () => {
    const ledger = [entry(1, { small: true })];
    const bounded = boundLedger(ledger, PROMPT_CEILING_CHARS);
    expect(bounded).toEqual(ledger);
    expect(isEvidenceRef(bounded[0]?.output)).toBe(false);
  });

  it("collapses every entry when the budget cannot hold one", () => {
    const ledger = [
      entry(1, { text: longText() }),
      entry(2, { text: longText() }),
      entry(3, { text: longText() }),
    ];
    const bounded = boundLedger(ledger, 1);
    expect(bounded).toHaveLength(3);
    for (const item of bounded) expect(isEvidenceRef(item.output)).toBe(true);
  });

  it("treats a ledger JSON cannot serialize as over budget instead of throwing", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    const ledger = [entry(1, { cyclic })];
    expect(ledgerChars(ledger)).toBe(Number.MAX_SAFE_INTEGER);
    const bounded = boundLedger(ledger, 100);
    expect(isEvidenceRef(bounded[0]?.output)).toBe(true);
    expect(() => JSON.stringify(bounded)).not.toThrow();
  });
});
