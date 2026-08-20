---
title: Confirm blockers before autoimplement stops
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-20
---

# Confirm blockers before autoimplement stops

Autoimplement must not stop only because one model says that work is blocked. A separate agent must challenge the claim and confirm that the blocker is real before the workflow uses its terminal blocked result.

The canonical workflow behavior is in [Workflow authoring reference](../workflows.md#built-in-planning-and-implementation).

## Outcome

Add one independent `challengeBlocker` agent node to the built-in autoimplement workflow. Use only existing public pi-workflows primitives. Keep the graph explicit and reuse the existing redesign include and terminal blocked result.

The challenge asks these questions in plain terms:

- Are you really blocked?
- Is this really a blocker right now?
- Can you find a safe way to move forward and finish this?
- Are you getting stuck on something trivial, procedural, reversible, or already authorized?

The challenge inspects the task, approved plan, current result, evidence, scope, authority, previous attempts, and viable alternatives. It distinguishes a true external blocker from normal rollout work, local implementation work, a design adjustment, a missing verification step, or a reversible operational task.

## Output and validation

The challenge returns this bounded structured output:

```json
{
  "route": "continue | blocked",
  "blockingNow": true,
  "outsideAuthority": true,
  "canProceed": false,
  "reason": "concise reason",
  "nextAction": "",
  "alternativesChecked": ["checked alternative"],
  "evidence": ["concrete evidence"]
}
```

A terminal blocked result is valid only when all these conditions hold:

- `route` is `blocked`.
- `blockingNow` is `true`.
- `outsideAuthority` is `true`.
- `canProceed` is `false`.
- `nextAction` is empty.
- `alternativesChecked` contains checked practical alternatives.
- `evidence` contains concrete evidence.

A `continue` result must name the next practical action. Contradictory output, such as `route: blocked` with `canProceed: true`, cannot route to the terminal blocked result.

Keep the output concise and bounded.

## Routing

Route `classifyImplementation.blocked` to `challengeBlocker`. A `continue` challenge result routes to the existing redesign include. Redesign can revise and document the plan, then return through implementation, verification, review, comment handling, CI, and delivery. A valid `blocked` result routes to the existing terminal blocked result.

Inspect each later model-produced blocked exit in verification, review, comment handling, CI, delivery, and equivalent current nodes. Route operational or model-judged blockers through the same challenge when it is safe. Use one reusable challenge node and existing edges or includes. Do not copy the prompt into several nodes and do not add an engine-level blocker feature.

Preserve direct terminal stops for these hard boundaries:

- an explicit human stop;
- cancellation;
- an exhausted workflow safety or replan limit;
- a protected authorization gap;
- an independent blocked result from redesign when another challenge could make an unsafe or unbounded loop.

Limit blocker challenges to three attempts in one run. Include all earlier challenge outputs in each later challenge prompt. If a fourth challenge would be needed, stop with the normal safety-limit reason. Do not repeat an unsupported blocker assertion.

Include the latest challenge output in the workflow's latest-issue or context helper. A later redesign must receive the rejected blocker, its evidence, and its required next action.

## Required behavior

A supported cutover does not become blocked only because an artifact has an ownership or packaging mismatch. In the Bob artifact incident, authorized deployment and rollback make the safe rollout work part of the task. The challenge must return `continue`, name the next rollout action, and route to redesign.

A missing external authorization for a prohibited remote mutation can remain blocked when no non-mutating path completes the task.

A local test failure, stale package, packaging mismatch, rollback preparation, or deployment procedure is not, by itself, outside the granted authority.

## Tests

Add focused tests in `test/builtin-autoimplement.test.ts` or the best current autoimplement test file. Prove all these cases:

1. A false blocker routes to redesign and continued work.
2. A confirmed blocker reaches the terminal blocked result.
3. Contradictory blocked output is rejected or cannot route to the terminal blocked result.
4. The Bob artifact-ownership mismatch returns `continue` when rollout is authorized.
5. An explicit human stop bypasses the challenge.
6. A protected authorization gap remains a hard stop.
7. An independent `redesign.blocked` path does not create a loop.
8. Earlier challenge context is present and the three-attempt bound works.
9. All relevant late-stage model-generated blocker routes use the challenge.
10. Normal success paths remain unchanged.

Keep compute nodes pure. Put the independent reasoning in the challenge agent node.

## Documentation

Update `docs/workflows.md` with the blocker-confirmation rule, hard-stop exceptions, and bounded routing. Keep the public behavior concise. Do not add internal details that users do not need.

## Verification

Run focused tests during development. Before completion, run these exact checks:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
```

Verify discovery and behavior through the installed package path or the repository's supported real-Pi end-to-end path. A fresh Pi process is required because built-in discovery is process-local.

Review the final diff for missing blocker routes, accidental unbounded loops, and false terminal blockers. Fix each valid finding.

## Boundaries

- Preserve current run-bundle schemas unless a schema change is required. Do not add a persistence layer.
- Use existing public pi-workflows primitives only. Do not change Pi core.
- Keep explicit human and protected authorization boundaries intact.
- Use a hard cutover. Do not retain a legacy blocker route.
- Preserve unrelated work and do not modify other repositories.
- Make only the smallest source-based adjustment needed to preserve the approved behavior.
- Do not stop for a trivial, reversible, or already authorized issue.
- Commit coherent changes with a Conventional Commit message and push after all checks pass.
- Do not publish a package, create a release, or merge anything.

## Contract impact

- **Session state:** normal workflow messages and tool results only.
- **Other persistent data:** none beyond the existing run bundle records for normal node outputs.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension APIs only.
- **Public pi-workflows API:** existing agent, compute, edge, and included-workflow primitives only.
