---
title: Verification validation and repair recovery
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-07
status: completed
---

# Verification validation and repair recovery

Never accept a verification plan that the verifier will immediately reject. Never start replacement
repair work until the previous turn has settled and its commands have a safe disposition. Keep the
engine small and make recovery explicit in the workflow graph.

## Scope

Implement, test, commit, push, review, and rebase-merge these corrections in pi-workflows against
`main`. Use Pi's public extension API only. Do not change Pi internals, install into active user
profiles, release a package, change live runs, or operate unrelated repositories or remote Jobs.
Use an isolated installed-package test and an authenticated low-cost live E2E. Keep the existing
schema identifiers; add no compatibility path or new persistence layer.

## Verification

Remove Autoimplement's separate command planner and its conversion that marks every command
read-only and base-eligible. Use the shared verification workflow's planner and `VerificationCheck`
format directly. Validate the same complete input before a planner submission is accepted and when
explicit checks are supplied. Invalid submissions keep the request and attempt pending for
correction through the existing tool. Keep untested checks visible in the final result.

Candidate-only checks remain valid. A base comparison must not contain candidate-bound arguments
or an absolute executable inside the candidate checkout.
The base runner must select a distinct checkout. Do not silently rewrite Docker mount paths or
classify a failure as unrelated without comparison evidence.

## Repair recovery

Use one named eight-hour timeout for implementation and semantic repair. Keep the engine default
unchanged. In the child workflow, route a successful repair to verification and failed or timed-out
repair to reconciliation. Intentional cancellation remains terminal.

Reconciliation is read-only for repository contents. The agent inspects the existing work, receipts,
and process sessions through a narrow, enforced tool allowlist. It cannot edit, start commands,
send process input, terminate processes, or start unrelated workflows. If a command still needs
termination, it reports the exact blocker. Its structured result must state the command disposition
and evidence. An uncertain or still-running command prevents another mutating attempt. Completed
edits go to verification without being repeated. Interrupted repairs count against the existing
repair bound; a timeout cannot reset that bound.

## Review correction: enforced tool restrictions

Pi Reviewer found that prompt instructions alone did not enforce read-only reconciliation. Add
an optional exact `allowedTools` field to agent nodes and existing step contracts, preserved by
composition and definition snapshots. The origin extension enforces it with public `tool_call`
before any tool executes, including during delayed delivery acknowledgment. Matching submit/update
calls remain allowed; ordinary chat has no workflow restriction. This is a tool allowlist, not an OS
sandbox. Do not grant shell access as if it were read-only.

Executors must declare that they enforce the restriction. Unsupported executors fail before model
execution. The current headless RPC executor is unsupported; restricted recovery requires an origin
Pi session. Do not add a second policy transport or silently run unrestricted headless recovery.

## Turn ownership

Use existing durable request, message, and workflow-turn records to derive which owned work must
stop. The regular model cannot react to a server timeout while it is blocked in a tool, so the
extension must receive these facts through the existing session view. No separate cancellation
store or transport is needed.

The coordinator matches only its owned turn, calls public `ctx.abort()` once for that turn, and
retains ownership until public `agent_settled` and the existing end report confirm settlement.
A delayed report must not trigger a second abort against later ordinary chat. Cancellation must
also work when a timeout races delivery acknowledgment. Never submit an expired result as success.

A runner handoff releases its durable claim before supervisor cleanup removes the cached active
worker. Cancellation in that interval uses the queue's unclaimed path, not the released token.
The queue still rejects a different live owner atomically. Test that interval directly rather than
retrying a failed E2E cancellation until it happens to pass.

Public Pi APIs are sufficient to abort and observe Pi turns, but cannot prove that every third-party
detached process stopped. Command inspection remains in the recovery agent and the tools that own
those commands. Unknown process state must block repair rather than manufacture a success receipt.

## Validation

Add unit and real-Pi lifecycle tests for invalid-plan correction, candidate/base separation,
candidate-only uncertainty, timeout recovery, exact-turn abort, lost acknowledgments, ordinary-chat
isolation, late submission rejection, and bounded repair attempts. Use short synthetic deadlines,
not an eight-hour test. Check that recovery cannot authorize mutation without command evidence.

Investigate the lease-renewal CI timeout without hiding it behind a larger arbitrary timeout. Reuse
recent timing fixes already on main. Correct the existing documentation convention failures and
update references. Run `npm run check`, `npm run test:e2e`, Slophammer DRY and dependency-boundary
checks, relevant Rust checks, and SimpleDoc. Then run a real-model installed E2E using an exact
low-cost provider/model. Push before `pi-reviewer --base main`, address P0/P1 findings, and inspect
CI only after review passes. Record final evidence and clean the task branch after merge.

## Completion evidence

Merged by rebase in [PR #86](https://github.com/osolmaz/pi-workflows/pull/86) on 2026-09-07.
The merged tree matches tested head `243de65ad05b7f25b090c35b5cf63ef99b84bb01`.
The task branch was removed. No active installation, live workflow, deployment, or remote Job
was changed.

The final local checks passed:

- `npm run check -- -- --maxWorkers=2`: 1,242 tests; 90.96% statement coverage and 85.57% branch coverage.
- `npm run test:e2e -- --maxWorkers=2`: 14 tests, including rejection of a real Pi recovery shell write.
- `npx slophammer-ts@latest dry .`: zero DRY candidates.
- `npx slophammer-ts@latest check . --only ts.dependency-boundaries-required`.
- `npx -y @simpledoc/simpledoc check`.
- `cargo fmt --manifest-path tui/Cargo.toml -- --check`.
- `CARGO_BUILD_JOBS=2 cargo test --manifest-path tui/Cargo.toml`: 76 tests.
- `CARGO_BUILD_JOBS=2 cargo clippy --manifest-path tui/Cargo.toml --all-targets -- -D warnings`.

The installed-package live test passed with:

```bash
npm run test:e2e:live -- --provider openrouter --model deepseek/deepseek-v4-flash --max-output-tokens 4096 --keep
```

It used Pi 0.85.0 and package 0.16.7 from the tested tree. Run
`20260907T144100451Z-live-model-e2e-8d09d91f` verified normal-chat handoff, exact delivery order,
intentional timeout, preserved partial output, stopped command, and restricted recovery. The
harness accepts an expected model abort only when the saved message belongs to the exact attempt
recorded as timed out. Other provider errors remain failures. Earlier probes that exposed harness
defects are not counted as successful validation.

Temporary files were retained for inspection, then removed with the guarded cleanup helper. The
credential audit found no credential matches in 17 generated operational files. Authentication was
used in place; it was not copied into a new store.

The final `pi-reviewer --base main` run had no findings. All four jobs in
[the final PR CI run](https://github.com/osolmaz/pi-workflows/actions/runs/34133462077) passed:
`check`, `e2e`, `installed-e2e`, and `tui`. No inline or issue comments required resolution.

Restricted recovery remains origin-session-only. The headless RPC executor rejects restricted
steps before model execution. A command whose settlement cannot be proved remains a blocker;
these changes do not claim to terminate arbitrary detached processes.
