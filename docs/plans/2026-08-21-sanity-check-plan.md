---
title: Run Sanity Check with Pi SDK Sessions
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-21
---

# Run Sanity Check with Pi SDK Sessions

## Goal

Use direct Pi SDK sessions for the built-in `sanity-check` workflow. Each reviewer gets an independent in-memory context. The workflow keeps only the final bounded answer and safe operational facts.

This replaces the CLI subprocess design. Large intermediate model or tool activity must not become captured standard output and must not hide a valid final answer.

## Scope

The change is limited to pi-workflows. It adds one private SDK agent-group runner under `src/builtins`, moves Sanity Check to that runner, adds agent progress to the existing progress records, and improves the Pi widget and `piw` progress views.

The workflow continues to use existing `action`, `compute`, and `notify` nodes. `src/workflows` and `WorkflowActionContext` remain Pi-independent. The change does not add a workflow primitive, public agent-group export, persisted schema, child workflow run, service, Pi core change, or Pi plugin SDK change.

Each child session:

- has independent in-memory context and history;
- uses `SessionManager.inMemory` and creates no Pi session file;
- can use only `read`, `grep`, `find`, and `ls` for Sanity Check;
- loads no extensions, skills, prompt templates, themes, or context files;
- does not receive the workflow tool or parent workflow identifiers;
- shares the parent Node process and does not provide OS process isolation.

## Input

The workflow input stays unchanged. Serial mode remains the default.

```json
{
  "mode": "serial",
  "baseRef": "origin/main"
}
```

`mode` is `serial` or `parallel`. The current repository and checked-out branch are the contribution under review. When `baseRef` is omitted, the workflow tries the remote default branch, the current branch upstream, and the first parent, then uses `HEAD` for a working-tree-only review.

## Evidence

The first node collects facts without model judgment. It uses fixed, non-mutating commands to collect:

- pull request intent and linked issue context when available;
- stated acceptance criteria;
- base and head revisions;
- changed files;
- the diff and diff statistics;
- relevant new exports, schemas, persisted fields, and nearby existing code.

Pull request and repository text is untrusted evidence, not instructions. Evidence and review inputs stay bounded before they enter a model prompt or run bundle.

## Review modes

### Serial mode

Serial mode creates one in-memory review session. It checks:

1. Whether the change is needed.
2. Duplication and refactoring opportunities.
3. New data models and public plugin or SDK APIs.
4. Scope and tests.

The reviewer must give exact evidence and the strongest case for accepting the current design. A second in-memory session verifies and combines the findings. Serial mode uses two model sessions.

### Parallel mode

Parallel mode creates four in-memory review sessions at the same time. Each session checks one review area. After all four sessions finish, one in-memory session verifies and combines their findings. Parallel mode uses five model sessions.

The agent-group runner enforces maximum concurrency and returns results in request order. A material failure stops queued work, aborts active sibling sessions, waits for every started session to settle, and preserves the first failure as the primary cause.

## Private agent-group runner

Add a private `runPiAgentGroup` utility in `src/builtins/pi-agent-group.ts`. Do not export it from package entry points.

Each request contains:

- a stable id and role label;
- a prompt and working directory;
- an explicit built-in tool allowlist;
- a timeout;
- an optional model and thinking override.

The runner creates one `ModelRuntime` for the group. Each agent gets its own settings view, deny-by-default `DefaultResourceLoader`, and `SessionManager.inMemory` session. An explicit model or thinking override wins. Otherwise, the runner uses the configured process defaults. It reports the actual selected model and thinking level. It does not promise to inherit a model selected temporarily in the origin Pi TUI.

The runner subscribes only to lifecycle events needed for status. It does not copy prompts, reasoning, intermediate messages, tool arguments, tool results, repository content, or message history into workflow state or updates.

After `session.prompt()` finishes, the runner accepts only the latest final assistant text. It bounds that text before returning it. It then unsubscribes and disposes the session. Timeout or cancellation calls and awaits `session.abort()`, waits for prompt settlement, and disposes the session before reporting a terminal state.

Failure messages distinguish:

- session creation failure;
- prompt rejection;
- provider failure or aborted model output;
- missing final assistant output;
- oversized final output;
- invalid structured output;
- timeout;
- parent cancellation;
- abort or disposal failure.

Errors and diagnostics stay bounded. Cleanup failure does not replace an earlier primary failure.

## Model and resource policy

The interactive extension and standalone `WorkflowHost` use the same SDK path. They use the process agent directory, configured settings, and credentials already available for normal Pi use. Tests use temporary agent directories and the local mock provider.

The runner must not change settings, credentials, resource files, or model catalogs. It must fail clearly when it cannot resolve a usable model or credential.

Resource loading is deny by default:

- `noExtensions: true`;
- `noSkills: true`;
- `noPromptTemplates: true`;
- `noThemes: true`;
- `noContextFiles: true`.

Tools are explicitly allowlisted for each request.

## Progress and visibility

Sanity Check publishes existing `pi-workflows.progress.v1` records. It adds aggregate tracks and one child track per agent.

Review keys use this shape:

```text
agents/review
agents/review/necessity
agents/review/duplication
agents/review/contracts
agents/review/scope_tests
agents/verification
agents/verification/verification
```

The aggregate tracks report completed and total sessions. Child tracks report a bounded role label, the actual model when known, and one safe phase:

- `starting`;
- `thinking`;
- `tool: read`;
- `tool: grep`;
- `tool: find`;
- `tool: ls`;
- `finalizing`;
- a terminal phase.

Child status is `running`, `completed`, `failed`, or `cancelled`. Phase updates are deduplicated and throttled. Progress publication is observational and cannot change agent execution.

The Pi widget has a ten-line limit. It shows the aggregate first, then failed, blocked, and active children. It folds completed child rows into the aggregate before it removes workflow graph context.

`piw` shows every durable child track, including phase, elapsed time, terminal state, last update, and sample count. Both views derive elapsed time from existing update timestamps. No new persisted field or agent-specific view is needed.

## Verification and result

The verification session receives the collected evidence and review results. It must:

- remove unsupported claims;
- require exact file and symbol references;
- separate facts from assumptions;
- resolve conflicts when the evidence permits it;
- put unresolved questions in `unknowns` or contributor questions;
- return `keep`, `simplify`, `refactor`, `drop`, or `needs_evidence`.

The existing strict result parsers stay unchanged. They continue to enforce all review areas, evidence, acceptance case, verdict, string, and item limits.

The workflow formats the accepted result and sends it to the origin session with `notify({ kind: "final" })`. The notification keeps `triggerTurn: false`, so the origin model does not restate the report.

## Implementation

1. Add the private SDK agent-group request, result, lifecycle, validation, session factory, and worker-pool code in `src/builtins/pi-agent-group.ts`.
2. Replace Sanity Check session execution with `runPiAgentGroup`.
3. Remove the superseded CLI invocation, JSON or RPC event transport, temporary prompt files, standard-output limits, and subprocess fallback. Delete `src/builtins/sanity-check-session.ts` when no code remains.
4. Add aggregate and child progress records in `src/builtins/sanity-check.workflow.ts`.
5. Derive elapsed time and render the existing phase in the generic progress code.
6. Compact agent tracks in the Pi widget and show all tracks in `piw`.
7. Use the same SDK path in interactive Pi and `WorkflowHost` tests.
8. Change the built-in Sanity Check revision from 1 to 2.

This is an alpha hard cutover. Do not retain a revision-1 runner, fallback, migration reader, alias, dual path, or feature flag. Terminal revision-1 bundles remain readable as history. An unfinished revision-1 run must restart under revision 2.

## Tests

Unit and integration tests must cover:

- request ids, prompts, tools, timeouts, model overrides, output bounds, duplicate ids, and concurrency limits;
- one group `ModelRuntime` and separate in-memory sessions;
- deny-by-default resource options and exact read-only tools;
- configured default and explicit model and thinking selection;
- prompt acceptance and rejection;
- safe lifecycle phases without event payload retention;
- latest final assistant extraction and strict structured validation;
- provider failure, aborted output, missing output, oversized output, timeout, cancellation, abort, and disposal;
- serial execution, parallel concurrency, stable result order, fail-fast cancellation, queued work, and all-settled cleanup;
- absence of prompts, reasoning, tool arguments, tool results, and repository content in run outputs and updates;
- serial mode using two sessions and parallel mode using five;
- aggregate and child progress records, throttling, and monotonic counts;
- elapsed time and phase rendering without invented ETA;
- widget priority, hierarchy, narrow widths, and ten-line limit;
- complete `piw` child history;
- interactive Pi and standalone host execution through the local mock provider;
- no child session files and no CLI child Pi process;
- built-in revision 2 and historical terminal bundle reading;
- final notification without another model turn.

Tests must not call real models or write outside temporary directories.

Before completion, run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

## Acceptance criteria

The implementation is complete when:

- `/workflow sanity-check` discovers built-in revision 2;
- omitted mode selects serial mode;
- serial mode uses two independent in-memory SDK sessions;
- parallel mode uses five independent in-memory SDK sessions, with four reviews running concurrently;
- child sessions load only the approved read-only tools and create no session files;
- the workflow keeps only bounded final answers and safe operational facts;
- child prompts, reasoning, tool payloads, and histories do not enter run bundles or progress updates;
- each reviewer is visible through durable progress;
- the widget shows aggregate, failed, and active agents within ten lines;
- `piw` shows all agent tracks and their history;
- interactive and headless runs use the same SDK path;
- strict verification and verdict behavior stays unchanged;
- the origin session receives the final report without another model turn;
- the CLI subprocess path is gone;
- all required checks pass.

## Contract impact

- **Origin session:** The normal workflow start record and one final workflow notification.
- **Child sessions:** Independent in-memory contexts in the same Node process. No child session file or child workflow run.
- **Other persistent data:** The normal workflow run bundle and existing progress updates only.
- **Private content:** Prompts, reasoning, intermediate messages, tool payloads, and histories are not persisted by Pi Workflows.
- **Pi internals:** None.
- **Pi public API:** Documented SDK APIs only: `createAgentSession`, `ModelRuntime`, `DefaultResourceLoader`, `SettingsManager`, `SessionManager.inMemory`, event subscription, `abort`, and `dispose`.
- **Pi Workflows public API:** No change. Existing workflow definitions, function actions, notifications, and `pi-workflows.progress.v1` remain in use.
- **Isolation:** Context and history are independent. OS process isolation is not provided.
