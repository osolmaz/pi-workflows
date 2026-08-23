---
title: Plan Change Approval Policy Plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-21
---

# Plan change approval policy plan

## Summary

Autoimplement and Monitor must use one shared workflow whenever they create or revise a plan. The shared workflow plans, records the plan in canonical documentation, asks for the configured human decision, and handles bounded replanning.

The default policy is autonomous. It asks the `operator` audience to continue, stop, or replan. If no valid answer is accepted within 10 minutes, it continues with the exact presented plan. A required policy waits for an explicit answer. A skip policy continues immediately without creating a human decision.

The timeout default belongs to the general `humanDecision()` contract. It must be durable, deterministic, bound to the exact request and plan digest, and separate from a human answer. Autoimplement and Monitor must not contain their own decision timers or copies of approval and replan logic.

## Goals

The change must provide these results:

- Every plan newly created or changed by Autoimplement or Monitor passes through one shared plan-change workflow.
- Existing supplied or discovered plans do not receive a new decision.
- The default policy asks for a decision and continues after 10 minutes when there is no answer.
- Operators can require an explicit answer or skip the decision.
- Pi and Telegram show and settle the same durable decision.
- A human answer, timeout default, and cancellation cannot create more than one continuation.
- Cancellation remains immediate and terminal.
- Repeated entry with the same plan digest does not create another decision.
- Monitor does not cause Autoimplement to ask again for the plan that Monitor already selected.

## Approval policy

Autoimplement and Monitor use the same policy shape:

```ts
type PlanApprovalPolicy = {
  mode: "auto" | "required" | "skip";
  audience?: string;
  timeoutMinutes?: number;
  maxReplans?: number;
};
```

The workflow input field remains `approval`. When it is absent, parsing supplies this policy:

```json
{
  "mode": "auto",
  "audience": "operator",
  "timeoutMinutes": 10,
  "maxReplans": 3
}
```

The modes have these meanings:

- `auto` creates a human decision. It continues with the presented plan when no valid answer is accepted before the deadline.
- `required` creates a human decision with no automatic response. It waits for `continue`, `stop`, or `replan`.
- `skip` creates no human decision and continues immediately.

`audience` defaults to `operator`. `timeoutMinutes` applies only to `auto` and defaults to 10. `maxReplans` defaults to 3 and bounds the exact-instructions replan loop. Parsers reject unknown fields, unsupported combinations, non-positive timeouts, and invalid replan limits.

The skills must map common requests as follows:

```json
{
  "approval": {
    "mode": "required"
  }
}
```

Use this for requests such as “block on plan changes.”

```json
{
  "approval": {
    "mode": "skip"
  }
}
```

Use this for requests such as “do not block on plan changes.” Omitting `approval` uses the 10-minute autonomous default.

## Shared plan-change workflow

Add one internal finite workflow that owns this sequence:

```text
autoplan
  -> autodoc
  -> plan-approval
       -> continue -> ready
       -> stop -> blocked
       -> replan -> autoplan
```

The workflow receives the planning problem, scope, constraints, repository and document context, previous plan, new evidence, and approval policy. It returns either:

- `ready`, with the selected plan, plan digest, canonical documents, revision, and decision provenance; or
- `blocked`, with the reason and evidence.

The workflow owns the replan count and passes exact operator instructions back to Autoplan. Each changed plan gets a new positive revision. The plan digest binds the plan, documentation result, approval request, and final output.

The workflow bypasses the human-decision node in `skip` mode but still records `skipped` as the plan selection provenance. It does not create a synthetic human receipt.

Promote the existing approved-plan composition pattern into this internal built-in workflow. Keep `plan-approval` as the low-level reusable decision workflow. Do not add a standalone `plan-approval` skill.

## Human-decision timeout default

Extend the public `humanDecision()` definition with a general optional timeout response:

```ts
humanDecision({
  audience: "operator",
  choices,
  request,
  onTimeout: {
    afterMs: 10 * 60_000,
    response: { choice: "continue" },
  },
});
```

The policy may also be derived from the node context so the shared plan-change workflow can use its parsed input. `afterMs` must be a positive finite duration. The response must satisfy the same typed choice and input contract as a human response. An absent `onTimeout` keeps the current indefinite wait.

When the engine creates the request, it computes and persists:

- the absolute expiry time;
- the validated default response;
- the request and presentation digests;
- the exact node and attempt identity; and
- the plan digest and revision already present in the decision subject.

The request digest includes the deadline policy and default response. A changed deadline, response, plan, or revision therefore creates a different request identity.

## Resolution and provenance

A timeout default is an automatic workflow-policy resolution. It is not a human answer and must not use a human actor or channel identity.

The existing resolution record gains a distinct timeout-default outcome and provenance in place. Human acceptance, timeout default, and cancellation all compete for the same immutable resolution record. The first valid resolution wins. The accepted workflow output states whether the result came from:

- `human`;
- `timeout`;
- `skipped`; or
- `cancelled`, where a terminal record is exposed.

A human answer is valid only before the deadline and while no terminal resolution exists. A late answer cannot replace a timeout default. A timeout resolver must re-read an existing resolution and adopt it rather than create another result.

The plan-approval continue result carries the plan digest, decision revision, response, and resolution provenance. A timeout result carries no human actor. A skipped result carries no human-decision receipt.

## Recovery and ownership

Use the existing one-second human-decision recovery loop. Do not add a service, daemon, controller, or second timer system.

For an unresolved request with an eligible timeout default, the current owner must:

1. confirm that the parent run is still waiting at the same request;
2. confirm that the request deadline has passed;
3. confirm that the run and decision are not cancelled;
4. atomically write or adopt the timeout-default resolution;
5. create or adopt the deterministic continuation record;
6. start the continuation only when the owning process can claim it; and
7. settle every open Pi and Telegram view.

If no owner is active at the deadline, the request becomes eligible at that time. The next active owner resolves it and starts or adopts the continuation. The saved absolute deadline means a restart does not restart the 10-minute period.

Auto mode must continue after the deadline even when no decision channel is configured. Required mode remains waiting and reports the missing channel configuration. Skip mode does not use a channel.

## Cancellation and races

Explicit workflow cancellation remains terminal. It must cancel the waiting decision, close channel views, and prevent a timeout continuation.

The cancellation path and timeout resolver must check the durable run cancellation state before and after claiming the decision resolution and before starting a continuation. If cancellation races with an automatic resolution, the cancelled run and its deterministic continuation must not execute more workflow nodes. A later recovery pass must not revive either run.

A human answer and timeout default use the immutable resolution as their race boundary. Tests must cover both winners at the deadline boundary and prove that only one continuation can exist.

## Autoimplement integration

Autoimplement must use the shared plan-change workflow only for a changed plan produced by its internal redesign route.

These plans bypass the gate:

- an explicit plan supplied in the Autoimplement input;
- a current plan found by plan discovery; and
- a plan passed by Monitor after Monitor completed the shared plan-change workflow.

When new evidence routes Autoimplement to redesign, the shared workflow receives the current plan as `previousPlan` and the new issue as evidence. A changed ready plan returns to implementation. A stopped or exhausted plan change returns blocked. The same digest must not create another decision after resume or route re-entry.

Remove Autoimplement’s duplicate approval route, approval input mapping, and replan guard. Keep only policy parsing and the mapping into the shared workflow.

## Monitor integration

Each Monitor repair that requires a new plan enters the shared plan-change workflow. This includes every exact-instructions replan requested by the operator.

A ready plan is passed to Autoimplement with its plan digest and canonical documentation state. Autoimplement treats it as selected and does not ask about it again. If Autoimplement later produces a changed plan because of implementation, review, or CI evidence, Autoimplement uses the shared workflow for that new digest.

Remove Monitor’s duplicate approval route, plan-approval input mapping, and replan guard. Keep the monitor repair authorization, no-progress protection, and post-repair observation unchanged.

## Skills and examples

Update the Autoimplement and Monitor skills with complete one-shot calls for:

- omitted approval, which uses the 10-minute autonomous default;
- `approval.mode: "required"`; and
- `approval.mode: "skip"`.

The examples must retain the required task, scope, constraints, repository, base branch, merge authority, and other workflow-specific input. They must not show a model calling the answer action for a protected human decision.

Update the workflow authoring skill and examples to explain `humanDecision().onTimeout`, timeout provenance, and the rule that only a policy-defined response can run automatically.

## Public contracts and persisted data

Change the current alpha contracts in place:

- add `onTimeout` to the public typed human-decision definition;
- add the persisted deadline and default response to the current human-decision request contract;
- add timeout-default provenance to the current accepted result, receipt, resolution, continuation, and channel settlement handling where it applies;
- add the shared `PlanApprovalPolicy` and plan-change input and output types;
- change Autoimplement and Monitor approval inputs to the shared policy; and
- keep existing camelCase JSON fields and current schema and contract identifiers.

Persisted request and resolution JSON remains under the current human-decision state root. Run bundles remain under the current run store. Add no migration reader, dual read, dual write, alias, feature flag, or new schema generation.

Increment the affected built-in revisions as one hard alpha cutover:

- Autoimplement revision 6 to 7;
- Monitor revision 7 to 8; and
- plan-approval revision 2 to 3.

Older active runs refuse resume through the existing source-change behavior. The new internal plan-change workflow does not need to be a user-facing catalog entry or skill.

## Documentation

When implementation ships, update:

- `docs/HUMAN_DECISIONS.md` for timeout responses, provenance, recovery, races, and channel behavior;
- `docs/WORKFLOW_COMPOSITION.md` for the shared plan-change workflow;
- `docs/workflows.md` for the public API and Autoimplement behavior;
- `docs/MONITOR.md` for repair-plan decisions;
- `docs/SQLITE_STATE.md` for request, resolution, continuation, and snapshot fields;
- Autoimplement and Monitor skill text and examples; and
- package examples and generated layout fixtures affected by the graph change.

Keep the previous human-decision and composition plans unchanged as historical records.

## Implementation steps

1. Add and validate the typed `humanDecision().onTimeout` contract. Bind the validated default response and absolute deadline into request identity and persisted request data.
2. Extend the human-decision store with one atomic timeout-default resolution operation. Preserve one immutable resolution and one deterministic continuation.
3. Update extension decision recovery to resolve eligible defaults, recover after restart, settle channels, and start only the owned continuation. Keep cancellation checks around resolution and continuation claims.
4. Update Pi and Telegram decision presentation and settlement so the deadline and automatic action are clear and a completed timeout closes pending views.
5. Extend plan-approval with the shared policy and explicit human, timeout, and skipped provenance.
6. Add the internal shared plan-change workflow with Autoplan, Autodoc, plan approval, and bounded exact-instructions replanning.
7. Replace the duplicate Autoimplement planning approval path with the shared workflow and gate only changed internal redesign results.
8. Replace the duplicate Monitor repair-plan approval path with the shared workflow and pass its selected plan to Autoimplement without another decision.
9. Update public exports, current schemas, built-in revisions, skills, examples, documentation, and generated fixtures.
10. Run all unit, integration, real-Pi, documentation, formatting, dependency-boundary, and package-resource checks.

## Tests

Use fake clocks, temporary directories, and fake channels. Tests must not call a real model, use a real Telegram credential, or mutate a real remote.

Cover:

- `onTimeout` type and runtime validation;
- absent timeout behavior;
- the default 10-minute deadline;
- custom positive timeout values;
- invalid timeout and response combinations;
- auto, required, and skip policy parsing;
- human continue, stop, and exact-text replan;
- human-answer and timeout-default races with each winner;
- timeout provenance without a human actor;
- late answer rejection;
- immediate terminal cancellation before and during timeout resolution;
- one continuation after concurrent or repeated recovery;
- restart recovery before and after the deadline;
- auto mode with no configured channel;
- required mode with no configured channel;
- Pi and Telegram delivery, expiry text, and settlement;
- plan digest and positive revision binding;
- no duplicate decision for the same digest;
- bounded replans;
- Autoimplement changed-plan routing;
- Autoimplement supplied and discovered plan bypass;
- Monitor repair-plan routing;
- no second decision when Monitor passes its selected plan to Autoimplement;
- later Autoimplement redesign after Monitor selection;
- built-in revision refusal for old active runs;
- package skill and workflow discovery; and
- real-Pi continuation with a short fake-clock deadline and no real model.

## Verification

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

Inspect the complete public diff before each commit, push, or pull-request update. Verify GitHub CI and Pi Reviewer before delivery.

## Boundaries

This work changes only the pi-workflows repository. It may change the workflow engine, extension decision recovery, built-in workflow composition, skills, tests, examples, fixtures, and documentation needed for this policy.

It must not:

- change Pi core or use undocumented Pi APIs;
- add a service, daemon, controller, scheduler, or persistence location;
- change external services, credentials, Telegram configuration, CI policy, or unrelated repositories;
- add a standalone plan-approval skill;
- queue, revive, or extend deferred successor turns;
- add compatibility readers, migrations, dual paths, new schema generations, aliases, or feature flags;
- merge the implementation pull request; or
- publish a package or release.
