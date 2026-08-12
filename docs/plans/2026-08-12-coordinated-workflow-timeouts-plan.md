---
title: Coordinate Workflow Timeouts With Pi Turns
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-12
status: implemented
---

# Coordinate Workflow Timeouts With Pi Turns

A workflow agent node can time out while its Pi turn keeps running. The model can then continue to use tools and submit output for an attempt that the workflow engine has already closed. A failed or timed-out monitor can also call its normal result presenter without a final output. This plan makes the workflow deadline own the corresponding Pi turn and gives monitor checks an explicit timeout.

## Requirements

- Stop the active Pi turn when its workflow agent node times out, is cancelled, parks, or loses its claim.
- Keep user Escape behavior separate. A user interrupt must still pause the workflow until `/workflow resume`.
- Reject late submissions after the pending attempt closes.
- Let workflow nodes derive a timeout from their input through a documented callback.
- Give the built-in monitor an optional `checkTimeoutMinutes` input with safe bounds and a useful default.
- Run normal result presentation only for completed runs and waiting checkpoints.
- Keep the workflow engine independent of Pi.
- Preserve existing run-bundle and workflow file formats.

## Scope

The workflow engine will expose agent-step aborts through its existing `AbortSignal`. The Pi extension will bind that signal to the Pi turn by calling the documented `ExtensionContext.abort()` method. It will record the attempt that requested the abort so the later `agent_end` event does not treat that abort as a user interrupt.

`WorkflowNodeCommon.timeoutMs` will accept a positive number or a callback that returns a positive number from the node context. The engine will resolve and validate that value before it dispatches the node. Existing numeric timeouts and the 15-minute engine default will continue to work.

The monitor will accept `checkTimeoutMinutes`. Its default will be the larger of 60 minutes and `everyMinutes`, with a maximum of 24 hours. The timeout will apply to check and report agent nodes. The shell wait keeps its current interval-specific timeout.

## Non-goals

- Do not change Pi internals.
- Do not add a persistent timeout registry or change the run-state schema.
- Do not make timed-out runs resumable.
- Do not remove safety deadlines from workflow nodes.
- Do not add compatibility code for submissions that omit `action: "submit"`.

## Implementation

1. Extend the conversation executor with an `onAbort` callback. Call it once when the engine abort signal closes a pending agent step. Pass the attempt contract and abort reason.
2. In the Pi extension, keep a short-lived in-memory marker for the system-aborted attempt. Call `ctx.abort()` only when Pi is still busy. Clear the marker after the matching aborted agent end or when no turn was active.
3. In `agent_end`, pause only for unmarked aborted turns. System aborts leave the engine's terminal or parked state in control.
4. Resolve node timeout callbacks before creating the timer. Validate that the result is a finite positive number. Abort timeout resolution after a short fixed deadline so a callback cannot block node dispatch forever.
5. Add and validate `checkTimeoutMinutes` in the monitor. Apply the derived timeout to `check`, `report_continue`, and `report_stop`.
6. Restrict normal result presentation to `completed` and `waiting` states. Terminal failures continue to use the existing deterministic notification with the persisted error.
7. Add tests for timeout-driven Pi abort, user Escape, late submissions, dynamic timeout validation, monitor timeout selection, and failed-run presentation.
8. Add a real Pi RPC regression test where a model turn exceeds a short workflow timeout. Confirm that Pi aborts the turn, the run times out, and later tool work does not occur.

## Acceptance criteria

- A timed-out workflow agent node aborts its active Pi turn exactly once.
- The timed-out attempt no longer accepts output.
- A system-triggered abort does not pause the workflow as a user interrupt.
- Escape continues to pause and `/workflow resume` continues the pending step.
- Monitor checks use `checkTimeoutMinutes`, or the documented default when it is absent.
- Failed, timed-out, and cancelled runs never call `presentationPrompt`.
- Completed and waiting runs keep their current presentation behavior.
- Existing workflow definitions with numeric or omitted timeouts continue to work.
- No Pi internal API or persistent schema changes.

## Verification

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
```

Also start Pi through the package in RPC mode and complete a `get_state` request. The real Pi end-to-end suite must exercise timeout-driven turn cancellation.
