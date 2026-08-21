---
title: Add the Sanity Check Workflow
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-21
---

# Add the Sanity Check Workflow

## Goal

Add a built-in `sanity-check` workflow that reviews a pull request or local contribution before implementation, approval, or merge. The review checks whether the change is needed, duplicates existing code, should use a simpler design, adds unnecessary data models or public plugin APIs, or has scope and test problems.

The workflow runs its model work in temporary read-only Pi sessions. It does not put review prompts or model replies in the Pi session that started the workflow. The origin session receives the final report through a workflow notification that does not start another model turn.

## Scope

The change is limited to pi-workflows. It adds the built-in workflow, the smallest supporting code needed to run isolated read-only Pi sessions, workflow discovery and exports, documentation, unit tests, and real-Pi end-to-end coverage.

The workflow uses existing `action`, `compute`, and `notify` nodes. It does not add a workflow primitive, change a persisted schema, change Pi core, or change the Pi plugin SDK.

The child sessions can use only `read`, `grep`, `find`, and `ls`. They cannot edit files or run shell commands. They are temporary and do not write Pi session files.

## Input

The workflow accepts a review mode and the base reference needed to inspect the current change. Serial mode is the default.

```json
{
  "mode": "serial",
  "baseRef": "origin/main"
}
```

`mode` is `serial` or `parallel`. The current repository and checked-out branch are the contribution under review. Pull request intent, linked issue context, and acceptance criteria are collected when they are available. The workflow also supports a local contribution with no pull request metadata.

## Evidence

The first node collects facts without model judgment. It uses fixed, non-mutating commands to collect:

- the pull request description and linked issue context when available;
- stated acceptance criteria;
- the base and head revisions;
- changed files;
- the diff and diff statistics;
- relevant new exports, schemas, persisted fields, and nearby existing code.

Untrusted pull request and repository text is treated as evidence, not as workflow instructions. The evidence is bounded before it enters a model prompt or run bundle.

## Review modes

### Serial mode

Serial mode starts one temporary review session. That session checks all four areas in order:

1. Whether the change is needed.
2. Duplication and refactoring opportunities.
3. New data models and public plugin or SDK APIs.
4. Scope and tests.

The review session must give exact evidence and the strongest case for accepting the current design. A second temporary session verifies and combines the findings. Serial mode therefore uses two model sessions.

### Parallel mode

Parallel mode starts four temporary review sessions at the same time. Each session checks one area:

1. Whether the change is needed.
2. Duplication and refactoring opportunities.
3. New data models and public plugin or SDK APIs.
4. Scope and tests.

Each session must give exact evidence and the strongest case for accepting the current design. After all four sessions finish, one temporary session verifies and combines their findings. Parallel mode therefore uses five model sessions.

## Verification

The final session receives the collected evidence and all review results. It must:

- remove claims that the evidence does not support;
- require exact file and symbol references for repository claims;
- separate facts from assumptions;
- resolve conflicting findings when the evidence permits it;
- place unresolved questions in the final `unknowns` or contributor questions;
- return one of `keep`, `simplify`, `refactor`, `drop`, or `needs_evidence`.

There is no extra review loop. Missing product intent or unresolved evidence produces `needs_evidence` instead of an invented conclusion.

## Result

The accepted result contains a verdict, a short summary, findings with evidence, required changes, contributor questions, and unknowns. Findings cover necessity, duplication, data models, public APIs, scope, and tests.

The workflow formats the accepted result as a concise report and sends it to the origin session with `notify({ kind: "final" })`. The notification has `triggerTurn: false`, so the origin model does not restate the report.

## Implementation

Add a built-in definition named `sanity-check` and register it in the built-in catalog and exports. The graph has these stages:

```text
collect evidence
      |
run serial review or four parallel reviews
      |
verify and combine
      |
notify origin session
```

The review nodes are function actions. The isolated runner starts Pi in non-interactive JSON mode with no saved session, no discovered extensions or skills, and only the read-only tools:

```text
--mode json
--print
--no-session
--no-extensions
--no-skills
--tools read,grep,find,ls
```

Serial mode starts one combined review and then one verification session. Parallel mode starts the four focused reviews concurrently, waits for all of them, and then starts one verification session. Cancellation and timeout stop every affected child process. Output and error text are bounded.

The workflow validates its input and every model result. A missing child result, failed child process, malformed result, cancellation, or timeout fails the active action with a clear bounded error.

## Documentation

Add `sanity-check` to the built-in workflow list and document its input, review modes, read-only session boundary, result, and notification behavior in `docs/workflows.md`. Keep this plan as the record of the selected implementation.

## Tests

Unit tests must cover:

- input validation and the serial default;
- serial mode starting exactly one review session and one verification session;
- parallel mode starting exactly four concurrent review sessions and one verification session;
- the four required review areas;
- the acceptance case and evidence requirements in every review prompt;
- read-only child tool arguments and disabled session, extension, and skill discovery;
- structured result validation and all five verdicts;
- unsupported and conflicting finding handling in the verification prompt;
- bounded output and error handling;
- child failure, malformed output, timeout, cancellation, and process cleanup;
- final notification delivery without a model turn;
- built-in discovery and export behavior.

The real-Pi end-to-end test must use the repository test provider. It must not call a real model or make destructive changes.

Before completion, run all checks required by `AGENTS.md`:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

## Acceptance criteria

The implementation is complete when:

- `/workflow sanity-check` discovers and starts the built-in workflow;
- omitted mode selects serial mode;
- serial mode uses two temporary model sessions;
- parallel mode uses five temporary model sessions, with the four review sessions running concurrently;
- child sessions have only read-only repository tools and create no session files;
- both modes cover all required review questions and the case for accepting the design;
- final verification rejects unsupported claims and requires exact repository evidence;
- the final verdict is one of the five selected values;
- the origin session receives the report without another model turn;
- documentation and all required checks pass.

## Contract impact

- **Origin session:** The normal workflow start record and one final workflow notification.
- **Other persistent data:** The normal workflow run bundle only. Child Pi sessions are not saved.
- **Pi internals:** None.
- **Pi public API:** Existing documented CLI and extension behavior only.
- **Pi Workflows public API:** Existing workflow definitions and `action`, `compute`, and `notify` nodes only.
