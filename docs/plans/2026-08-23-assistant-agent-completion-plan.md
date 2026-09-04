---
title: Add assistant completion to agent workflows
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-23
status: implemented
---

## Selected design

Keep `agent` as the only model-work node.

Use the existing `expectedOutput` key to select a visible assistant response:

```ts
agent({
  prompt: ({ input }) => `Summarize this:\n${JSON.stringify(input)}`,
  expectedOutput: assistantMessage(),
});
```

The two behaviors are:

- **Current agent:** the model calls `workflow submit`; the submitted JSON becomes the node output.
- **Assistant agent:** the model writes a normal assistant response; its exact visible text becomes the node output, and the workflow follows its normal edge.

The assistant mode is not a decision or checkpoint. It schedules one model turn, waits until that turn fully settles, records the result, and continues.

This needs no Pi API change and no new node type.

---

# Implementation plan

## 1. Record the completion-mode contract

### Change

Document that `agent` supports two mutually exclusive completion methods:

1. Workflow-tool submission.
2. Visible assistant response.

Define these rules:

- Existing agents keep their current workflow-tool behavior.
- Assistant completion is explicit through `expectedOutput: assistantMessage()`.
- Output-transforming `validate` is invalid with `assistantMessage()`.
- The assistant node output is the exact visible text.
- The text must be non-empty. A character limit applies only when the author sets `maxChars`.
- The node follows its configured edge after the assistant turn settles.
- It does not ask for human input and does not create a checkpoint.
- Intermediate tool-call assistant messages do not complete the node.
- Aborted, failed, and tool-only turns do not complete the node.
- A visible response is not retried after validation failure because that would show duplicate answers.
- Session-bound assistant output is unavailable to detached jobs without an origin session.

### Where

- New canonical plan under `docs/plans/`.
- `docs/workflows.md`
- `docs/WORKFLOW_STEP_MESSAGES.md`
- `docs/WORKFLOW_COMPOSITION.md`
- `docs/SQLITE_STATE.md`

### Verification

The documents distinguish assistant completion from:

- `workflow submit`;
- `notify`;
- root `presentationPrompt`;
- `checkpoint`;
- `humanDecision()`.

---

## 2. Extend the public `agent()` definition

### Change

Add a public assistant output builder:

```ts
assistantMessage();
```

Make `AgentNodeDefinition` a type-safe union:

```ts
type SubmittedAgentNodeDefinition = {
  nodeType: "agent";
  prompt: ...;
  expectedOutput?: string;
  validate?: ...;
};

type AssistantAgentNodeDefinition = {
  nodeType: "agent";
  prompt: ...;
  expectedOutput: AssistantMessageOutput;
  validate?: never;
};
```

Keep the existing submitted-agent API unchanged. This is an additive mode, not a compatibility shim.

`assistantMessage()` adds no Pi Workflows character limit by default. Authors can opt in with `assistantMessage({ maxChars: 2_000 })`. When supplied, `maxChars` must be a positive integer. A specific workflow such as `plain-summary` can set its own explicit limit.

### Where

- `src/workflows/types.ts`
- `src/workflows/definition.ts`
- `src/workflows/schema.ts`
- `src/workflows/index.ts`
- Type-level tests

### Verification

Type tests prove:

- existing agents still compile;
- assistant agents compile;
- `assistantMessage()` plus `validate` does not compile;
- omitted limits remain omitted in the definition;
- invalid explicit limits fail during definition validation;
- no new node type appears in graph or run records.

---

## 3. Add completion mode to the executor contract

### Change

Extend `AgentStepContract` with:

```ts
completion: "submit" | "assistant";
maxOutputChars?: number;
```

For existing submitted agents:

- append the current workflow step contract;
- keep `accept(output)`;
- keep nudges when the model settles without submitting.

For assistant agents:

- do not append workflow-submit instructions;
- append a short assistant completion contract;
- tell the model to answer normally and not call `workflow submit`;
- capture only visible text blocks;
- complete after `agent_settled`;
- return the exact text as `AgentStepSubmission.output`.

Example model contract:

```text
Reply with a normal assistant message.
Do not call the workflow tool to complete this step.
Your visible reply becomes the workflow step output.
```

When the author supplies `maxChars`, append that explicit limit to the model contract.

### Where

- `src/workflows/types.ts`
- `src/workflows/engine.ts`
- `src/extension/step-message.ts`
- `src/extension/executor.ts`

### Verification

Engine tests prove both completion modes use the same `agent` node type and route through ordinary edges.

---

## 4. Capture the interactive assistant response

### Change

Extend `ConversationStepExecutor` to track the pending completion mode.

For assistant completion:

1. Mark the conversation before sending the prompt.
2. Deliver the existing compact workflow step message.
3. Record `message_end`, then use the later `turn_end` message after all documented message replacements have run.
4. Keep the latest finalized assistant message from the current attempt.
5. Ignore thinking blocks and tool calls.
6. Wait for `agent_settled`.
7. Reject aborted, errored, empty, or tool-only outcomes.
8. Check the character limit when the author supplied one.
9. Record the conversation range.
10. Resolve the node with the exact assistant text.

Pi Workflows does not remove assistant text after a workflow submission. The response stays visible.

When the model calls `workflow submit` during an assistant step, return a clear error:

> This step completes with a normal assistant response. Do not submit workflow output.

Updates can remain unavailable for assistant completion unless later evidence shows a real need.

### Where

- `src/extension/executor.ts`
- `src/extension/index.ts`
- `src/extension/session-events.ts`
- `src/extension/recorder.ts`
- `src/extension/step-message.ts`

### Verification

Tests cover:

- one visible assistant message;
- exact captured text;
- text mixed with thinking;
- tool call followed by final text;
- several tool turns;
- auto-retry before final settlement;
- empty response;
- length stop;
- provider error;
- user Escape;
- timeout and cancellation;
- incorrect `workflow submit`;
- parent continuation only after settlement.

---

## 5. Make recovery duplicate-safe

### Change

Bind the assistant response to the existing run, node, and attempt IDs.

The custom workflow prompt already carries those IDs. Extend its message details with the completion mode.

Record an attempt-scoped assistant completion receipt containing:

- run ID;
- node ID;
- attempt ID;
- assistant session entry ID;
- text digest;
- bounded text;
- conversation range.

Before redelivering an unfinished assistant step, inspect the current session branch:

- If the matching prompt has a completed assistant child, validate and adopt it.
- If the matching prompt exists without a completed assistant response, resume the attempt.
- If no matching prompt exists, send it.
- Never adopt a response from another attempt or branch.

Use existing run state, trace, and session recording. Do not add a new store.

### Where

- `src/workflows/types.ts`
- `src/workflows/store.ts`
- `src/workflows/engine.ts`
- `src/extension/recorder.ts`
- `src/extension/executor.ts`
- SQLite run projection and recovery tests

### Verification

Crash tests cover:

- before prompt delivery;
- after prompt delivery;
- during streaming;
- after `message_end` but before `agent_settled`;
- after settlement but before node persistence;
- after node persistence but before routing;
- process restart;
- session reload;
- claim loss;
- stale branch response;
- repeated loop visits to the same node.

Each case produces at most one visible assistant response.

---

## 6. Handle interactive and detached execution honestly

### Change

Assistant completion needs a conversation where the user can see the assistant response.

Add an executor capability that distinguishes:

- session-visible execution;
- detached execution.

The interactive Pi executor supports assistant completion.

A detached WorkflowServer must not run such a node in an invisible RPC child. It must:

- park the run before the node;
- leave it claimable by the origin Pi session;
- resume when that session is available.

A resource manager child or detached run with no origin session must fail clearly before prompting:

> Assistant completion requires an origin Pi session.

Do not replace the response with a workflow notification.

Direct RPC clients can support assistant completion because RPC exposes `message_end` and `agent_settled` events to the client.

### Where

- `src/workflows/types.ts`
- `src/workflows/engine.ts`
- `src/server/runner.ts`
- `src/server/rpc-executor.ts`
- `src/server/rpc-bridge.ts` only if the bridge needs completion metadata
- Queue and host tests

### Verification

Tests prove:

- interactive TUI works;
- direct RPC captures the assistant response;
- a detached host parks before visible output;
- the origin session resumes and emits it once;
- a detached run without an origin session fails clearly;
- no assistant response is silently converted into a notification.

---

## 7. Add the general `plain-summary` workflow

### Change

Create a reusable built-in workflow with this input:

```ts
type PlainSummaryInput = {
  source: unknown;
  purpose: string;
  mustInclude?: string[];
  maxChars?: number;
  maxSentences?: number;
  format?: "paragraphs" | "bullets" | "mixed";
};
```

Use strict limits:

- serialized source: at most 50,000 characters;
- purpose: at most 1,000 characters;
- up to 32 required points;
- each required point: at most 500 characters;
- `maxChars`: default 2,000, maximum 10,000;
- `maxSentences`: default 5, maximum 20.

The workflow uses one assistant-completion agent. Its prompt says:

- use only the supplied source;
- start with the main point;
- use short, complete sentences;
- use common, concrete words;
- keep technical terms only when needed;
- do not invent facts;
- do not add a meta introduction;
- include every required point;
- obey the requested format and limits;
- do not use tools;
- do not call the workflow tool.

Do not import or depend on OnurPi’s personal `amk` skill. Put the stable plain-writing rules directly in this public workflow.

Return:

```ts
type PlainSummaryResult = {
  text: string;
};
```

The text is both:

- the visible assistant message;
- the included workflow’s result.

The workflow has no `notify` node and no `presentationPrompt`, because its assistant agent already presents the result.

### Where

- `src/builtins/plain-summary.workflow.ts`
- `src/builtins/index.ts`
- `src/builtins/catalog.ts`
- `examples/workflows/plain-summary.workflow.ts`
- `test/builtin-plain-summary.test.ts`

### Verification

Test it:

- standalone;
- included in a parent;
- nested;
- repeated in a loop;
- with paragraphs, bullets, and mixed output;
- with missing required facts;
- with excessive input;
- with excessive output;
- with hostile instructions inside `source`;
- with cancellation;
- with no duplicate final presentation.

---

## 8. Make Autoplan record every considered plan

### Change

Autoplan cannot summarize plans that exist only in hidden model reasoning. Make every candidate explicit in the durable `propose` output.

Change `propose` to return a bounded candidate list:

```ts
{
  candidates: [
    {
      id: "stable-id",
      title: "short title",
      gist: "plain description",
      solution: "full proposal",
      rationale: "why it could work",
      parts: ["part"],
      tradeoffs: ["trade-off"],
    },
  ];
}
```

Require two through four practical candidates.

Keep the separate ideal stage. Treat the ideal as another named candidate during selection.

When `previousPlan` exists, require the proposal stage to identify whether it remains a candidate or was rejected by new evidence.

Change `choose` to return:

```ts
{
  status: "ready",
  selectedId: "candidate-id-or-ideal",
  why: "reason",
  rejected: [
    { "id": "other-id", "reason": "why it was not selected" }
  ],
  compromises: ["compromise"]
}
```

Validate that:

- the selected ID exists;
- every non-selected candidate appears exactly once under `rejected`;
- no unknown candidate appears;
- no candidate is omitted;
- the previous plan is accounted for when supplied.

“All proposed plans” means these explicit records. It does not include or request hidden chain-of-thought.

### Where

- `src/builtins/autoplan.workflow.ts`
- `test/builtin-autoplan.test.ts`
- Autoplan docs and skill text

### Verification

Tests cover candidate completeness, stable IDs, ideal selection, practical selection, previous-plan treatment, duplicate rejection entries, missing candidates, and blocked selection.

---

## 9. Compose `plain-summary` into Autoplan

### Change

Add `plain-summary` as an included workflow.

For a successful selection, pass:

- the chosen candidate;
- why it was chosen;
- the detailed implementation plan;
- every rejected candidate;
- every rejection reason;
- the relationship to the ideal;
- important limits and compromises.

Require the visible response to contain:

1. A plain explanation of the chosen plan.
2. A short list of the main implementation steps.
3. One-line summaries of all rejected plans and why each lost.
4. A clear note when the recommendation is still awaiting approval.

Use a bounded format, for example:

- maximum 2,500 characters;
- maximum 12 sentences;
- mixed paragraph and bullets.

For a blocked selection, run the same summarizer with:

- the blocker;
- all considered candidates;
- why none can meet the goal.

Route both successful and blocked paths through the summarizer.

Remove Autoplan’s root `presentationPrompt`. Otherwise it would create a second assistant response.

Preserve the full technical outputs in `AutoplanReady` and add:

```ts
plainSummary: {
  text: string;
}
```

### Where

- `src/builtins/autoplan.workflow.ts`
- `test/builtin-autoplan.test.ts`
- `docs/workflows.md`
- `skills/autoplan/SKILL.md`

### Verification

A real-Pi mock-provider test proves:

- Autoplan emits one plain assistant message;
- it does not call `workflow submit` for the summary node;
- the message includes the chosen plan;
- every explicit rejected plan is present;
- the detailed plan remains in durable SQLite run state;
- no long second presentation appears;
- a parent workflow continues after the summary settles.

---

## 10. Preserve behavior when Autoplan is included elsewhere

### Change

Check every current Autoplan composition:

- shared plan-change workflow;
- Autoimplement redesign;
- Monitor repair planning.

The summary will appear before documentation and human approval. Its wording must say “recommended plan” or “plan selected for approval,” not “approved plan.”

Human approval remains separate. The summary does not answer or bypass `humanDecision()`.

### Where

- `src/builtins/plan-change.workflow.ts`
- `src/builtins/autoimplement.workflow.ts`
- `src/builtins/monitor.workflow.ts`
- Related tests

### Verification

Tests prove:

- the summary appears before approval;
- Telegram and Pi still receive the actual human decision;
- the summary cannot satisfy that decision;
- approval, stop, replan, timeout, and skip routes remain unchanged;
- replanning emits one new summary for the new candidate set.

---

## 11. Update snapshots, rendering, and revisions

### Change

Show assistant-completion agents as ordinary agent nodes, with a small completion marker in piw and expanded details.

Do not add a node color or node type.

Update definition snapshots to include:

```json
{
  "nodeType": "agent",
  "expectedOutput": {
    "kind": "assistant-message",
    "maxChars": 2000
  }
}
```

Omit `maxChars` from the snapshot when the author did not set it.

Bump affected built-ins:

- `plain-summary`: revision 1;
- `autoplan`: revision 2;
- Autoimplement and Monitor revisions if their compiled mounted-source graphs change.

Use the alpha hard-cutover policy for unfinished runs whose definitions changed. Keep terminal SQLite runs readable.

### Where

- `src/workflows/store.ts`
- `src/render/`
- `src/viewer/`
- `src/extension/widget.ts`
- `src/builtins/catalog.ts`
- Snapshot and revision tests

### Verification

The widget and piw show the node as an agent and clearly state “assistant response.” Old terminal runs still render. Incompatible unfinished runs get clear restart guidance.

---

## 12. Full verification

Run focused tests first:

```bash
npx vitest run test/executor.test.ts
npx vitest run test/rpc-executor.test.ts test/rpc-executor-flow.test.ts
npx vitest run test/engine.test.ts test/store.test.ts
npx vitest run test/builtin-plain-summary.test.ts test/builtin-autoplan.test.ts
npx vitest run test/extension.test.ts test/step-message.test.ts
```

Then run all required repository gates:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

The real-Pi end-to-end test must verify the session transcript directly:

- one assistant-completion prompt;
- one normal assistant message;
- no summary `workflow submit` call;
- one following parent step;
- no duplicate summary after reload;
- no workflow notification containing the summary.

Run Pi Reviewer until no P0 or P1 findings remain, then verify CI.

---

## Compatibility and release

This is a compatible public capability addition to `agent()` and a new built-in workflow. At the current `0.12.1` baseline, the likely release is `0.13.0`.

Existing submitted-agent workflows remain valid. No legacy adapter or second agent implementation is added.

Autoplan’s structured proposal and selection outputs change in place. Its built-in revision must change, and unfinished older runs must restart.

Do not update OnurPi, install the release, or change another repository as part of this implementation unless separately authorized.

---

## Main risks

| Risk                                                   | Mitigation                                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate assistant response after a crash             | Bind prompt and response to run/node/attempt IDs and reconcile the session branch before redelivery.                                                                          |
| Parent advances before the assistant finishes          | Resolve assistant mode only from `agent_settled`.                                                                                                                             |
| Tool-only response completes the node                  | Require non-empty final visible text after tool activity settles.                                                                                                             |
| A workflow receives more text than it needs            | Set `maxChars` explicitly for that workflow. Keep the general API unlimited by default and do not retry an already visible response.                                          |
| Detached host produces an invisible assistant response | Park before the node and require the origin Pi session.                                                                                                                       |
| Summary bypasses human approval                        | Keep it as an agent output; human decisions remain protected checkpoints.                                                                                                     |
| “All plans” implies hidden reasoning                   | Include every explicit candidate record and never request hidden reasoning.                                                                                                   |
| Generic summary leaks source data into chat            | Document that callers choose the source and that the assistant response becomes normal session state.                                                                         |
| Extra model cost                                       | Autoplan replaces its existing final presentation turn, so standalone use should not add a second final model call. Included use intentionally adds one visible summary turn. |

## Contract impact

- **Session state:** one normal assistant message for each assistant-completion node.
- **Run state:** exact text, output mode, conversation range, recovery receipt, and the optional author-supplied character limit.
- **Other persistent data:** none beyond existing SQLite workflow state and Pi session entries.
- **Pi internals:** none.
- **Pi API:** existing documented message and lifecycle events only.
- **pi-workflows API:** additive `expectedOutput: assistantMessage()` mode for `agent()` and the new composable `plain-summary` workflow.
