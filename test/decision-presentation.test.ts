import { describe, expect, it } from "vitest";
import {
  MAX_PRESENTATION_BLOCKS,
  decisionDocumentSegments,
  decisionPresentationDigest,
  digestCanonical,
  humanDecisionChannelRequest,
  legacyDecisionPresentation,
  normalizeDecisionPresentation,
  validateHumanDecisionRequestIntegrity,
} from "../src/workflows/decision-presentation.js";
import {
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
} from "../src/workflows/human-decision.js";

const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});

const presentation = {
  schema: "pi-workflows.decision-presentation.v1" as const,
  summary: "Review the change.",
  blocks: [
    { kind: "section" as const, title: "Changes" },
    { kind: "bullets" as const, items: ["Keep machine data.", "Show readable text."] },
    {
      kind: "fields" as const,
      items: [{ label: "Revision", value: "1" }],
    },
    { kind: "preformatted" as const, text: "npm run check\r\nnpm run test:e2e" },
  ],
};

function request(overrides: { summary?: string; subject?: unknown } = {}) {
  return createHumanDecisionRequest({
    runId: "run-a",
    workflowName: "workflow-a",
    nodeId: "approve",
    attemptId: "attempt-a",
    contract: { audience: "operator", choices },
    prompt: {
      title: "Approve",
      subject: overrides.subject ?? { plan: "a" },
      presentation: {
        ...presentation,
        summary: overrides.summary ?? presentation.summary,
      },
      revision: 2,
    },
    createdAt: "2026-08-19T00:00:00.000Z",
  });
}

describe("decision presentations", () => {
  it("normalizes line endings and computes a canonical trailing-newline digest", () => {
    const normalized = normalizeDecisionPresentation(presentation);
    expect(normalized.blocks.at(-1)).toEqual({
      kind: "preformatted",
      text: "npm run check\nnpm run test:e2e",
    });
    expect(decisionPresentationDigest(normalized)).toBe(digestCanonical(normalized));
    expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }));
    expect(digestCanonical({ b: 2, a: 1 })).toBe(
      "sha256:e8d38819d39f705646bfb643368eca78f7db476c16471dbc33b941b27326410d",
    );
  });

  it("rejects unknown fields, terminal controls, and declared bounds", () => {
    expect(() => normalizeDecisionPresentation({ ...presentation, extra: true })).toThrow(
      /unknown field extra/,
    );
    expect(() =>
      normalizeDecisionPresentation({ ...presentation, summary: "bad\u001btext" }),
    ).toThrow(/control character/);
    expect(() =>
      normalizeDecisionPresentation({
        ...presentation,
        blocks: Array.from({ length: MAX_PRESENTATION_BLOCKS + 1 }, () => ({
          kind: "paragraph",
          text: "x",
        })),
      }),
    ).toThrow(/257 blocks; limit is 256/);
  });

  it("binds subject and visible presentation changes to different request digests", () => {
    const original = request();
    const changedSubject = request({ subject: { plan: "b" } });
    const changedPresentation = request({ summary: "Review a different change." });
    expect(original.schema).toBe("pi-workflows.human-decision-request.v2");
    if (original.schema !== "pi-workflows.human-decision-request.v2") {
      throw new Error("expected v2 request");
    }
    expect(original.revision).toBe(2);
    expect(original.requestDigest).not.toBe(changedSubject.requestDigest);
    expect(original.requestDigest).not.toBe(changedPresentation.requestDigest);
    expect(original.subjectDigest).not.toBe(
      changedSubject.schema === "pi-workflows.human-decision-request.v2"
        ? changedSubject.subjectDigest
        : "",
    );
    expect(original.presentationDigest).not.toBe(
      changedPresentation.schema === "pi-workflows.human-decision-request.v2"
        ? changedPresentation.presentationDigest
        : "",
    );
  });

  it("rejects a changed durable subject or presentation", () => {
    const original = request();
    if (original.schema !== "pi-workflows.human-decision-request.v2") {
      throw new Error("expected v2 request");
    }
    expect(() =>
      validateHumanDecisionRequestIntegrity({ ...original, subject: { plan: "tampered" } }),
    ).toThrow(/subject digest/);
    expect(() =>
      validateHumanDecisionRequestIntegrity({
        ...original,
        presentation: { ...original.presentation, summary: "Tampered display" },
      }),
    ).toThrow(/presentation digest/);
  });

  it("passes only explicit operator content to channels", () => {
    const channel = humanDecisionChannelRequest(request());
    expect(channel).not.toHaveProperty("subject");
    expect(channel).not.toHaveProperty("body");
    expect(
      decisionDocumentSegments(channel)
        .map((segment) => segment.text)
        .join("\n"),
    ).toContain("Show readable text.");
    expect(JSON.stringify(channel)).not.toContain('"plan":"a"');
  });

  it("keeps oversized historical requests answerable with an explicit omission notice", () => {
    const largeText = "legacy line\n".repeat(8_000);
    const large = legacyDecisionPresentation(largeText);
    expect(large.blocks.length).toBeLessThanOrEqual(MAX_PRESENTATION_BLOCKS);
    expect(JSON.stringify(large)).toContain("Some legacy decision content is not shown");
    expect(JSON.stringify(large)).toContain("Body digest: sha256:");
    const manyFields = legacyDecisionPresentation(
      Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [`field-${index}`, { value: index }]),
      ),
    );
    expect(manyFields.blocks.length).toBeLessThanOrEqual(MAX_PRESENTATION_BLOCKS);
    expect(JSON.stringify(manyFields)).toContain("Some legacy decision content is not shown");
  });

  it("formats historical object bodies as readable sections and fields", () => {
    const legacy = legacyDecisionPresentation({
      planDigest: "sha256:abc",
      steps: ["Change the contract", "Run tests"],
      nested: { enabled: true },
    });
    const text = JSON.stringify(legacy);
    expect(text).toContain("Plan Digest");
    expect(text).toContain("Change the contract");
    expect(text).toContain("Enabled");
    expect(text).not.toContain('"planDigest"');
  });
});
