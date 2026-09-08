---
title: Restore workflow recovery turns and submission reminders
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-08
status: planned
---

# Restore workflow recovery turns and submission reminders

## Purpose

When a workflow ends or fails, the regular Pi model must check whether the user's task is actually finished and fix what remains within existing permission. If it forgets to submit a required result, remind it a limited number of times. Preserve completed work, avoid endless retries, and ask the user when safe continuation is not possible. When the user says stop, stop.

The user explicitly identified both behaviors as part of the design and required rules against removing them again. A finished workflow does not necessarily mean a finished user task. A workflow is a tool the regular model uses; it does not replace the model's responsibility for the task.

This plan implements [Required recovery behavior](DESIGN_PHILOSOPHY.md#required-recovery-behavior). It records the agreed direction and the decisions still needed before implementation. No runtime restoration has shipped through this documentation change.

## Required behavior

1. **Post-workflow model turn.** Let the model explain the result, inspect failures, correct mistakes, and continue or restart within existing permission. Explicit user cancellation must stop automatic continuation.
2. **Missing-submission reminders.** Give the model a bounded chance to submit the required result instead of leaving the workflow waiting silently.

Automatic recovery after failure is an explicit part of the first requirement. A final explanation is another purpose of that same turn, not a third mechanism. Workflow-specific summary and repair nodes do not replace the general session handoff.

Refactors must preserve these behaviors. General approval to simplify architecture, reduce model calls, make execution explicit, or replace alpha contracts does not authorize their removal. Removing, disabling, or narrowing them requires explicit user approval for that specific change.

## Scope and authority

This task saves the plan and corrects conflicting documentation in pi-workflows. It authorizes documentation validation, commit, and push only. It does not authorize implementation, live model calls, paid work, release, installation into active user profiles, live-run changes, database resets, or changes to other repositories.

A later implementation should cover the existing host, message and request stores, Pi delivery coordinator, renderers, restart admission, follow-up ordering, recording, and tests. Keep the current exact-request checks, accepted receipts, source verification, worker ownership, active-time accounting, and interruption-recovery fixes.

Do not introduce a second coordinator, separate recovery agent, new service, new database, parallel API version, embedded executor, or polling loop. Do not copy recovery nodes into every workflow. Do not change Pi core, private Pi APIs, or Pi session schemas. Existing workflow-specific repair steps remain useful and must not be removed merely because general recovery returns.

## What happened

- The [September 2 restoration plan](2026-09-02-unify-workflow-messages-plan.md) explicitly required terminal recovery turns, missing-submission reminders, and safe restart opportunities.
- [PR #77](https://github.com/osolmaz/pi-workflows/pull/77), including commit `9056960`, restored those behaviors.
- [PR #84](https://github.com/osolmaz/pi-workflows/pull/84), including commit `356720c`, removed terminal-triggered turns and reminders under the September 6 explicit-model-work rule. It retained narrower summaries and restart APIs.
- The [September 7 handoff](2026-09-07-workflow-handoff-plan.md) and [verification recovery](2026-09-07-verification-recovery-plan.md) changes fixed specific failures. They did not restore the general post-workflow turn or submission reminders.
- The user reaffirmed both requirements on September 8. They now appear in the design principles and repository instructions.

Inspect the old implementations and tests to recover intended behavior and edge cases. Do not revert PR #84 or copy its predecessor wholesale: that would undo later request, ownership, cancellation, source, and receipt fixes. The old two-reminder and three-restart limits are historical behavior, not automatically approved policy for this restoration.

## Selected design

Use one explicit, bounded session recovery policy on the existing host-owned workflow message path. The host decides eligibility and commits durable transitions. The existing `WorkflowMessageCoordinator` delivers through public Pi APIs. The regular Pi model makes decisions that require judgment.

Workflow execution and session recovery are separate facts. A terminal run stays terminal while its result is explained or recovered from. A reporting failure cannot reverse execution, erase accepted work, or block cancellation. If more workflow execution is needed, use the appropriate existing command with a checked causal link to the original task.

### Post-workflow handoff

Reuse the existing `terminal` message kind and recorded outcome rather than creating another sender or prompt channel. Eligible completed, failed, and timed-out interactive runs must provide a model turn. Explicitly cancelled work gets a passive cancellation notice and no automatic recovery turn. Session closure, pause, and server restart are not user cancellation or terminal execution.

The model-facing message must provide the original task, recorded outcome, relevant accepted results, failure evidence, existing authority and constraints, prior recovery attempts, and valid next actions. Treat saved output as quoted data, not instructions. Keep full results accessible through existing verified content retrieval when needed; do not substitute an arbitrary truncated result for the evidence.

The model first determines whether the user's task is finished. It can explain success, inspect a failure, correct an existing request, continue authorized work, propose a safe fresh run, or report a blocker. It must not restart successful work merely because a summary failed. Failed invocations rejected before a run exists remain ordinary tool errors that the current model turn can correct; do not manufacture a failed run solely to obtain recovery.

An automatic handoff is due once for its exact terminal outcome. Reconnect and lost acknowledgments adopt the existing message and turn evidence before sending or acting again. A completed handoff is not replayed because history was opened or a process restarted. Do not claim exactly-once model execution where Pi cannot establish it.

### Submission reminders

Use the existing `step` message kind with a reminder reason. Keep the exact durable request, node visit, and attempt; a reminder does not create a new workflow run or restart the step's work.

Evaluate reminder eligibility only after the public Pi settled boundary and reconciliation of the request's accepted or validating response. If a submission is still validating, wait for its durable outcome. If it was accepted, do nothing. If rejected, preserve the error so the model can correct it. If the request is still pending with no usable submission, issue a bounded reminder with the exact request ID and expected output form.

Do not overlap active model work, a user message already waiting in Pi, or another reminder for that request. Pause, cancellation, request replacement, and acceptance invalidate pending reminders. Protected human decisions must never receive model-submission reminders. An aborted step keeps the existing pause behavior rather than immediately prompting again.

After the limit, report a clear blocker and follow the request's declared failure routing. Do not leave an unexplained pending request or silently start a fresh run. An explicit human resume may authorize another bounded opportunity, but automatic retries and reconnect must not reset the count.

### Safe recovery and restart admission

Correct the same pending request where possible. Preserve accepted output and durable side-effect evidence. A fresh restart begins at the start with the original input and definition; it does not inherit step results or approvals. Do not describe it as partial resume.

Use a new start with corrected input only when the current commands cannot express the needed correction and existing permission covers the work. Bind every automatic recovery launch, including a corrected `start`, to its source terminal turn and original recovery chain. A change of workflow name or command must not bypass the recovery budget.

Host admission must check the exact source outcome, current owned turn, execution revision where required, cancellation, unsettled effects, and available recovery budget. The model must also check the user's scope and action permission. An ownership token or recovery opportunity does not grant authority for spending, merge, release, deployment, or a different repository.

If command or external-effect outcome is uncertain, inspect it through the responsible tools and existing receipts before retrying. Unknown state is a blocker, not evidence that nothing happened. Do not copy an approval to a changed proposal or repeat paid or destructive work on the strength of a prompt alone.

Repeated failure without new usable evidence must stop. Show what succeeded, what remains, and the exact decision or permission needed. A failure in recovery itself must produce a visible bounded outcome, not an endless sequence of terminal turns.

### Cancellation and ordering

Explicit user cancellation wins over pending reminders, scheduled recovery, and automatic recovery launches for that chain. This must remain true after reconnect or server restart. A later explicit user request can authorize new work; ordinary replay cannot.

If a terminal execution result has already released its run reservation, the user's stop action must still be able to stop that run's active recovery turn. Reuse the public `ctx.abort()` and existing owned-turn cancellation path. Abort only the exact owned turn and retain ownership until settlement; do not abort unrelated later chat. Do not interpret a workflow timeout as an explicit user stop.

Deliver only when Pi is idle and has no pending input. User input takes precedence over an unsent automatic message; recheck eligibility after that input settles. Do not silently classify every ordinary chat message as workflow work. Any supersession or cancellation must have explicit request or turn evidence.

A queued follow-up waits for its successful source outcome and settlement of the source's terminal recovery handoff. If recovery starts another workflow, that run's session reservation blocks the next follow-up. Retain existing source ownership; do not silently move a failed source's cancelled follow-ups to another run. Test an interrupted or blocked handoff so it cannot release follow-ups early or leave them silently stuck.

### Durable state and public API boundary

Use existing run outcomes and ancestry, exact requests, message identities, turn reports, command receipts, and the content store. Settle turn completion, reminder eligibility, budget consumption, and required outgoing work through narrow host-owned transitions. Repeated reports must adopt the same transition instead of incrementing counters twice.

First prove which policy and causal facts can be read from those records. If one is absent, add only the necessary durable metadata to the existing owner and its checked transition. Do not create another state store or mirror Pi's session history. Review the data model before adding fields. Keep version identifiers in place under the repository's alpha policy, and never reset live state as part of implementation or testing.

The documented Pi APIs are sufficient: `sendMessage`, `registerMessageRenderer`, session and branch events, `agent_start`, `agent_end`, `agent_settled`, `isIdle`, `hasPendingMessages`, and exact owned-turn `abort`. Preserve the current distinction between activity, delivery, settlement, and execution. Provider retries are not new logical reminders.

### Display and recording

Register a terminal renderer using the existing message card components. The collapsed card shows the workflow, execution outcome, and short reason. Expanded details expose the recorded technical facts. The following ordinary assistant response provides the explanation and recovery decision. Full serialized `finalOutput` must not fill the default transcript.

Keep useful workflow-specific summaries. The terminal model should refer to an already visible summary rather than needlessly repeat it. The terminal handoff still occurs because its responsibility includes deciding what happens next.

Show recovery activity separately from terminal execution status. Update both the widget and shared client views without marking a completed run as running again. Keep the terminal result available through its handoff; a display retention timer must not hide active recovery.

Recording must include the terminal turn and its settled response, not stop at delivery of its prompt. Explicit follow-ups retain their own capture segment. Rendering or recording failures cannot reverse execution or prevent cancellation. Report recording failures honestly.

## Proposed limits and remaining decisions

The behavior above is required. These operational defaults are proposals, not user-selected values:

- Allow two reminder turns per exact pending attempt before a clear blocked or failed outcome.
- Allow two automatic workflow launches in one recovery chain. Count both restart and corrected-start launches. Preserve the count across process restart and new child runs.
- Give terminal recovery a named finite active-time budget. Reuse the existing timeout accounting; choose the duration during implementation rather than silently inheriting an unrelated worker timeout.

Before implementation is considered ready, resolve the timeout duration, the existing record that owns each policy value and count, and the treatment of an interrupted recovery turn. Distinguish a lost transport acknowledgment, a provider failure before useful output, and uncertain side effects. Transport retries may adopt saved evidence but must not become unbounded new model turns.

Document any departure from these proposed defaults and its reason. Do not use unresolved details as a reason to remove either required behavior or to ship an unbounded loop. No new public configuration surface is required merely to store named defaults; add one only when an actual operator need is established.

## Implementation sequence

1. Compare PR #77, commit `356720c` and its parent, and the current tests. Make a behavior checklist. Preserve later handoff, verification, and cancellation fixes.
2. Add regression tests that fail on the current implementation because no terminal turn or reminder is delivered. Replace tests that explicitly require those absences. Keep the tests against duplicate delivery and unrelated-chat ownership.
3. Implement reminder eligibility and bounded exhaustion on the current exact-request and settled-turn transitions. Avoid the old direct SQL updates scattered through server orchestration.
4. Restore terminal model eligibility, model-facing instructions, recording completion, cancellation, and bounded recovery launch admission together. Flipping `triggerTurn` alone is insufficient: current content validation, ownership checks, and downstream ordering also encode the no-turn assumption.
5. Add the terminal renderer and update follow-up eligibility, shared activity views, and capture boundaries. Keep one coordinator and public Pi APIs.
6. Run deterministic tests, real-Pi fixture tests, and packed-package verification. Perform the separately authorized live canary after those pass. Inspect the actual transcript and controls.
7. Update the reference pages and skill guidance to the behavior that shipped. Record exact validation evidence and unresolved limitations. Do not call the plan complete merely because APIs exist or unit tests pass.

## Acceptance tests

| Case                                                | Required observation                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Successful workflow                                 | One terminal model opportunity explains or acknowledges the result and checks remaining work.              |
| Failed or timed-out workflow                        | The regular model receives evidence and can choose safe recovery or a clear blocker.                       |
| Bad start call before run creation                  | The tool error permits correction in the current turn; no synthetic run or second sender is created.       |
| Wrong or stale submission                           | No other request advances; the model can correct the exact pending result where applicable.                |
| Missing submission                                  | A reminder is delivered after settlement, with the correct request and bounded count.                      |
| Slow validation or accepted result race             | No stale reminder, duplicate acceptance, or premature failure.                                             |
| Exhausted reminders or recovery                     | A visible bounded outcome; no silent wait or automatic count reset.                                        |
| Accepted work followed by presentation failure      | Accepted output remains; completed side effects are not repeated.                                          |
| Uncertain command or external effect                | Recovery inspects or blocks; it does not assume absence or undo.                                           |
| Pause, explicit cancel, then reconnect              | No unauthorized reminder, recovery launch, or resumed side effect.                                         |
| Cancel after terminal execution but during recovery | The exact recovery turn stops; unrelated chat is not aborted.                                              |
| Lost delivery, start, or end acknowledgment         | Saved identities and branch evidence are adopted without blind resend.                                     |
| Reopen history or switch branch                     | No replay of an already completed recovery decision; ambiguous evidence is reported.                       |
| Ordinary user input before delivery                 | User work takes precedence and automatic eligibility is checked again.                                     |
| Recovery launches another workflow                  | Shared ownership and budget remain correct; follow-ups cannot overtake it.                                 |
| Restart with corrected input                        | The chosen command preserves scope, causal identity, budget, and approval boundaries.                      |
| Protected human decision                            | No reminder or recovery turn can answer on the user's behalf.                                              |
| Render and capture                                  | Compact terminal card, readable assistant reply, full accessible evidence, and correct recording boundary. |

Test short synthetic limits and injected clocks. Exercise duplicate and reordered reports, disconnects, crash recovery, and cancellation races. Do not rely on model timing or wait for real long deadlines in automated tests.

## Verification commands

During this documentation task, run only:

```bash
npx -y @simpledoc/simpledoc check
git diff --check
```

During a separately authorized implementation, use the repository's current commands:

```bash
npm run check -- -- --maxWorkers=2
npm run test:e2e -- --maxWorkers=2
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
CARGO_BUILD_JOBS=2 cargo test --manifest-path tui/Cargo.toml
CARGO_BUILD_JOBS=2 cargo clippy --manifest-path tui/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path tui/Cargo.toml -- --check
npm pack --dry-run
npm run test:e2e:live -- --runtime-only
npx -y @simpledoc/simpledoc check
git diff --check
```

Then, with separate live-call authorization and the normal credential used in place, run the low-cost installed-package canary. The existing example is:

```bash
npm run test:e2e:live -- --provider openrouter --model deepseek/deepseek-v4-flash --max-output-tokens 4096
```

Extend that harness to cover actual terminal recovery and reminder delivery; its current success does not establish the restored behavior. Record exact package and Pi versions, model and API, observed cost, run identifiers, transcript evidence, cancellation results, and cleanup. Do not substitute another model or persist credentials.

If the implementation is assigned through the legacy implementation process, push before `pi-reviewer --base main`, address findings, and inspect CI after review passes. Review and merge authority come from that implementation request, not from this documentation task.

## Completion

Both required behaviors must work through the installed package during normal operation and the failure cases above. The same tests must prove that user cancellation wins, completed work survives, recovery is bounded, and uncertainty is not hidden. Current records and allowed-action views must explain each next action. Documented expectations, shipped code, tests, skills, and user-visible messages must agree.
