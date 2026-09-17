---
title: Bound built-in agent prompt evidence
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-17
---

# Bound built-in agent prompt evidence

Status: implemented, validated, and in review

The Autoimplement decision prompt embeds raw step results. One large result was copied into the same
prompt several times, and the prompt grew to 814,947 bytes. That single message pushed the session
past the model's context window and ended the run.

This plan separates the durable record from the routing evidence. Every persisted structured result
already carries a versioned `schema` identifier, so the projection keys off that identifier. The
complete result stays in run state. Only the text that reaches a prompt is bounded.

## Problem

Measured from a real Autoimplement run on 2026-09-17:

- The `documentation` step result was 265,600 bytes. Inside it, the same change-verification record
  of 131,223 bytes was stored twice, as `output.documentation.evidence` and `output.verification`.
  See [autodoc.workflow.ts](../../src/builtins/autodoc.workflow.ts), where both fields call
  `verificationResult(context)`.
- Each record carries the verification command batches. The stdout and stderr of one batch item are
  bounded only by `MAX_COMMAND_BATCH_OUTPUT_CHARS`, which is 1,000,000 characters per item. See
  [command-batch.ts](../../src/workflows/command-batch.ts).
- The decide prompt reads step results through `JSON.stringify`. That same 265 KB result reached the
  prompt twice: once inside the observation object and once inside the recent-attempts list.
- The assembled decide prompt was 814,947 bytes, about 240k tokens.
- The session then exceeded the model's 272,000-token window. The provider returned one output token
  with finish reason `length`. Pi's one compact-and-retry recovery was spent, and the run failed after
  its delayed-submission reminders.

The prompt was not wrong, it was unbounded. Nothing in the workflow measured it, and one result type
was capable of filling it alone.

## Selected change

Add one pi-independent projection in `src/workflows`, key it on the versioned result `schema`, and
apply it wherever a step result enters an Autoimplement prompt.

1. Each builtin that produces a large result may export an evidence view for its schema. The view is a
   pure function of the typed result. It keeps the fields a routing decision needs and replaces bulk
   payloads with sizes, digests, and references.
2. One generic walk in `src/workflows/prompt-evidence.ts` replaces every subtree that carries a
   registered schema with its view. Values with no registered schema still get bounded by the generic
   rules.
3. The ceiling is the existing single-prompt limit of 96,000 characters, currently `MAX_PROMPT_CHARS`
   in [pi-agent-group.ts](../../src/builtins/pi-agent-group.ts). Move it into the new module so one
   number serves both callers.
4. When the projected ledger still exceeds its budget, collapse the oldest entries to references that
   keep the node id, outcome, error, attempt id, byte count, and digest.

The complete results stay unchanged in `state.steps[].output`, so recorded shapes, the viewer, resume,
and reconciliation are not affected.

### Why the view layer comes first

The generic rules alone would bound the prompt, but they would keep a piece of everything and drop
nothing. They would cut a log to 4,000 characters without saying whether the log mattered. A view says
what matters for one result type, once, next to the type that defines it.

The measured case shows the difference. The verification record does not need its command logs in a
routing prompt. It needs the route, the reason, the failure findings, and the fingerprints. Those
fields are a few kilobytes. The view keeps them and drops the rest, so the prompt becomes both shorter
and more useful.

### Why the schema identifier is the hook

Every persisted structured value in this repository already carries a versioned `schema` identifier,
for example `pi-workflows.change-verification.v1` and `pi-workflows.command-batch-result.v1`. That
identifier is already part of the durable contract. Keying on it means:

- no per-prompt field list to maintain by hand;
- each producer owns its own view, next to the type it describes;
- the walker never imports a builtin, so `src/workflows` stays Pi-independent and the dependency
  boundaries hold.

Because the walk descends into unknown values, the documented plan result needs no view of its own.
Its two nested verification records each carry the change-verification schema, so both are replaced
where they sit. That removes the duplicate from the prompt without touching
[autodoc.workflow.ts](../../src/builtins/autodoc.workflow.ts).

## Scope

In scope, inside `osolmaz/pi-workflows` only:

- `src/workflows/prompt-evidence.ts`, new.
- `src/builtins/change-verification.workflow.ts`, to export its evidence view.
- `src/builtins/autoimplement.workflow.ts`, to project the observation, the recent-attempts ledger,
  and to enforce the ceiling.
- `src/builtins/pi-agent-group.ts`, to share the ceiling constant.
- `src/workflows/index.ts`, to export the new public surface.
- `test/prompt-evidence.test.ts`, new, and additions to `test/builtin-autoimplement.test.ts`.
- `docs/WORKFLOWS.md`, a new section.
- This plan document.

Out of scope:

- Any change to a route id, step id, step validator, recorded step shape, or run state format.
- The prompt builders of the other built-in workflows. They may adopt the projection later.
- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and the configured model context window.
- The Autoimplement workspace in the other repository and its stopped run.

## Design

### `src/workflows/prompt-evidence.ts`

Public surface:

```ts
export const PROMPT_CEILING_CHARS = 96_000;
export const EVIDENCE_REF_SCHEMA = "pi-workflows.evidence-ref.v1";
export const EVIDENCE_TEXT_CHARS = 4_000;
export const EVIDENCE_MAX_ITEMS = 20;
export const EVIDENCE_MAX_DEPTH = 8;

export type EvidenceRef = {
  schema: typeof EVIDENCE_REF_SCHEMA;
  digest: string;
  chars: number;
  text?: string;
  omitted?: number;
};

export type EvidenceView = (value: Record<string, unknown>) => unknown;
export type EvidenceViews = ReadonlyMap<string, EvidenceView>;

export type EvidenceLedgerEntry = {
  attemptId: string;
  nodeId: string;
  outcome: string;
  error?: string;
  output: unknown;
};

export function projectEvidence(value: unknown, views: EvidenceViews): unknown;
export function evidenceRef(value: unknown): EvidenceRef;
export function projectLedger(
  entries: readonly EvidenceLedgerEntry[],
  views: EvidenceViews,
): EvidenceLedgerEntry[];
export function ledgerChars(entries: readonly EvidenceLedgerEntry[]): number;
export function boundLedger(
  entries: EvidenceLedgerEntry[],
  budgetChars: number,
): EvidenceLedgerEntry[];
```

Sizes are character counts, matching the `_CHARS` limits that the repository already uses.

`projectEvidence` rules, applied in this order:

1. An object whose `schema` field is a non-empty string with a registered view is replaced by that
   view's result. The generic rules then bound the view result, and a view never runs again on its own
   replacement.
2. An array keeps at most `EVIDENCE_MAX_ITEMS` projected items. Extra items become one `EvidenceRef`
   with `omitted` set to their count.
3. A plain object is projected field by field until `EVIDENCE_MAX_DEPTH` is reached, after which the
   whole subtree becomes an `EvidenceRef`.
4. A string longer than `EVIDENCE_TEXT_CHARS` becomes an `EvidenceRef` whose `text` holds a head and
   tail excerpt inside the cap, plus `chars` and `digest`.
5. A number, boolean, or null passes through. `undefined` becomes `null`, so a JSON round trip is
   stable.

`projectEvidence` is total. It never throws on a cycle, a bigint, a function, a symbol, a very deep
tree, a failing view, or an unknown value shape. Any of those becomes an `EvidenceRef`. It never
mutates its input.

`boundLedger` collapses from the oldest entry forward. It replaces one entry's `output` with
`evidenceRef(entry.output)` at a time and stops as soon as the serialized ledger fits the budget. It
keeps the newest entries intact, because the newest attempt is the one a decision depends on. Call it
with the projected ledger, so the size it measures is the size a prompt shows. When even a fully
collapsed ledger is over budget, every entry is collapsed and the caller reports the overflow.

### `changeVerificationEvidence`

`src/builtins/change-verification.workflow.ts` exports one view for `CHANGE_VERIFICATION_SCHEMA`. It
keeps:

- `route`, `reason`, `failureFingerprint`, `originatingWorkflow`, `qualifiedNode`;
- `changedFiles`, `evidence`, `outputReferences`;
- the five finding lists as `{ checkId, kind, summary, fingerprint, candidateOutputRef, baseOutputRef }`;
- `repairAttempts` as `{ attempt, kind, fingerprint, changedFiles, result }`;
- `candidateCommands` and `baseCommands` as `{ completed, total, items }`, where each item keeps
  `{ id, command, args, cwd, outcome, exitCode, signal, durationMs, stdoutChars, stderrChars,
stdoutTruncated, stderrTruncated, error }`.

It drops the raw stdout and stderr text. Those logs stay in the durable result. A reader who needs one
uses `outputReferences`, which already names the recorded payload.

Autoimplement registers exactly this one view. Its nested records are the only registered schema that
reaches the decide prompt today, so one typed view plus the generic rules bounds the whole prompt. The
registry is the place to add the next result type.

### Autoimplement changes

- The decide prompt projects the recorded observation. The record itself is untouched, so
  `state.steps[].output` still holds the complete observation, and `resultRoutes`,
  `controlProgressFingerprint`, and `consecutiveNoProgressAttempts` keep reading the raw result. Route
  availability and the progress fingerprint therefore cannot change.
- `controlEvidenceLedger` replaces `recentWorkflowAttempts`. It drops the entry that is already shown
  as `latestAttempt`, and it drops the included-workflow echo steps whose result repeats a parent
  node's result, so one result appears once. Each entry carries the attempt id, node id, outcome,
  error, and output.
- The decide prompt keeps its exact line labels and their order. The `Observation` and
  `Recent attempts` values are projected. The `Task`, `Plan`, `Scope`, and `Constraints` lines stay
  whole, because the decider must see them.
- After assembly, the prompt is measured against `PROMPT_CEILING_CHARS`. If it is over, the ledger is
  rebuilt with `boundLedger` against the remaining budget. If it is still over, the build throws an
  error that names the largest line and its size, instead of sending an impossible request.

### One ceiling, one owner

`MAX_PROMPT_CHARS` in `pi-agent-group.ts` is already 96,000 characters and guards the agent group
prompt. Move the number to `PROMPT_CEILING_CHARS` in the new module and import it there. `src/builtins`
may import `src/workflows`, so the direction respects the declared boundary. Two independent prompt
ceilings would drift, and the repository asks for a named external interface rather than an arbitrary
limit.

## Behavior and compatibility

- No recorded shape changes. `state.steps[].output` keeps every full result. `state.steps[].prompt`
  keeps every full prompt.
- No route id, step id, node id, validator, or outcome changes.
- `AutoimplementObservation.latestAttempt.output` stays typed `unknown`. Values under the caps read
  exactly as they do today, because the projection is the identity function for them.
- Existing tests parse the decide prompt with `/Observation: (.+)\nRecent attempts:/` and read fields
  from that JSON. Those fields are small, so they pass through unchanged.
- A recorded run resumed with the new version receives projected prompts from that point on. Nothing
  already recorded is rewritten.

## Tests

`test/prompt-evidence.test.ts`, fifteen cases:

- identity for a value under every cap, and for a string exactly at the text cap;
- a long string becomes a ref with a head and tail excerpt, its character count, and a digest;
- an array over the cap keeps its first items and one ref that names the count;
- a depth cap replaces the deep subtree with a ref;
- a registered schema is replaced by its view, the view result is bounded, and a field the view dropped
  stays dropped;
- an unregistered schema is walked normally;
- a failing view falls back to the generic rules;
- a cycle terminates, and a bigint, a function, a symbol, and `undefined` do not throw;
- the same input twice produces the same output, and a frozen input is not mutated;
- `evidenceRef` is stable for equal values;
- `projectLedger` projects every entry output;
- `boundLedger` collapses the oldest entries first, keeps the newest entry whole, leaves a ledger that
  already fits unchanged, collapses every entry when the budget cannot hold one, and treats a ledger
  that JSON cannot serialize as over budget instead of throwing.

`test/builtin-autoimplement.test.ts`, one regression case:

- the fixture holds one result with a 1,000,000-character command log, recorded twice inside a
  documented plan and once more through the observation's latest attempt;
- the recorded observation stays over 2,000,000 characters and still contains the log text, so the
  durable record is unchanged;
- the recorded routes are exactly `implementation`, `redesign`, and `blocked`, so route availability
  is unchanged;
- the decide prompt built from that record is at or below `PROMPT_CEILING_CHARS`, stays under 50,000
  characters, keeps the verification reason, the failure summary, and the fingerprint, and contains
  none of the log text;
- the prompt still matches `Observation: …\nRecent attempts: …`, and the existing prompt-content
  tests pass with no edit.

The regression case fails on the earlier code with an assembled prompt of 4,006,002 characters, and
passes after the change.

## Verification

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

All four pass. Coverage for `src/workflows/prompt-evidence.ts` is 100% of lines and 92.75% of
branches.

The repository also requires one real-model live E2E with a low-cost model. It passed:

```json
{
  "api": "openai-completions",
  "mode": "real-model",
  "model": "deepseek/deepseek-v4-flash",
  "modelCostUsd": 0.0034617040260000002,
  "modelMaxOutputTokens": 4000,
  "packageVersion": "0.17.3",
  "piVersion": "0.85.0",
  "provider": "openrouter",
  "result": "passed"
}
```

## Risks

| Risk                                                          | Mitigation                                                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A view drops a field the routing decision needs.              | Keep the fields `resultRoutes` reads: route, status, reason, findings, fingerprints. Add a test that asserts them.                                   |
| The projection changes route availability or the fingerprint. | Project at prompt time only. The recorded observation keeps the raw result, and a regression test compares the recorded routes with the raw fixture. |
| The walker throws on an unusual value shape.                  | Make it total: a depth cap, a cycle guard, and a ref for anything it cannot represent. One test per case.                                            |
| A result type with no view stays large.                       | The generic rules bound it, and `boundLedger` collapses the oldest entries. The view registry is the place to add the next type.                     |
| The prompt is still over the ceiling after projection.        | The build throws a named error with per-line sizes, so the failure is local and legible instead of a dead run.                                       |
| Two prompt ceilings drift apart.                              | One exported constant, used by both callers.                                                                                                         |

## Rollout

This is a code change with no migration. The new module is additive. The behavior change is confined
to the text of an Autoimplement decide prompt: the same evidence in a bounded form. Run state keeps
the complete results and prompts, so a recorded run resumed after the change keeps its recorded
results and receives bounded prompts from that point on.
