---
title: Add reusable workflow control loops
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-11
---

# Add reusable workflow control loops

Autoimplement needs one central decision point that can send work into custom branches and receive control again. A recoverable failure or timeout should lead to another decision in the same run instead of ending the run or starting over.

[Control loops](../CONTROL_LOOPS.md) is the canonical explanation and specification. It defines the terms, public authoring API, branch rules, failure behavior, safety rules, diagrams, examples, visualization, compatibility, and general test requirements. This plan contains only the work needed to implement that specification and apply it to Autoimplement and Monitor.

Related implementation history is in [Add Autoimplement timeout fallback](2026-08-21-autoimplement-timeout-fallback-plan.md) and [Confirm blockers before autoimplement stops](2026-08-20-autoimplement-blocker-challenge-plan.md).

## Problem

Autoimplement sends successful work directly from one stage to the next. Separate nodes handle timeout recovery and blocker claims. The decision about what happens next is therefore spread across the graph.

The verification incident exposed a missing route. `localVerification/planChecks` timed out before its included workflow reached `ready` or `blocked`. The parent never received a child result, and the complete run ended before its timeout fallback could inspect the state.

The same run also exposed avoidable correction delays and incorrect restart text:

- the planning prompt omitted rules enforced by the command validator;
- validation returned independent errors one at a time;
- the 15-minute active-time limit expired during correction attempts;
- the final late submission reported only a revision conflict;
- restart created a child run while the model-visible result named the parent.

## Selected change

Add the public `controlLoop()` authoring helper specified in [Control loops](../CONTROL_LOOPS.md). It produces ordinary route and return edges from a typed definition and adds no runtime node type.

Use the helper in Monitor without changing Monitor's behavior. Refactor Autoimplement around one `decide` agent and remove the separate timeout fallback, blocker challenge, and cross-stage route selectors that it replaces.

Keep the existing workflow engine, node outcomes, included workflows, named exits, durable state, revision fencing, effect receipts, and cancellation behavior.

## Scope

Change these areas:

- the public workflow authoring exports under `src/workflows`;
- graph validation needed by the helper;
- the built-in Monitor definition;
- the built-in Autoimplement definition;
- the internal change-verification workflow;
- server conflict text for a proven request timeout;
- extension restart result text and details;
- built-in revisions and fixtures;
- focused tests, built-in skill guidance, and workflow documentation.

## Non-goals

- Do not add a workflow node type.
- Do not add parent-side handling for arbitrary child programming errors.
- Do not add hidden retries, dynamic routes, or generated commands.
- Do not add a controller-specific database, event schema, service, or resource.
- Do not change Pi core or use private Pi APIs.
- Do not change ACPX, ClawSweeper, Harbor HF, or another repository.
- Do not catch cancellation and return it to the controller.
- Do not keep the replaced Autoimplement fallback paths.
- Do not add compatibility aliases, readers, dual paths, or a new schema version.

## Implementation

### Public authoring helper

Add `src/workflows/control-loop.ts`.

Implement the `controlLoop()` input, output, and definition checks from [Control loops](../CONTROL_LOOPS.md). Preserve literal route and reference types so TypeScript can check route targets and named child exits in the surrounding workflow definition.

Return only ordinary `WorkflowEdge` values and the inferred route choices. Do not add runtime behavior or hidden definition metadata.

Export the helper and its public TypeScript types from `src/workflows/index.ts` and the package entry points that already expose `decision()` and `decisionEdge()`.

Add focused tests in `test/control-loop.test.ts`. Cover valid expansion, literal inference, ordinary node returns, child-exit returns, terminal routes, invalid names, empty routes, missing returns, duplicate returns, and attempts to continue through cancellation.

### Graph checks

Extend the existing definition checks only where `controlLoop()` cannot enforce a rule while it builds edges.

Check the expanded graph, not a second private graph model. A declared branch must reach one of its return points or a declared terminal target on every expected successful path. Agent and action failures and timeouts that the branch treats as recoverable must have explicit outcome routes. Cancellation must remain terminal.

Keep unexpected parser errors, unknown routes, invariant failures, and malformed definitions as run failures. Do not turn them into controller decisions.

Add focused coverage to `test/graph.test.ts`, `test/workflow-graph.test.ts`, and composition tests where included workflows are involved.

### Monitor adoption

Replace Monitor's handwritten decision and return edges with `controlLoop()` output in `src/builtins/monitor.workflow.ts`.

Keep its existing `observe -> decide -> act -> observe` behavior. Preserve all stop, wait, advance, recover, repair, cost, authority, progress, scheduling, and maximum-check rules.

Update `test/builtin-monitor.test.ts` to compare the expanded routes and runtime behavior. Raise the built-in Monitor revision because its snapshotted source changes.

### Autoimplement controller

Add one bounded, read-only `decide` agent to `src/builtins/autoimplement.workflow.ts`. Add an observation compute node that prepares current accepted facts before each decision.

The controller uses the Autoimplement routes listed in [Control loops](../CONTROL_LOOPS.md). Each route enters an existing node or included workflow. Each expected non-cancelled branch result returns to observation.

Add a workflow-specific decision parser. It must enforce:

- current evidence for forward routes;
- authority for mutating routes;
- settlement evidence before a possible side effect is repeated;
- current verification, review, CI, and delivery evidence before completion;
- evidence and checked alternatives before blocked;
- existing retry limits and useful progress before repeating a route.

A rejected decision stays pending on the same exact request and attempt. The validation response must report all independent correctable errors within existing output bounds.

Remove the old cross-stage recovery system after the controller passes equivalent tests:

- `timeoutFallbackGuard`, `timeoutFallback`, and `routeTimeoutFallback`;
- `createBlockerClaim`, `routeBlockerClaim`, `challengeBlockerGuard`, `challengeBlocker`, and `routeChallenge`;
- route nodes whose only remaining job is now owned by the controller.

Retain local compute nodes that normalize evidence or enforce one deterministic branch rule. They return branch results instead of selecting unrelated later stages.

### Autoimplement branches

Rewire each branch as one bounded unit:

- plan discovery returns its found or blocked evidence;
- workspace preparation returns either named child exit;
- documentation and redesign return their named child exits;
- implementation and repair return accepted output, failure, or timeout evidence;
- verification returns either named child exit;
- publication returns current local and remote state;
- review returns current command, finding, and head evidence;
- comment inspection returns current feedback evidence;
- CI returns current check, wait, command, and failure evidence;
- delivery returns current default-branch or pull-request delivery evidence.

Each agent or action that handles operational failure routes `ok`, `failed`, and `timed_out` explicitly. Leave `cancelled` without a continuation route.

### Verification planning

Update `src/builtins/change-verification.workflow.ts` so every expected `planChecks` outcome reaches a named child exit.

A valid plan continues to candidate checks. A failed or timed-out planning turn returns `blocked` with its exact request, attempt, outcome, and error evidence. Cancellation stays terminal. No verification command starts from an invalid or incomplete plan.

Route both `localVerification.ready` and `localVerification.blocked` back to Autoimplement observation. The controller then chooses retry, repair, redesign, a later stage, or blocked.

Retain the incident fixes from the earlier plan:

- allow exact known checks through `verificationChecks`;
- add explicit untested items when supplied checks cannot cover remote work;
- derive the planning prompt and command validator from the same safety facts;
- collect independent plan errors into one bounded response;
- set a 30-minute active-time limit for verification planning.

Add focused tests for the original two validation errors in one response, correction on the same request, no command execution before acceptance, supplied checks, explicit untested checks, and the planner fallback.

### Timeout conflict text

Use immutable timeout events in the existing server state owner to identify a late submission for the exact expired request.

Check for an already accepted idempotent submission first. Report that the request expired only when durable evidence proves that timeout cancelled it. Keep every unrelated revision conflict unchanged. Do not reopen or mutate the request.

Add focused server tests for timeout winning, submission winning, accepted retry adoption, unrelated cancellation, and stale output rejection.

### Restart result

Build the extension's restart result from the accepted server receipt.

Return the new child as `runId`, the terminal source as `parentRunId`, and the saved `restartNumber`. Tell the model to inspect the child. Do not state that the terminal parent restarted.

Keep restart as terminal-run recovery. Autoimplement branch recovery remains inside the active control loop.

Add extension tests for visible text, structured details, parent state, child state, and status calls that use the returned child ID.

### Built-in identity

Raise the Autoimplement and Monitor revisions in `src/builtins/catalog.ts` and `src/builtins/metadata.ts`. Update affected definition snapshots and fixtures.

Apply the alpha hard cut. New runs use the new graph. Existing snapshotted runs keep their saved definitions. Add no migration or compatibility reader.

### Documentation

Keep [Control loops](../CONTROL_LOOPS.md) as the single source for the general model and API.

When implementation ships:

- change its status from planned to current;
- update examples to match the final exported TypeScript names;
- update `docs/WORKFLOWS.md` with links and built-in behavior;
- update `docs/WORKFLOW_COMPOSITION.md` with child branch requirements;
- update Autoimplement and Monitor skill guidance where input or recovery behavior changes;
- keep implementation history and test commands in this dated plan.

Do not copy the full control-loop explanation or API specification into the dated plan or built-in skill files.

## Verification

Run focused tests while implementing:

```bash
npx vitest run test/control-loop.test.ts test/decision.test.ts test/graph.test.ts test/workflow-graph.test.ts test/composition.test.ts
npx vitest run test/builtin-monitor.test.ts test/builtin-autoimplement.test.ts test/change-verification.test.ts
npx vitest run test/server-interaction.test.ts test/extension.test.ts
```

Use the exact current test filenames if the server interaction coverage is split across more focused files.

After focused tests pass, run the required repository checks:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

Then run one real-model live end-to-end check with an authenticated low-cost provider and exact model ID. Force one recoverable branch failure or timeout. The transcript must show a return to `decide`, selection of a safe earlier branch, successful continuation in the same run, and no restart.

Keep remote-only work untested unless current remote evidence exists.

## Acceptance criteria

- Pi Workflows exports the helper and types specified in `docs/CONTROL_LOOPS.md`.
- The helper produces existing edge definitions and no runtime node type.
- Monitor and Autoimplement use the same helper without workflow-specific code inside it.
- Autoimplement has one controller for cross-stage choices.
- Every expected non-cancelled branch outcome returns to observation or a declared terminal result.
- `localVerification/planChecks` cannot end Autoimplement through an unhandled expected failure or timeout.
- The controller can move to an earlier branch when current evidence requires it.
- Completion and blocked routes pass deterministic workflow-specific checks.
- Cancellation remains immediate and terminal.
- Uncertain effects are observed or adopted before retry.
- Repeated work without observed progress stops within existing bounds.
- Verification planning returns complete correction information and has enough bounded active time.
- The restart result names the new child and terminal parent.
- Existing run data needs no migration or compatibility path.
- Timeless and dated documentation have no duplicated specification sections.

## Contract impact

- **Session state:** normal controller prompts, decisions, branch results, summaries, and workflow tool results.
- **Other persistent data:** normal snapshots, step results, events, and effect receipts in existing schemas.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension APIs only.
- **Public pi-workflows API:** the new `controlLoop()` authoring helper and its literal-preserving TypeScript definitions. Existing node, edge, include, exit, and run formats stay in place.
