---
title: Tell the model to end its turn for workflow steps
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-12
status: approved
---

# Tell the model to end its turn for workflow steps

## Goal

Correct the model-facing workflow text so a started run receives its steps without the agent waiting inside its own turn, and so the Autoimplement decide step reads as the agent's own decision.

## Observed failure

The run `20260912T015521613Z-autoimplement-61531ef1` stalled for six minutes and forty-five seconds before its first step reached the model.

The agent started the run at 09:55:21 and then kept its own turn alive with `sleep` commands while it polled `workflow status`. The extension coordinator sends a step only when Pi is idle, so the pending `decide` step waited for that turn to end. The agent's own sleeping blocked the step it was waiting for. Its visible explanation, "The workflow is waiting at its decision. It continues on its own after 10 minutes. Let me wait it out.", came from two misleading texts: the start result said to complete the next delivered step, and the status reason said that delivery was not confirmed. The agent then invented a ten-minute rule for a request kind that has no timeout policy.

The user interrupted the sleep, which ended the turn. The step arrived in the same second. A second interrupt then aborted the newly started workflow turn, and the run paused durably with its agent request still pending.

Two defects caused this:

- No text told the model that a pending step starts a new turn and that it must end its current turn.
- The Autoimplement decide prompt called itself "a read-only controller turn", which read as though some other actor owned the decision. The `decide` node is an ordinary agent step, and the engine routes only on the route that the agent submits.

## Selected change

Change text only, in the places the model reads. Leave the engine and its durable schemas as they are.

The waiting reason also reaches the model through the `workflow` status result, so the status text and the tool description carry the same rule as the start result.

Requirement six adds the rule to the shared step contract, which reaches every submitted agent step in every built-in workflow.

## Scope

Only `/home/onur/repos/pi-workflows`. The change may edit the files named below and run the local checks. It may create commits and push the task branch. It may also open or update the pull request, and merge it after pi-reviewer passes and CI is green. It must not modify other repositories, tag or release, deploy, change credentials, or change repository policy.

## Non-goals

- Do not add a workflow node type, a route, a branch, or a graph edge.
- Do not change durable schemas, event shapes, or stored run data.
- Do not add a version 2 contract, a compatibility reader, a migration, or a feature flag.
- Do not keep both the old and the new text.
- Do not add another reminder, timer, retry budget, or delivery path for steps.
- Do not add limits to user-visible output.
- Do not touch another repository.

## Requirements

1. In `src/extension/index.ts`, append to the workflow tool description: "A pending step starts a new model turn after your current turn ends. After you start a run, end your turn so the step can be delivered. Do not sleep, poll, or wait for a step inside your turn."
2. In `src/extension/index.ts` line 848, append to the start result message: "The first step arrives as a new model turn. End this turn now so it can be delivered, and do not wait for it inside this turn."
3. In `src/server/view.ts` line 995, replace the reason string "Workflow step delivery is not confirmed." with "A step is pending delivery. It starts a new model turn after this turn ends."
4. In `src/builtins/autoimplement.workflow.ts` line 1604, replace "This is a read-only controller turn. Inspect local and remote state when needed, but do not edit files or perform a mutation." with "You are the decider for this turn. The workflow cannot choose a route without the one you submit. Inspect local and remote state when you need it, but do not edit files and do not perform a mutation."
5. In `src/builtins/autoimplement.workflow.ts` line 1598, replace the statusDetail "deciding the next autoimplementation action" with "choose one route and submit it now".
6. In `src/workflows/engine.ts` `appendStepContract`, add the line "This step is your work now. Nothing else will start it, so do not sleep or poll for another step." before the "Complete this step by calling" line of the submitted-step contract.
7. In `skills/pi-workflows/SKILL.md`, add after the start rules: "After the start call, end your turn. The first step arrives as a new model turn, so do not wait for it inside your current turn."
8. In `skills/autoimplement/SKILL.md`, add in the Start the workflow section: "After the start call, end your turn. The first step arrives as a new model turn."
9. Update every test, fixture, and snapshot that asserts a replaced string, including `test/server-view.test.ts` line 126 and `fixtures/layout/example-autoimplement.json` line 18.
10. Update `docs/WORKFLOWS.md` so the step contract example and the surrounding text include the new line and state that a pending step starts a new model turn and the model ends its current turn instead of sleeping or polling for it.

## Constraints

- Follow `AGENTS.md`, including its check commands and one live end-to-end run with an authenticated low-cost model.
- Apply the alpha compatibility policy. Change contracts in place and remove the superseded text.
- Use the exact prompt wording above. Keep AI writing tells out of every new prompt text. Avoid em dashes and colon pivots. Avoid contrast rhetoric such as "not X but Y", and avoid rule-of-three chains.
- Keep the built-in workflow skill structure that `AGENTS.md` requires.
- Keep the change to text.

## Verification

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

Then run one live end-to-end run with an authenticated low-cost model, using an exact provider and model id. The transcript must show the start result, the delivered first step, and an accepted submission.

## Acceptance criteria

- The workflow tool description, the start result, and the waiting reason all tell the model to end its turn.
- Every submitted step contract carries the rule that the step is the model's work now.
- The Autoimplement decide prompt names the model as the decider and forbids waiting, and its status detail asks for a route.
- Both built-in skills carry the same rule after the start call.
- Every test, fixture, and snapshot matches the new strings, and no file still asserts a replaced string.
- `docs/WORKFLOWS.md` shows the new contract line and states the rule.
- The full checks, both Slophammer commands, and one live run pass.

## Contract impact

- **Session state:** prompt text in step messages, and text in the `workflow` tool results for start and status.
- **Other persistent data:** none. No schema, record, or snapshot shape changes.
- **Pi internals:** none.
- **Public Pi API:** none.
- **Public pi-workflows API:** none. The change touches prompt and tool-result text only.
