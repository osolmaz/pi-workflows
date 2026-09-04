---
title: Add durable workflow updates and progress reporting
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-16
---

# Add durable workflow updates and progress reporting

This plan implements the contracts in [WORKFLOW_UPDATES.md](../WORKFLOW_UPDATES.md), [WORKFLOW_STEP_MESSAGES.md](../WORKFLOW_STEP_MESSAGES.md), and [MONITOR.md](../MONITOR.md). It follows the [design philosophy](../DESIGN_PHILOSOPHY.md): add one general update capability, keep the node set small, and build progress, presentation, and monitoring through composition.

## Outcome

pi-workflows will let a running agent, function action, shell action, or claimed runner publish durable structured updates without completing a node. Progress will be one optional update type with shared estimation and presentation helpers.

The built-in monitor will report every accepted check, support optional progress tracks, show live timing in the widget, and deliver notifications without starting an assistant turn.

Interactive agent steps will keep their full model prompts while appearing as compact, expandable workflow cards in the conversation.

## Scope

### pi-workflows engine

- Add public update types and the action context that publishes them.
- Add fenced update publication to the engine and run store.
- Append `update_published` trace events.
- Add the latest update projection to run state.
- Preserve update ordering and idempotency.
- Apply payload and key-count limits plus update rate limits.
- Expose update publication to claimed hosts and controllers.

### Node and tool APIs

- Add `publishUpdate()` to function-action context.
- Add the non-completing `workflow` tool action `update`.
- Add structured line parsing to shell actions.
- Keep compute nodes pure.
- Keep final node outputs as the only routing input.
- Keep the existing `status` action read-only and include current updates in its details.

### Progress support

- Add the `pi-workflows.progress.v1` validator and types.
- Add incremental reduction and conservative estimation helpers.
- Support independent tracks with stable keys.
- Support source ETA, measured ETA, confidence, stalls, resets, stale data, and unavailable estimates.
- Reserve `overall` for workflow-supplied aggregation.
- Add model-free formatters for notifications and displays.

### Presentation

- Extend the compact Pi widget with an optional bounded progress panel.
- Extend `piw` and the TypeScript viewer with update history and full progress details.
- Reuse the current widget ticker for elapsed time and countdowns.
- Keep observed counters fixed between updates.
- Deliver workflow notifications with `triggerTurn: false` while retaining them in later model context.
- Deliver interactive agent steps as `pi-workflows-agent-step` custom messages with `triggerTurn: true`.
- Show workflow, node, and status details in a compact card and the complete prompt when expanded.
- Use the same complete model prompt in interactive and RPC execution.

### Built-in monitor

- Replace quiet/report routes with `continue` and `stop`.
- Require a report after every accepted check.
- Remove `reportWhen`, report acknowledgement steps, and `presentationPrompt`.
- Add optional progress tracks to check output.
- Add estimate and publish stages, then schedule and report through existing nodes.
- Default to a 30-minute interval.
- Preserve the documented 1,000-check workflow safety ceiling.
- Keep explicit user stop as the fallback stop rule when no terminal condition is clear.

### Integration repositories

- Release the package from `osolmaz/pi-workflows`.
- Update the exact package pin and upstream record in `osolmaz/onurpi`.
- Update the source monitor skill in `osolmaz/tools`, then run its sync script.

## Non-goals

- No Pi core changes.
- No progress node type.
- No automatic aggregation of unrelated tracks.
- No arbitrary commands inside update data.
- No model-generated fallback ETA.
- No remote metrics service or global time-series database.
- No migration files, fallback formats, or dual writes for run bundles.
- No claim that a finite workflow is an indefinite controller.
- No controller-backed indefinite monitor in this release.
- No new workflow primitive or workflow-file option for step-message presentation.
- No Pi core change, private Pi API, or separate expansion state.
- No duplicate `sendUserMessage` fallback for new agent-step messages.
- No rewrite of existing Pi session entries.

## Persistent contract impact

### Run bundles

`trace.ndjson` gains `update_published` events. `state.json` gains the optional latest `updates` projection. The trace remains the source of truth.

Omission means that a run has never published an update. New runs write an empty array from their first projection. Existing bundles remain valid without migration or fallback code. The implementation keeps the current `pi-workflows.trace-event.v1` and `pi-workflows.run-state.v1` identifiers and does not add dual-write paths.

Checkpoint continuations begin with an empty update projection. Resume keeps updates because it continues the same run.

### Pi sessions

Workflow notifications remain `pi-workflows-notification` custom messages. They remain in session history and model context. Delivery sets `triggerTurn: false`, so arrival does not start a model turn.

New interactive agent-step instructions become `pi-workflows-agent-step` custom messages. Their complete prompt remains in session history and model context. Delivery sets `triggerTurn: true`, so each accepted delivery starts the required model turn. The structured message details use `pi-workflows.agent-step-message.v1`.

Existing user-message entries remain readable and are not rewritten. No private Pi entry type, Pi schema change, or separate persistent store is introduced.

### ResourceManager storage

The controller database schema does not change for the first implementation. Controllers publish only through a claimed workflow run. ResourceManager-native status remains in managed resources.

## Public API impact

The release adds:

- `WorkflowUpdateInput`
- `WorkflowUpdateRecord`
- `WorkflowUpdateReceipt`
- `WorkflowActionContext`
- `context.publishUpdate()`
- the `workflow` tool action `update`
- shell update parsing
- progress validation and estimation exports, including reduction and formatting
- optional agent-step presentation metadata passed to executors
- the versioned `WorkflowAgentStepMessageDetails` extension contract

The built-in monitor check output changes incompatibly. Existing `continue_quiet`, `continue_report`, `stop_quiet`, and `stop_report` outputs become invalid. The new values are `continue` and `stop`, and both require `report`.

The recommended release is `0.6.0`. The package is pre-1.0, previous capability releases use minor versions, and this release adds public APIs while replacing the built-in monitor contract.

## Implementation sequence

### Core update records

Files expected to change:

- `src/workflows/types.ts`
- `src/workflows/json.ts`
- `src/workflows/schema.ts`
- `src/workflows/store.ts`
- `src/workflows/engine.ts`
- `src/workflows/index.ts`
- `test/store.test.ts`
- `test/engine.test.ts`
- `test/engine-more.test.ts`

Work:

1. Add public update types and validators.
2. Add `updates` to new and replayed run state, and treat omission as no published updates.
3. Add a fenced store transition that writes `update_published` first and then replaces projections.
4. Fold the latest record per `(type, key)` into state, sorted by trace sequence.
5. Enforce payload and key limits with a token-bucket rate limit.
6. Add idempotent publication by source id.
7. Rebuild projections from trace and verify torn-tail repair.
8. Ensure terminal or expired attempts reject updates.

Verification:

- unit tests for valid writes and receipts
- ordering under concurrent publication attempts
- duplicate tool source id returns the first receipt
- claim loss blocks writes
- resume reconstructs the same projection
- continuation starts empty
- state and trace agree after repair

### Publishers

Files expected to change:

- `src/workflows/types.ts`
- `src/workflows/engine.ts`
- `src/workflows/shell.ts`
- `src/extension/workflow-tool.ts`
- `src/extension/index.ts`
- `src/server/rpc-executor.ts`
- `test/extension.test.ts`
- `test/workflow-args.test.ts`
- `test/e2e/workflow.e2e.test.ts`

Work:

1. Give function actions `WorkflowActionContext`.
2. Connect `publishUpdate()` to the current run, node, attempt, claim fence, and cancellation signal.
3. Add the `workflow` tool `update` variant.
4. Use the Pi tool call id as the agent-update source id.
5. Keep the step open after a successful update.
6. Reject mismatched and expired step contracts.
7. Add shell stream selection, line framing, parser execution, and publication backpressure.
8. Terminate shell actions on parser or publication failure.
9. Expose the same claimed-run operation to the standalone host and controller scheduler boundary.
10. Include the current update projection in `status` details.

Verification:

- an agent publishes several updates and submits once
- function action publication is durable before the promise resolves
- shell stdout and stderr parsing works with partial chunks and a final unterminated line
- malformed or oversized lines and invalid UTF-8 fail safely
- update data cannot change shell execution
- a tool update does not trigger an assistant turn

### Progress profile

Expected new or changed files:

- `src/workflows/progress.ts`
- `src/workflows/index.ts`
- `test/progress.test.ts`

Work:

1. Add strict `pi-workflows.progress.v1` validation.
2. Add a reducer keyed by run and track key.
3. Split estimation epochs after phase or unit changes, total or counter changes, and terminal-state resets.
4. Keep the latest eight usable intervals.
5. Calculate median rate, percentile range, confidence, remaining work, sample age, and stall duration.
6. Prefer fresh source ETA and label its basis.
7. Pause measured ETA for waiting or blocked tracks.
8. Return a reason whenever ETA is unavailable.
9. Add bounded plain-text formatting.

Verification fixtures must cover:

- no counts
- completed without total
- two-sample low-confidence ETA
- stable high-confidence samples
- bursty and zero-rate intervals
- counter rollback
- changed phase, unit, or total
- source ETA
- stale source facts
- waiting, blocked, failed, cancelled, and completed tracks
- several unrelated tracks
- explicit `overall`

### Update presentation

Files expected to change:

- `src/extension/widget.ts`
- `src/extension/index.ts`
- `src/viewer/render.ts`
- `src/viewer/tui.ts`
- `src/viewer/watch.ts`
- `tui/src/`
- `test/widget.test.ts`
- viewer tests and Rust fixtures

Work:

1. Add a pure progress view model under the workflow or render layer without importing Pi.
2. Keep the graph visible and fit the optional panel inside the 10-line Pi limit.
3. Prioritize `overall`, failures, blocked tracks, and active tracks.
4. Preserve manual scrolling and active-node following.
5. Recalculate elapsed values from `now` without changing state.
6. Show expired ETA as awaiting a new sample.
7. Add update and estimate inspection to both viewers.
8. Keep TypeScript and Rust rendering behavior in parity.
9. Make notifications explicitly non-triggering while retaining custom messages in context.

Verification:

- zero progress leaves current rendering unchanged
- one and many tracks fit at narrow widths
- timers advance without persisted writes
- completed counters remain fixed
- renderer output contains no assistant-trigger request
- replay at every trace position shows the correct update projection

### Agent-step message presentation

Files expected to change:

- `src/workflows/types.ts`
- `src/workflows/engine.ts`
- `src/extension/executor.ts`
- `src/extension/index.ts`
- `src/extension/` message-renderer module
- `src/server/rpc-executor.ts`
- `test/executor.test.ts`
- `test/extension.test.ts`
- `test/e2e/workflow.e2e.test.ts`

Work:

1. Keep one pure formatter for the complete model prompt.
2. Add optional run-title and status-detail presentation data to `AgentStepRequest` without importing Pi into the workflow layer.
3. Pass the prompt, contract, presentation data, delivery kind, and streaming state through `PromptDelivery`.
4. Replace interactive `sendUserMessage` delivery with a `pi-workflows-agent-step` custom message.
5. Set `triggerTurn: true` and select `steer` or `followUp` from the current streaming state.
6. Register a renderer that reads versioned message details instead of parsing prompt text.
7. Show a bounded workflow and node summary when collapsed.
8. Show exact ids, expected output, and the complete prompt when expanded.
9. Send reminders and repeated resume instructions through the same message type with their delivery kind.
10. Keep RPC delivery on the same complete prompt and preserve run-bundle prompt recording.
11. Remove the interactive `sendUserMessage` path without adding a duplicate fallback.

Verification:

- interactive and RPC model prompts match
- one step delivery starts one model turn
- collapsed and expanded rendering work at narrow widths
- reminders and resumed deliveries preserve the active attempt
- timed-out, cancelled, and stale attempts remain invalid
- replay restores the custom message and structured details
- notification delivery still does not start a model turn
- no duplicate user message appears

### Built-in monitor contract

Files expected to change:

- `src/builtins/monitor.workflow.ts`
- `src/builtins/catalog.ts`
- `test/monitor-workflow.test.ts`
- `test/e2e/workflow.e2e.test.ts`

Work:

1. Make `everyMinutes` optional with default 30.
2. Remove `reportWhen`.
3. Replace the route enum and validation.
4. Require reports for `continue` and `stop`.
5. Add optional strict progress tracks.
6. Add estimate and publish-progress stages, then decide, schedule, and report stages.
7. Publish `monitor.schedule` before each sleep.
8. Notify once for every accepted check.
9. Report before stopping on route or check limit.
10. Remove report acknowledgement and presentation behavior.
11. Update the built-in catalog revision.
12. Keep the 1,000-check safety ceiling and disclose it in prompts and docs.

Verification:

- first check is immediate
- normal interval starts after the report is queued
- every accepted check queues exactly one notification
- quiet routes and missing reports fail validation
- stop report arrives before completion
- safety-limit report arrives before completion
- cancellation does not fabricate a report
- progress is optional
- several tracks publish independently
- notification arrival does not start an assistant turn

### Canonical documentation

Update:

- `README.md`
- `docs/workflows.md`
- `docs/SQLITE_STATE.md`
- `docs/development.md`
- `docs/WORKFLOW_UPDATES.md`
- `docs/WORKFLOW_STEP_MESSAGES.md`
- `docs/MONITOR.md`
- examples that teach agent, action, shell, notify, or monitor behavior

The shipped docs must describe actual field names and limits along with lifecycle and error behavior. Remove accepted-design warnings only after implementation matches the specifications.

### Release and integration

1. Confirm no old active built-in monitor depends on the previous catalog revision.
2. Run every required repository check.
3. Commit coherent implementation slices with Conventional Commits.
4. Prepare release `0.6.0` through the repository's GitHub Release publication flow.
5. Verify npm package contents and the published exact version.
6. Pull `osolmaz/onurpi` with `git pull --ff-only`.
7. Update `packages/workflows/package.json`, lock data, tests, and `UPSTREAM.md` to the immutable release.
8. Run the OnurPi wrapper checks and a real Pi smoke test after `/reload`.
9. Pull `osolmaz/tools`, update `agents/skills/monitor/SKILL.md`, and run `agents/sync-skills.py monitor`.
10. Verify the installed Pi skill matches the source copy.
11. Commit and push each owned repository under its own rules.

## Test matrix

### Unit

- schemas and unknown fields
- update projection and replay
- claim fencing and idempotency
- rate limits and size limits
- progress epochs and estimates
- monitor validation and routing
- widget and viewer formatting

### Integration

- action to trace to state to widget
- agent tool update followed by submit
- shell stream to update publication
- host park and resume
- notification outbox delivery to the origin session
- `status` with current updates

### End to end

Use the real installed Pi runtime without a real model or destructive target:

1. Start a fixture workflow with a scripted action that publishes progress.
2. Observe progress in the in-Pi widget and `piw`.
3. Verify the run trace and state projection.
4. Start a short monitor fixture.
5. Verify one custom notification per check.
6. Verify no assistant turn starts from notification delivery.
7. Start an interactive agent step and verify one compact custom message and one model turn.
8. Expand the message and verify the full prompt and exact contract ids.
9. Compare the provider-facing interactive prompt with the RPC prompt.
10. Cancel during sleep and verify terminal state.
11. Restart Pi and verify durable display and replay.

## Required commands

Run in `osolmaz/pi-workflows` before release:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
```

Run documentation checks:

```bash
npx -y @simpledoc/simpledoc check
npx oxfmt --check README.md docs
python3 ~/.pi/agent/skills/kill-ai-smell/check.py docs/WORKFLOW_UPDATES.md
python3 ~/.pi/agent/skills/kill-ai-smell/check.py docs/WORKFLOW_STEP_MESSAGES.md
python3 ~/.pi/agent/skills/kill-ai-smell/check.py docs/MONITOR.md
python3 ~/.pi/agent/skills/kill-ai-smell/check.py docs/plans/2026-08-16-workflow-updates-plan.md
```

Run package and real-Pi checks again after updating OnurPi. Run the tools skill sync in dry-run mode before applying it.

## Acceptance criteria

- The public update API works from agent and action nodes.
- Shell updates use only workflow-author code and fixed execution settings.
- Every accepted update is ordered and fenced, with durable bounded storage and replay.
- Final outputs remain the only routing input.
- Workflows without updates preserve their current behavior and display.
- Progress is optional and supports several stable tracks.
- ETA is source-based or measured from facts and never invented by a model.
- Widget clocks update without a model call or per-tick write.
- Notifications remain in context and never start an assistant turn.
- Agent-step prompts remain complete for the model and appear as compact, expandable workflow cards.
- Interactive and RPC execution use the same model prompt.
- The built-in monitor reports every accepted check and has no quiet path.
- The monitor discloses its finite safety ceiling.
- TypeScript and Rust viewers agree on replayed progress.
- All required checks pass in pi-workflows and OnurPi.
- The published package, OnurPi pin, monitor skill source, and installed Pi copy agree.

## Risks and controls

### Trace growth

High-rate updates can grow bundles quickly. Payload and rate limits apply alongside burst and current-key limits. Shell parsing applies backpressure.

### Misleading ETA

The estimator uses observed facts, short rolling history, explicit confidence, and unavailable reasons. It never advances observed counters between samples.

### Hidden behavior

Updates cannot route, execute, or notify. The graph retains control of completion, side effects, and user messages.

### Duplicate notifications

Update idempotency and the existing notification occurrence index remain separate. Each monitor check reaches one notify node once.

### Prompt and display drift

The renderer reads structured details, while one formatter produces the complete model prompt for interactive and RPC execution. Tests compare provider-facing content and verify that expansion shows the recorded prompt. The renderer never rebuilds instructions from display fields.

### Upgrade interruption

The built-in monitor revision change can block resume of an old active monitor even though old bundles remain valid. Inventory active monitors before release and do not install the new built-in over work that still needs the old revision.

### Rollback

Before any run publishes an update, rollback is an exact dependency pin to `0.5.3`. After update-bearing bundles exist, preserve them and keep the new reader available. Do not delete or rewrite bundles to force an old runtime to read fields it does not support.

## Follow-up boundary

A truly indefinite monitor belongs in the resource manager runtime. This plan keeps the finite workflow safety ceiling and does not hide it behind a huge number or automatic restart. A later managed resource may use the same update and progress contracts alongside the notification and viewer contracts.
