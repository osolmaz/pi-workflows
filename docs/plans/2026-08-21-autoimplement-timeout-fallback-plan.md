---
title: Add Autoimplement timeout fallback
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-21
status: implemented
---

# Add Autoimplement timeout fallback

Autoimplement must not exit only because one of its agent nodes reached a time limit. It must start one fallback step that inspects the work already done and chooses the safest existing workflow stage to run next.

The `implement` node can take a long time. Increase its limit from 1 hour to 8 hours. Also add `timeoutMs: null` to the public workflow API so other workflows can explicitly disable a node's wall-clock timeout when that is the correct policy.

Keep this graph fallback separate from deferred successor turns. The fallback starts after the timed-out turn has ended. It does not queue, revive, extend, or continue that turn.

## Current behavior

The current built-in Autoimplement workflow has these limits:

- `implement`: 1 hour;
- `finalizeDelivery`: 30 minutes;
- omitted node timeout: the engine default of 15 minutes.

A node timeout is recorded as `timed_out`. The engine can route this outcome through `$result.outcome`, but Autoimplement does not use that route. A timeout therefore ends the complete run.

Two run bundles show the problem:

- `20260820T180206Z-autoimplement-2df27615` timed out in `implement` after 3,600,000 ms.
- `20260820T212618Z-autoimplement-06fcf309` timed out in `finalizeDelivery` after 1,800,000 ms.

The bundles contain the timeout evidence. The missing part is a workflow route that lets an agent inspect the current state and choose what to do next.

## Requirements

### Timeout policy

Extend `WorkflowNodeCommon.timeoutMs` to accept:

```typescript
number | null | ((context) => number | null | Promise<number | null>);
```

The values have these meanings:

- omitted: use the engine's 15-minute default;
- positive number: use that wall-clock deadline;
- `null`: do not apply a wall-clock deadline.

A callback that returns `null` has the same meaning as a fixed `null`. The existing 30-second limit for resolving a timeout callback still applies.

A null timeout disables only elapsed-time expiry. Cancellation, pause, park, claim loss, host shutdown, late-submission rejection, active-attempt cleanup, and the node's `AbortSignal` keep their current behavior.

Reject zero, negative numbers, `NaN`, infinity, strings, and other invalid values.

### Autoimplement limits

Set the built-in Autoimplement limits as follows:

- `implement`: `8 * 60 * 60_000`;
- `finalizeDelivery`: keep `30 * 60_000`;
- all other explicit node limits: unchanged;
- omitted node limits: keep the 15-minute engine default;
- `maxSteps`: keep 240.

The new null policy is a public capability. Autoimplement does not use null for `implement`; it uses the explicit 8-hour limit.

### Timeout fallback

Add one shared read-only fallback agent node to Autoimplement. Route supported agent-node `timed_out` outcomes to this node.

The fallback receives:

- the timed-out node ID, attempt ID, error, and prompt result record;
- the approved plan and current task scope;
- accepted outputs from earlier workflow steps;
- the previous fallback results in the current run.

The fallback must inspect:

- the current repository worktree, branch, diff, and commits;
- the remote branch and pull request, when they exist;
- current review and CI state when they affect the next route;
- merge and final-report state when delivery may already be complete.

The fallback itself does not edit files, run a mutation, commit, push, open or update a pull request, post a comment, or merge. It only chooses the next workflow stage.

Its bounded output must contain:

```json
{
  "route": "retry | verify | review | ci | deliver | replan | blocked",
  "reason": "why this is the safest next stage",
  "evidence": ["state inspected before choosing the route"]
}
```

The routes have these meanings:

- `retry`: run the timed-out stage again because inspection shows that its work is incomplete;
- `verify`: continue at the required verification stage because implementation work is ready;
- `review`: continue at review because publication is complete for the current head;
- `ci`: inspect CI because review is complete and CI is the next open stage;
- `deliver`: run `finalizeDelivery` because delivery is the next open stage or its outcome is uncertain;
- `replan`: enter the existing `redesign` Autoplan include because current evidence invalidates the approved plan;
- `blocked`: stop because no safe route is available within the approved scope.

Validate routes against the timed-out source. The fallback must not skip required implementation, verification, review, CI, authorization, or delivery checks.

### Graph routing

Use the existing `$result.outcome` interface. For each supported Autoimplement agent node:

- `ok` follows its current success route;
- `timed_out` routes to the shared fallback;
- `failed` keeps normal failure behavior;
- `cancelled` remains terminal and never enters fallback.

The engine checks cancellation before outcome routing, so user cancellation stays immediate.

A workflow node can have only one outgoing edge. When a successful node currently routes on its output, add a small pure compute router after the `ok` outcome. Keep compute nodes free of external effects.

If an outcome switch needs an explicit `failed` case, route it to a pure failure node that throws the original persisted error. Do not turn ordinary failures into fallback events.

### Bounded fallback

Allow at most three fallback executions in one Autoimplement run. Count them from the durable step records, independently of `maxSteps`.

After the third fallback, a later supported timeout must finish with the normal blocked result and include the timeout history. Do not run a fourth fallback.

If the fallback node itself fails or times out, stop the run. Do not route the fallback back to itself.

### Repeat only missing work

A fallback can send the workflow back to a stage whose earlier attempt may have completed some effects. Consequential nodes must inspect their current state before they act again.

At minimum:

- implementation and fix steps inspect the current diff and commits before changing files;
- `publish` checks whether the head is already pushed and whether the matching pull request already exists;
- review reuses accepted review evidence only when it still matches the current head;
- `finalizeDelivery` checks whether the expected head is already merged and whether the final report already exists.

A repeated node performs only missing work. It must not create a duplicate commit, push, pull request, review, merge, or final report.

## Implementation

1. Update `src/workflows/types.ts` so fixed and computed node timeouts can be `null`.
2. Update `src/workflows/schema.ts` to accept null and reject other invalid timeout values.
3. Update `src/workflows/engine.ts` so a null timeout does not create an elapsed-time timer. Keep all abort and cleanup paths active.
4. Update `src/workflows/store.ts` and `WorkflowNodeSnapshot` so a fixed null is written as `"timeoutMs": null`. Continue to omit timeout callbacks from snapshots.
5. Set `implement.timeoutMs` to `8 * 60 * 60_000` in `src/builtins/autoimplement.workflow.ts`.
6. Add the fallback output parser, fallback count guard, read-only fallback agent, deterministic route helpers, and terminal limit result to Autoimplement.
7. Route supported `timed_out` outcomes to the fallback. Preserve success, failure, and cancellation behavior.
8. Update consequential-node prompts so repeated attempts inspect state and perform only missing work.
9. Increment the built-in Autoimplement revision from 5 to 6 in `src/builtins/catalog.ts`.
10. Update `docs/workflows.md` and `docs/SQLITE_STATE.md` when implementation ships so public documentation matches the code.

## Alpha cutover

Keep these identifiers unchanged:

- `pi-workflows.autoimplement.v1`;
- `pi-workflows.definition-snapshot.v1`;
- existing run-state, trace, and run-bundle v1 identifiers.

Change their alpha contracts in place. Do not add a v2 schema, compatibility reader, migration, alias, dual route, or feature flag.

Autoimplement revision 6 replaces revision 5. A revision-5 or older run must refuse resume through the existing source-change check. Reload or restart Pi to load the new built-in revision.

## Tests

Add tests for:

- fixed `timeoutMs: null`;
- a timeout callback that returns null;
- omitted and numeric timeout behavior remaining unchanged;
- invalid timeout values;
- a null-timeout node completing after a short test default would have expired;
- immediate cancellation of a null-timeout node;
- fixed null in definition snapshots and callback omission;
- Autoimplement's 8-hour `implement` limit and unchanged other limits;
- successful routes remaining unchanged;
- supported timeouts entering the fallback;
- failed nodes keeping normal failure behavior;
- cancellation bypassing fallback;
- retry, verify, review, CI, delivery, replan, and blocked fallback routes;
- rejection of a route that would skip a required stage;
- the three-fallback limit;
- fallback failure and timeout stopping without recursion;
- no duplicate push, pull request, merge, or final report after a repeated stage;
- revision 6 discovery and refusal to resume revision 5;
- non-destructive real-Pi execution through the installed package path.

Tests must use temporary directories and fake commands. They must not call a real model, mutate a real pull request, or write outside their temporary roots.

## Acceptance criteria

- Autoimplement `implement` can run for up to 8 hours.
- Workflows can explicitly choose no wall-clock node deadline with `timeoutMs: null`.
- A supported Autoimplement timeout starts the shared fallback instead of ending the run immediately.
- The fallback inspects current state and chooses an existing safe stage without mutation.
- Cancellation remains immediate and terminal.
- Ordinary failures keep their current terminal behavior.
- No run executes the fallback more than three times.
- Repeated stages perform only missing work.
- Deferred successor-turn behavior is unchanged and remains a separate design.
- Autoimplement revision 6 is a hard alpha replacement for revision 5.
- Documentation and tests match the shipped behavior.

## Verification

Run these checks before completion:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

Review the final diff to confirm that it preserves unrelated work on the current branch and does not mix deferred successor turns into timeout fallback.

## Boundaries

- Do not implement deferred successor turns as part of this work.
- Do not queue, revive, or extend a timed-out turn.
- Do not change Pi core or use undocumented Pi APIs.
- Do not add a service, controller, daemon, timeout registry, effect database, or new persistence location.
- Do not change external repository policy, CI configuration, provider APIs, or credentials.
- Do not recover explicit cancellation.
- Do not remove bounded limits from Autoimplement nodes.
- Do not preserve compatibility with older alpha workflow revisions.

## Contract impact

- **Session state:** normal workflow messages, fallback prompts, and tool results only.
- **Other persistent data:** fixed null timeout values and normal fallback node outputs in existing v1 run bundles.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension APIs only.
- **Public pi-workflows API:** `timeoutMs` gains explicit null support; existing agent, compute, and `$result.outcome` routing remain in use.
