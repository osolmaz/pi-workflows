---
title: Capture the user's complete intent in Autoplan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-25
---

# Capture the user's complete intent in Autoplan

Autoplan must begin by asking the model to capture the user's instructions from the conversation. The result is one text value named `originalUserInstructions`. This value is the authoritative task text for every later planning step.

The capture instruction must tell the model to include everything that the user has instructed for the intended purpose in the given context. This includes relevant earlier messages and queued messages that are present in the model context. When several messages contribute, the model must preserve their wording and order in one text value. It must not summarize, rewrite, explain, label, omit, or add instructions.

The model is the authority for the captured text. Validation checks only that the result is a non-empty string. It does not compare the text with Pi session entries. After acceptance, the workflow must preserve the exact string, including its internal whitespace.

## Selected design

Add one mandatory `agent` node before Autoplan's existing `frame` node. The node returns this shape:

```json
{
  "originalUserInstructions": "one text value"
}
```

The field is a string. It is not an array of messages or message objects.

Every later Autoplan agent prompt must include the accepted string explicitly. The framing, practical candidates, ideal end state, selection, and implementation plan must use it as the authoritative user instructions. The existing structured input remains supplemental:

- `problem` can provide a caller-supplied description and can still support the run title;
- `scope` states the authorized scope;
- `constraints` carries explicit limits;
- `previousPlan` carries a plan that may need review; and
- `newEvidence` carries evidence that can affect the plan.

The final ready and blocked outputs must include `originalUserInstructions` for audit and downstream use. The node output and final output remain durable through the existing workflow run store.

## Implementation plan

### 1. Add the intent result contract

Add a result type with one `originalUserInstructions` string. Add a validator that rejects a missing, non-string, or whitespace-only value and returns the original string without trimming or normalization.

**Where:** `src/builtins/autoplan.workflow.ts` and focused Autoplan tests.

**Verify:** Tests accept internal whitespace unchanged and reject empty or whitespace-only text. Type and runtime checks reject arrays and message objects.

### 2. Add the first Autoplan node

Add a mandatory intent-capture agent before `frame` and make it the workflow entry node. Its prompt must tell the model to:

- inspect the conversation context;
- include everything the user has instructed for the intended purpose in that context;
- include relevant earlier or queued user messages that are present in context;
- preserve the wording and order when several messages contribute;
- return one `originalUserInstructions` text string; and
- not summarize, rewrite, explain, label, omit, or add instructions.

Route this node directly to `frame` after successful validation.

**Where:** `src/builtins/autoplan.workflow.ts`.

**Verify:** Graph tests prove that the new node is first and mandatory. Prompt tests check the complete single-string instruction and the direct route to `frame`.

### 3. Use the captured text throughout planning

Include `originalUserInstructions` explicitly in every later Autoplan agent prompt: `frame`, `propose`, `ideal`, `choose`, and `plan`. Keep scope, constraints, previous plans, new evidence, and earlier step outputs as supplemental context. Do not let `input.problem` replace the captured instructions.

**Where:** `src/builtins/autoplan.workflow.ts` and focused prompt tests.

**Verify:** Use a distinct captured string and caller problem in tests. Confirm that every later agent prompt contains the captured string and does not present the caller problem as the authoritative instructions.

### 4. Preserve the text in final results

Add `originalUserInstructions` to both ready and blocked result types and final values. Read it from the accepted capture output without changing it.

**Where:** `src/builtins/autoplan.workflow.ts` and built-in workflow tests.

**Verify:** Ready and blocked runs return the exact captured string. Resume and normal run persistence continue through the existing node-output and final-output records.

### 5. Update the public workflow reference

Document the mandatory capture step, the one-string contract, model authority, later prompt use, and final-output field in the built-in Autoplan section.

**Where:** `docs/workflows.md`.

**Verify:** Documentation checks pass, and the reference agrees with the implementation and tests.

## Boundaries

- Use existing `agent`, `compute`, edge, validation, output, and persistence behavior.
- Do not change Pi core or private Pi APIs.
- Do not add session-message inference, conversation bindings, an amendment journal, or a workflow-engine primitive.
- Do not compare the model's text with session history.
- Do not add aliases, fallback behavior, dual paths, feature flags, a parallel schema version, or compatibility shims.
- Do not publish a package or update downstream package pins as part of this change.

## Verification

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
```
