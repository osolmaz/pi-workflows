---
title: Let agents run and manage monitor workflows
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-10
updated: 2026-08-10
status: implemented
---

# Agent-managed monitor workflows plan

The user should be able to tell an agent, "Monitor this every 30 minutes," and have the agent start the right workflow. The user must not write controller records or JSON. The existing `workflow` model tool should manage workflows instead of serving only as a step-submission tool.

A monitor is one Pi Workflows graph. It checks the target, reports a meaningful change, sleeps for the requested interval with the existing shell node, and loops. This plan does not use controllers, Unified Exec, a new wait node, or a second scheduler.

## Shipped design

The implementation follows this plan. The built-in monitor defaults to 1,000 checks, caps the interval at 24 hours, and uses a 5,010-step engine limit as a second guard. The normal Pi extension exposes all workflow tool actions. The headless RPC bridge exposes only `submit`. A real-Pi end-to-end test proves that a normal model turn can start the built-in monitor and complete its first check. The automated test inspects the exact 30-minute `sleep 1800` command and both timeout margins instead of making the test suite wait for 30 minutes.

## User experience

A normal request looks like this:

> Monitor PR 123 every 30 minutes. Tell me when checks fail. Stop when it is merged or closed.

The agent recognizes repeated monitoring from the `workflow` tool description and starts the built-in `monitor` workflow. The tool call contains the structured input, but the user does not write it.

The monitor checks immediately, then waits between later checks. It writes a normal assistant message only when the requested report condition is met. It stops when the requested stop condition is met, when it reaches its safety limit, or when the user or agent cancels it.

Existing controls remain available:

```text
/workflow pause
/workflow resume
/workflow cancel
```

The same operations become available to the model through the `workflow` tool. One active workflow per Pi session remains the rule. A long monitor therefore occupies that session's workflow slot.

## Workflow tool

Replace the current submit-only schema with one discriminated tool schema. Use Pi's documented `registerTool` API and `StringEnum` helper.

The tool supports these actions:

- `list`: list discovered workflows and their source.
- `start`: start a workflow by name or path with structured input.
- `status`: return a bounded summary of the active or named run.
- `pause`: pause the active run at its next node boundary.
- `resume`: resume the active paused run.
- `cancel`: cancel the active run.
- `answer`: answer a waiting checkpoint, with an optional run ID.
- `submit`: submit the result required by the current workflow step contract.

The `submit` form becomes:

```json
{
  "action": "submit",
  "step": "check",
  "attempt": "attempt-id",
  "output": {}
}
```

Update workflow step prompts and reminders to include `action: "submit"`. Do not retain the old submit shape as a compatibility alias.

Slash commands and tool actions must call the same internal lifecycle functions. This avoids separate behavior for humans and models. Tool results must be structured and bounded. Errors must state whether the operation failed because no run exists, a run is already active, a checkpoint is not waiting, or the requested workflow cannot be found.

A tool call happens during an agent turn. The `start` action must validate and queue the launch, then deliver the first workflow prompt after the initiating turn settles. This prevents the new run from treating the initiating turn as a failed workflow step. It also prevents a workflow prompt from being injected in the middle of the tool call.

The headless RPC bridge keeps a submit-only version of the tool. Headless workflow children must not start or control other workflows. Its submit schema and parser still change to require `action: "submit"`.

## Agent guidance

The tool description must tell the model when to use the built-in workflow:

- Use `start` with workflow `monitor` when the user asks to watch, monitor, poll, or check something repeatedly.
- Start directly when the task and interval are clear.
- Ask one short question when the target or interval is missing.
- Use observation-only behavior unless the user explicitly authorizes a mutation.
- Do not create repeated work without a user request or an existing workflow instruction that authorizes it.

The `list` result identifies `monitor` as a built-in workflow and gives a short description. This keeps discovery inside the tool instead of adding a skill or a system-prompt injection.

## Built-in monitor workflow

Ship `monitor` as a built-in workflow in the Pi Workflows package. Built-ins have the lowest discovery precedence:

1. Project workflows under `.pi/workflows/`
2. Global workflows under `~/.pi/agent/workflows/`
3. Workflows bundled with Pi Workflows

A project or global `monitor.workflow.ts` can therefore replace the default. The built-in remains a real workflow file so run bundles can record its path and source hash with the existing rules.

The workflow input contains:

- `task`: what to inspect.
- `everyMinutes`: the interval between checks.
- `reportWhen`: changes or states that deserve a user message.
- `stopWhen`: the condition that ends monitoring.
- `maxChecks`: a hard safety limit.

The model supplies these fields from the user's request. The workflow validates the input and applies documented bounds. The first release supports intervals from 1 minute through 24 hours. It defaults `maxChecks` to a documented finite value when the request gives no end limit.

The graph is:

```text
prepare -> guard -> check
                    | continue quietly -> sleep -> guard
                    | continue and report -> report -> sleep -> guard
                    | stop quietly -> finish
                    | stop and report -> report-final -> finish
```

`prepare` validates and normalizes the input. `guard` enforces `maxChecks`. `check` is an agent node that performs one observation and returns a validated route, a bounded observation, and an optional report. The next `check` can read the previous accepted `check` output, which Pi Workflows already keeps for looped nodes.

The report nodes write a normal assistant message and then submit an acknowledgement. Keeping reporting after accepted check output prevents the agent from showing a report before the structured result passes validation. The final presentation reports why the monitor stopped without repeating a report that the user already saw.

The sleep node uses the existing Pi Workflows shell action and the system `sleep` command. Set the node timeout above the largest supported interval because the engine default is 15 minutes. Set the shell execution timeout above the requested sleep by a small fixed margin. Cancellation aborts the sleep immediately.

If the Pi TUI or standalone workflow host stops during sleep, Pi Workflows parks the run and kills the shell child. Resuming the run starts that sleep node again from the beginning. This is existing workflow behavior and is acceptable for this feature. No special timer persistence is added.

The workflow uses a high but finite `maxSteps` value as a second safety guard. Check and report values have explicit size limits so a long run cannot grow its bundle without bound.

## Repository changes

Make the feature in `osolmaz/pi-workflows`:

- Refactor workflow lifecycle operations out of the slash-command handler.
- Expand the normal Pi `workflow` tool and update its tests.
- Update the RPC bridge submit contract.
- Add built-in workflow discovery with project and global override precedence.
- Add the built-in monitor workflow and focused tests.
- Update `README.md` and `docs/workflows.md`.

After the upstream change is complete, update the pinned Pi Workflows commit in OnurPi's thin `packages/workflows` wrapper. Do not add a new OnurPi extension or copy a monitor file into live global state.

## State and API impact

- **Session state:** Normal workflow prompts, model replies, tool calls, and monitor reports are appended through Pi's normal session behavior.
- **Other persistent data:** No new data model. The feature uses existing run bundles and the existing workflow run queue.
- **Pi internals:** None.
- **Pi public API:** `registerTool`, `registerCommand`, `sendUserMessage`, and documented agent and session lifecycle events.
- **Pi Workflows API:** The workflow definition and run-state models do not change. The model-facing `workflow` tool contract changes, and discovery gains a lowest-priority built-in source.

## Non-goals

This work does not add cron expressions, calendar schedules, a background service, controller resources, OS notifications, concurrent workflows in one session, resumable shell processes, or guaranteed wall-clock wake times across runner shutdowns. It does not let headless child agents recursively start workflows.

## Acceptance criteria

- A user can ask for repeated monitoring in plain language, and the agent starts `monitor` through the existing `workflow` tool.
- The user does not type JSON or a slash command to start the monitor.
- The monitor checks immediately, sleeps for the requested interval, and checks again.
- An unchanged observation produces no normal assistant report.
- A matching report condition produces one concise assistant report.
- A matching stop condition reports as requested and ends the run.
- The safety limit ends a monitor that never reaches its stop condition.
- The model can list, start, inspect, pause, resume, cancel, answer, and submit through one tool.
- Slash commands and tool actions use the same lifecycle code.
- Starting from a model tool call does not cause an early nudge or record the initiating turn as the first workflow attempt.
- A 30-minute sleep is not stopped by the default 15-minute node timeout.
- Cancelling during sleep stops the shell child and ends the workflow.
- Project and global workflows override the built-in `monitor` name.
- Existing workflow, controller, host, viewer, and run-bundle tests continue to pass.
- OnurPi loads the updated wrapper and Pi starts successfully.

## Verification

Add unit and integration coverage for tool action validation, lifecycle dispatch, deferred model-start launches, built-in discovery precedence, monitor routing, quiet checks, reports, stop conditions, safety limits, cancellation during sleep, and the headless submit bridge.

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
```

Test the extension from the Pi Workflows checkout with `pi -e src/extension/index.ts`. Use a short test interval in a controlled fixture, then perform one manual 30-minute monitor run to confirm that the configured node timeout does not stop it. Test plain-language startup with the normal model, then test list, status, pause, resume, cancel, and checkpoint answer actions.

After updating OnurPi, run its full checks and start Pi with the installed OnurPi package. Confirm that the model sees one `workflow` tool, discovers `monitor`, and can start it from a plain-language request.
