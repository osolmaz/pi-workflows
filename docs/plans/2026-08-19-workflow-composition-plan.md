---
title: Add typed workflow composition and automatic repair
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-19
---

# Add typed workflow composition and automatic repair

pi-workflows needs reusable nested workflows with normal TypeScript imports. Monitor must be able to devise and implement a repair when mutation is authorized. Autoimplement must move back to solution design when new evidence invalidates its plan, correct failed reviewer commands, track P0, P1, and P2 findings, and use long CI waits for additional local testing.

The canonical behavior is in [Workflow composition](../WORKFLOW_COMPOSITION.md).

## Outcome

A workflow can run alone or as a typed child in one durable parent run. Authors can import a child definition, map its input, and route from named exits. Dynamic project, global, built-in, and path references remain available.

The package will ship `autoplan`, `autoimplement`, and `monitor` as compatible built-ins. Monitor will remain observation-only by default. An explicitly authorized monitor can run outer solution design, autoimplementation, internal redesign, and a fresh target check without copying workflow nodes.

## Scope

### Public workflow API

- Add generic workflow input and named-exit contracts.
- Add runtime input and exit validation.
- Add direct typed `includeWorkflow(child, options)` composition.
- Keep dynamic `includeWorkflow({ workflow, input })` references.
- Add `defineWorkflowRegistry()` for shipped typed definitions.
- Type-check child input mappers and parent exit names where the child is imported directly.

### Resolution and execution

- Resolve all direct and dynamic includes before `run_started`.
- Reject direct and indirect source cycles.
- Compile one qualified executable graph.
- Give child callbacks a local invocation view.
- Support repeated and nested mounts.
- Apply root and per-invocation step limits.
- Record named entry and exit transitions.
- Keep one pause, cancellation, checkpoint, update, notification, and presentation lifecycle.

### Persistence and display

- Record all child sources and their mount paths.
- Record a digest of the resolved definition.
- Refuse normal resume when any source or digest changes.
- Add mount data to the definition snapshot.
- Add include entry and exit trace events.
- Group qualified child nodes in viewers while preserving flat replay.

### Workflow library

- Make `autoplan` accept an existing plan and new evidence.
- Add `ready` and `blocked` exits to `autoplan`.
- Rebuild `autoimplement` around explicit issue routes.
- Include `autoplan` inside `autoimplement` for redesign.
- Track P0, P1, and P2 review findings by round.
- Rerun review only after P0 or P1 work.
- Permit P2 work without another reviewer round.
- Generate, validate, execute, and correct exact Pi Reviewer commands.
- Track PR comments, CI, merge, and final PR reporting.
- Bound one CI watch to five minutes.
- Route a long CI wait to useful local testing before checking CI again.
- Add authorized repair to monitor through outer `autoplan` and `autoimplement` mounts.
- Detect repeated repair with no changed issue, plan, implementation, evidence, or target state.

## Non-goals

- Do not change Pi core or use private Pi APIs.
- Do not create another run store, service, or child Pi session.
- Do not let a child jump into a parent or sibling node.
- Do not permit recursive include graphs.
- Do not add unrestricted model-selected node names.
- Do not let monitor mutate a target without explicit authorization.
- Do not replace Pi Reviewer with another reviewer after an invocation failure.
- Do not merge before required gates pass or an allowed unrelated failure is recorded.
- Do not rewrite existing terminal run bundles.

## Data contracts

### Child result

A completed child mount exposes a discriminated result:

```typescript
type IncludedResult<TExits> = {
  [K in keyof TExits]: { exit: K; output: TExits[K] };
}[keyof TExits];
```

### Source record

```typescript
type WorkflowMountedSource = {
  mountPath: string[];
  workflowName: string;
  source: WorkflowSource;
};
```

### Review round

```typescript
type ReviewRound = {
  command: StructuredCommand;
  p0: ReviewFinding[];
  p1: ReviewFinding[];
  p2: ReviewFinding[];
  lower: ReviewFinding[];
  invocationSucceeded: boolean;
};
```

P0 or P1 findings route to redesign or fix, then verification, push, and another review. P2-only work routes through a separate verification path and then continues to PR comments without another review.

### CI decision

```typescript
type CiDecision = {
  status: "green" | "failed" | "pending" | "unavailable";
  relatedFailures: string[];
  unrelatedFailures: string[];
  trackingCommand?: StructuredCommand;
};
```

A pending result must include a validated `gh` tracking command. The shell action stops after five minutes. A timeout routes to opportunistic local testing. The workflow checks CI again after that work.

## Implementation sequence

### 1. Typed contracts

- Make workflow definitions generic over input and exits.
- Add source identity, input parser, exit parser, and include declarations.
- Add direct and dynamic `includeWorkflow()` overloads.
- Add registry helpers and compile-time contract tests.
- Keep old workflow definitions valid.

### 2. Composition resolver

- Resolve nested direct and dynamic definitions.
- Preserve parent-relative paths.
- Build the complete source list.
- Reject source cycles with the mount chain.
- Validate child exit nodes and parent include edges.
- Compile qualified nodes and internal entry and exit transitions.
- Attach immutable composition metadata to the resolved definition.

### 3. Local execution context

- Project each child callback to its mount-local input, outputs, results, and steps.
- Hide parent and sibling data.
- Start each re-entry after the latest mount-entry step.
- Expose only the latest named child result to the parent.
- Enforce per-invocation and root step limits.
- Emit include entry and exit events.

### 4. Persistence and resume

- Add mounted sources and the resolved digest to state and manifest projections.
- Add mount metadata to definition snapshots.
- Compare the complete identity during resume and continuation.
- Keep old single-source bundles readable.
- Add trace reconstruction and torn-tail tests for include transitions.

### 5. Viewer grouping

- Derive groups from snapshot mount metadata.
- Keep qualified names in replay and details.
- Update TypeScript and Rust fixtures together.

### 6. Autoplan

- Move the current workflow into the built-in library.
- Add typed input, `ready`, and `blocked` exits.
- Accept a previous plan and new evidence.
- Calculate a plan digest.
- Return whether the selected plan changed.
- Keep the current practical, in-scope selection rule.

### 7. Autodoc and autoimplement

Add standalone autodoc and build this autoimplement graph:

```text
find existing plan
  -> missing or unclear -> blocked
  -> documentation current -> implement
  -> documentation missing or stale -> autodoc -> implement
  -> verify
  -> classify issue
     -> redesign -> autoplan -> autodoc -> optional approval -> implement
     -> fix -> verify
     -> publish -> write reviewer command -> run reviewer

review result
  -> command error -> rewrite command -> run reviewer
  -> P0/P1 -> classify issue
  -> P2 -> address P2 -> verify P2 -> PR comments
  -> clean -> PR comments

PR comments
  -> redesign
  -> fix
  -> CI

CI
  -> related design failure -> redesign
  -> related local failure -> fix
  -> pending -> track for at most five minutes
  -> tracking timeout -> run additional useful tests -> check CI
  -> green or allowed unrelated failure -> merge
  -> unavailable or forbidden -> blocked
```

The structured plan input is optional because the plan can already exist in conversation context or canonical documentation. Its absence never authorizes initial autoplan. Autoimplement blocks when no clear plan exists, skips autodoc for current documentation, and records every evidence-driven revision through autodoc before continuing.

The workflow will collect all review rounds in its final output. It will never rerun Pi Reviewer solely because P2 work changed files.

### 8. Monitor repair

- Add explicit repair authorization to monitor input.
- Add `repair` to the check result only when authorization is present.
- Mount outer `autoplan`, `autodoc`, optional `plan-approval`, and `autoimplement`.
- Pass the documented outer plan into autoimplement.
- Return exact replan instructions to autoplan and ask again.
- Check the target again after a reported repair.
- Stop on repeated no-progress evidence.
- Keep ordinary monitor calls observation-only and backward compatible.

### 9. Skills and docs

- Update workflow authoring, persistence, monitor, and controller-boundary docs.
- Align the public monitor and autoimplement skills with the new workflows.
- Run the normal agent synchronization command in the source repository after skill edits.
- Record any implementation departure in this plan and the canonical specification.

## Acceptance criteria

- Direct imports infer child input and named exits.
- Invalid direct input mappings fail type checking.
- Invalid child exit names fail type checking or definition validation.
- Dynamic references resolve through existing precedence rules.
- Two mounts of one child do not share invocation state.
- Standalone autodoc adopts current documents, updates stale documents, and blocks without a selected plan.
- Autoimplement finds a clear existing plan and never invokes initial autoplan because a plan input is absent.
- Nested redesign uses a fresh autoplan invocation and passes the revised plan through autodoc.
- Source cycles fail before the run bundle is created.
- Included checkpoints, updates, notifications, pause, cancellation, and resume behave like root nodes.
- Every mounted source and the resolved digest is durable.
- P0 and P1 work triggers another review round.
- P2-only work can be addressed without another review round.
- A failed reviewer command can be corrected and rerun without changing reviewer tools.
- A pending CI decision supplies an exact command.
- A CI wait longer than five minutes routes to useful local testing.
- Monitor mutates only when repair is explicitly authorized.
- A repaired monitor target is checked again.
- Repeated repair without changed evidence stops as blocked.
- Existing workflows and terminal run bundles remain valid.

## Verification

Run focused checks while implementing:

```bash
npx vitest run test/composition.test.ts test/graph.test.ts test/loader.test.ts
npx vitest run test/engine.test.ts test/run-resume.test.ts test/store.test.ts
npx vitest run test/builtin-autoplan.test.ts test/builtin-autoimplement.test.ts test/builtin-monitor.test.ts
```

Run all repository gates before review:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

Run Pi Reviewer against the pushed branch. Fix every P0 and P1 finding and rerun it. P2-only changes do not require another reviewer run unless they expose a new P0 or P1 concern. Check PR comments and CI after review passes.

## Release

This adds compatible public APIs to a pre-1.0 package. The planned version is `0.10.0`. Existing `0.9.x` run bundles remain readable, and no published version is rewritten.

## Implementation record

The implementation follows the canonical specification with one visible detail: compiled include entry and exit transitions have durable internal step records so resume can reconstruct the active invocation. They do not consume root or child `maxSteps` limits. Viewers label them as entry and named-exit transitions.

Direct imports check mapped input and exit names. `includedResult()` recovers the discriminated child result type from a parent output. Dynamic overrides carry a direct contract definition and must match its stable `contractId`, input presence, and named exits.

The shipped workflows are registered built-ins:

- `autoplan` returns `ready` or `blocked` with plan lineage.
- `autodoc` records selected plans as a standalone and included built-in.
- `autoimplement` finds an existing plan, conditionally documents it, and supports evidence-driven redesign, implementation fixes, exact reviewer and CI commands, P0 through P2 history, bounded CI watches, PR comments, merge, and final reporting.
- `monitor` remains observation-only by default and enables composed repair only through an explicit repair policy.

The package and Rust viewer version is `0.10.0`.

## Contract impact

- **Session state:** normal workflow messages and tool results only.
- **Other persistent data:** additive mount, source, digest, review, and CI evidence in existing run bundles.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension APIs only.
- **Public pi-workflows API:** generic input and exits, direct and dynamic `includeWorkflow()`, and `defineWorkflowRegistry()`.
