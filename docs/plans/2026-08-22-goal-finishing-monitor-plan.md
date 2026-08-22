---
title: Make Monitor finish authorized goals
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-22
status: accepted
---

# Goal-finishing Monitor plan

## Goal

Change the built-in Monitor workflow so it finishes the user's authorized goal instead of only checking it.

A request such as "resume this work and monitor it" must resume the work, prove that useful work is moving, and then check it on schedule. Monitor continues until the full goal is complete or cannot continue safely.

The canonical behavior is specified in [Built-in monitor](../MONITOR.md).

## Boundaries

The implementation must:

- preserve the full goal and authority from `task`, `stopWhen`, repository instructions, and the conversation
- keep the first observation read-only
- use normal Pi tools for observations and actions
- keep only `task`, `stopWhen`, `everyMinutes`, and `maxChecks` as public inputs
- reject unknown input fields before run creation
- keep target processes and systems independent of Pi Workflows
- use the existing plan-change and Autoimplement workflows for real repairs
- keep normal starts, resumes, and restarts direct and small
- stop before an action exceeds authority, cost, provider, runtime, credential, or safety limits
- stop paid workers before repairing a shared code or data defect
- avoid compatibility aliases or shims for removed alpha inputs and routes

The work may change the Pi Workflows source, Monitor tests, the Monitor skill, and relevant documentation. It may run local checks and the non-destructive real-Pi end-to-end suite. It may commit and push the verified change directly to `origin/main`.

The work must not:

- add a target-specific Pi API, transport, schema, store, file, command, service, or dependency
- copy the planning, documentation, implementation, review, or delivery logic from existing workflows
- open a pull request
- deploy, publish an npm package, or create a release
- change OnurPi or another repository

## Selected design

### Strict input

Replace the Monitor input parser with strict validation for:

- `task`
- `stopWhen`
- `everyMinutes`
- `maxChecks`

Keep the full goal, scope, authority, constraints, and recovery contract in `task` instead of adding process-specific or provider-specific fields. Reject all other fields with a direct unsupported-field error.

### Read-only observation

Replace the current check result with a read-only observation result. Its route is one of:

- `wait`: Work is moving, or an external event must finish.
- `act`: The goal is incomplete and a safe authorized action is available.
- `stop`: The goal is complete or cannot continue safely.

The observation records goal state and target work state separately. It includes factual evidence, the safe actions already authorized by the user, optional progress, a stable target-state ID, and a concise report.

An `act` result also includes:

- action kind: `advance`, `recover`, or `repair`
- what is incomplete
- evidence that proves it
- the exact next action
- why existing authority covers it
- files, systems, and resources it may change
- how to verify it
- a stable failure ID

The observation cannot grant new authority.

### Direct action step

Add one mutation-capable agent step that uses normal Pi tools. It performs only the action stated by the observation.

Route `advance` and `recover` directly to this step. These actions cover normal starts, resumes, restarts, next commands, launch-file refreshes, safe retries, and verified checkpoint continuation. They do not run planning or documentation workflows.

The step returns a factual success, failure, or blocked result with verification evidence.

### Existing repair path

Route `repair` through the existing shared plan-change workflow and Autoimplement workflow. Pass the observed defect, evidence, repository, authority, constraints, and delivery boundaries into those workflows.

Do not copy or replace their design, documentation, approval, implementation, test, review, or delivery behavior.

Stop affected paid workers at safe boundaries before repairing a shared code or data defect.

### Immediate verification

Run a new read-only observation immediately after every direct action or completed repair. Do not schedule or sleep first.

The immediate observation must establish one of these states:

- the goal is complete
- useful work is moving
- the action failed in a new way
- the same failure returned
- a blocker exists

Only the `wait` route can publish the next schedule and enter the timer.

### Repeated failure guard

Store stable failure and target-state IDs in accepted outputs. After one repair completes, compare the next observation with prior repaired failures.

If the same failure ID and target-state ID return, stop. Do not run the same repair cycle again.

A failed direct action can produce a new `recover` action when the new observation proves that recovery is authorized. All loops remain bounded by accepted observations and the Monitor safety limit.

### Reports

Format every observation report with separate facts for:

- Monitor state
- goal state
- target work state
- factual progress when available
- last action or next action
- next check when scheduled

Never report target work as running only because Monitor is active.

### Workflow graph

```text
observe
  ├─ stop → finish
  ├─ wait → report → schedule → sleep → observe
  └─ act
       ├─ advance → direct action → observe immediately
       ├─ recover → direct action → observe immediately
       └─ repair → plan change → Autoimplement → observe immediately
```

The timer belongs only on the `wait` path.

## Implementation steps

1. Replace Monitor's public input parser with strict validation for `task`, `stopWhen`, `everyMinutes`, and `maxChecks` only.
2. Replace `continue`, `repair`, and `stop` observation routes with `wait`, `act`, and `stop`.
3. Add structured goal state, work state, evidence, progress, stable IDs, and complete action details to observation output validation.
4. Add the direct mutation-capable action step for `advance` and `recover`.
5. Keep the existing shared plan-change and Autoimplement includes for `repair`.
6. Route every action result directly back to read-only observation.
7. Route only `wait` through report, schedule, sleep, and the next observation.
8. Add the repeated repaired-failure guard using stable failure and target-state IDs.
9. Update report formatting so Monitor, goal, and target work states remain separate.
10. Update the Monitor skill and workflow documentation for the new graph and simple input contract.
11. Replace and extend Monitor tests for the new behavior.
12. Run all required checks, review the diff, commit, and push directly to `origin/main`.

## Tests

Add tests for these cases:

1. The goal is already complete.
2. Work is active, so Monitor waits.
3. Work is idle, so Monitor starts it.
4. Saved work exists, so Monitor resumes it.
5. An action succeeds, so Monitor observes again immediately.
6. An action fails once, then recovery succeeds.
7. The same repaired failure returns, so Monitor stops.
8. An action is outside authority, so Monitor stops.
9. A paid action exceeds the limit, so Monitor does not launch it.
10. Monitor is active while the target is idle.
11. The target completes between timed observations.
12. Unknown input fields fail clearly before run creation.
13. A normal restart does not trigger planning or documentation.
14. A real code defect uses the existing repair path.
15. No target-specific monitoring API is required.

Keep applicable existing tests for progress, reports, notifications, schedule updates, safety limits, cancellation, interruption, resume, and the widget.

## Verification

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
```

Review the full diff and fix each valid issue before delivery.

## Delivery

Commit the verified change with a Conventional Commit message and push it directly to `origin/main` without a pull request.

Do not deploy, publish, or create a release.
