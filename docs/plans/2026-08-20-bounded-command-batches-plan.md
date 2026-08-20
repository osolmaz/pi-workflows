---
title: Run independent commands in bounded batches
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-20
---

# Run independent commands in bounded batches

Autoimplement runs independent commands one after another today. This makes multi-repository review and CI waits take longer than needed.

Add one public `runCommandBatch` helper. Use it for independent pi-reviewer commands, pending CI watches, and independent local verification commands. Keep model turns and commands that change repositories or remote systems in their current order.

The canonical workflow behavior is in [Workflow authoring reference](../workflows.md#built-in-planning-and-implementation). Command progress follows [Workflow updates](../WORKFLOW_UPDATES.md#command-batch-updates).

## Outcome

Add one Pi-independent helper under `src/workflows`. The helper runs a validated list of commands with a fixed concurrency limit. It uses the existing `runShellAction` implementation for process creation, output capture, timeout, and process-group cleanup.

This is a function called by ordinary action nodes. It is not a workflow node, graph scheduler, fan-out primitive, controller, service, or new persistence system.

## Public contract

The public request contains a command list and one concurrency limit:

```ts
type CommandBatchItem = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
};

type CommandBatchRequest = {
  items: CommandBatchItem[];
  maxConcurrency: number;
};
```

Each item ID must be unique in the request. `cwd` must be absolute. Timeouts, output limits, item count, and concurrency must stay within package limits. Items cannot set `env`, `stdin`, `shell`, or `allowNonZeroExit`. Commands run without a shell.

The result uses the schema `pi-workflows.command-batch-result.v1`. Results stay in input order even when commands finish in a different order. Each item records:

- its ID;
- `succeeded`, `failed`, `timedOut`, or `cancelled`;
- command, arguments, and working directory;
- stdout and stderr;
- exit code and signal;
- duration;
- stdout and stderr truncation flags;
- a bounded error message when one exists.

A nonzero exit, spawn failure, or item timeout affects only that item. Invalid batch input is a batch error.

## Execution

`runCommandBatch` uses a fixed worker pool. It starts no more than `maxConcurrency` commands. Each worker checks the abort signal before it takes an item. `runShellAction` checks again before it starts the process.

The helper accepts an optional completion callback. Autoimplement uses the callback for small progress updates. The callback is observational. Its updates cannot complete a node or satisfy review, CI, or verification routing.

The helper does not interpret repository, review, CI, or test results. Autoimplement owns that meaning.

## Cancellation and interruption

The workflow action passes its abort signal to the helper. An abort stops active process groups through the existing `runShellAction` SIGTERM and bounded SIGKILL path. Workers do not start queued items after the abort.

Accepted batch outputs use the existing run trace and artifact files. Large strings use normal artifact externalization.

If the process stops before the action output is accepted, resume runs that batch again. This is allowed only for read-only reviewer and CI commands or isolated local verification commands. The first implementation does not add partial-item recovery or another store.

## Autoimplement use

### Review

Publication reports every repository with a pushed pull request:

```ts
type PublishedRepository = {
  repository: string;
  baseBranch: string;
  headRevision: string;
  pr: string;
  dependencyFingerprint?: string;
};
```

Autoimplement derives a stable item ID from the canonical repository path. It builds `pi-reviewer --base <branch>` directly from each published record and runs ready reviewer commands in one bounded batch.

Review findings stay grouped by repository ID and reviewed head. A later round runs only for a repository whose pushed head or relevant dependency fingerprint changed. P0 and P1 findings still require another review after fixes. P2-only work keeps the current rule: address proportionate findings, verify and push, then continue without another review only because of that P2 work.

### CI watches

Autoimplement first inspects every pull request without waiting. It batches only supported pending `gh pr checks --watch` or `gh run watch` commands. Each watch keeps the current five-minute limit. Results are assessed per pull request. A failed or timed-out watch does not hide results for other pull requests.

If checks remain pending, autoimplement runs other useful local tests before it inspects CI again. It does not invent an ETA.

### Local verification

The verification model step selects commands, but does not run the batch itself. Autoimplement validates the descriptors, runs one command per independent repository with a low concurrency limit, then uses a later model step to assess all results.

Verification batches reject shell wrappers, environment overrides, stdin, Git or GitHub mutation commands, package publication commands, duplicate working directories, and paths outside the reported repositories. Fixes and other model work remain outside the batch.

### Concurrency settings

Autoimplement adds optional reviewer, CI-watch, and verification concurrency settings. Existing input remains valid. One command always runs with concurrency one.

Use conservative defaults:

- reviewer: 4;
- CI watch: 4;
- verification: 2.

Cap each value at 8. Repository instructions or explicit input can lower these values.

## Progress and reporting

Each settled item can publish a metadata-only `pi-workflows.command-batch-item.v1` update. The update contains the batch kind, item ID, outcome, completed count, and total count. It does not contain stdout, stderr, environment data, credentials, or private provider payloads.

Only the accepted action output controls routing. Final reports group review, CI, and verification evidence by repository and revision. Single-repository reports keep their current fields and meaning.

Reviewer or CI output that reaches its capture limit is incomplete. Autoimplement must not classify truncated output as clean.

## Implementation

1. Add command-batch types, validation, worker-pool execution, per-item results, truncation flags, cancellation, and the completion callback in `src/workflows/command-batch.ts`.
2. Export the public helper and types from `src/workflows/index.ts`.
3. Add an internal truncation check in `src/workflows/shell.ts` without changing `ShellActionResult` or singular shell output.
4. Add autoimplement-only publication normalization, command validation, stable repository IDs, and concurrency parsing in `src/builtins/autoimplement-command-batches.ts` when separation keeps the main workflow clear.
5. Refactor `src/builtins/autoimplement.workflow.ts` to use batch actions for review, pending CI watches, and independent verification.
6. Remove the superseded singular reviewer and CI-watch paths in the same change.
7. Add `examples/workflows/command-batch.workflow.ts` and update the bundled autoimplement skill.
8. Bump the built-in autoimplement revision from 4 to 5 in `src/builtins/catalog.ts`.

## Tests

Add `test/command-batch.test.ts` for:

- descriptor validation and bounds;
- empty and one-item requests;
- deterministic input-order results;
- measured concurrency limits;
- mixed success and failure;
- spawn failure and nonzero exit;
- per-item timeout;
- abort before and during execution;
- no queued starts after abort;
- process-group cleanup;
- output limits, truncation flags, and UTF-8;
- completion callback behavior.

Update autoimplement tests for:

- current single-repository input and output;
- one and several published repositories;
- parallel reviewer execution and isolated findings;
- changed-head and dependency-fingerprint reruns;
- P0, P1, P2, lower, command failure, timeout, and truncation;
- parallel pending CI watches and per-PR assessment;
- independent verification and its lower limit;
- unsafe verification command rejection;
- accepted-output resume and full replay of an unaccepted batch;
- metadata-only progress updates;
- built-in revision 5 and old active-run refusal.

Use temporary repositories and fake `pi-reviewer` and `gh` commands in end-to-end tests. Do not call a real model or mutate a remote system.

## Verification

Run these checks before completion:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
```

Keep coverage at or above 85 percent. Verify discovery through a fresh Pi process and the installed package path.

## Rollout

Keep the command-batch result and update schemas at v1 during alpha. Use a hard cutover. Do not keep singular reviewer or CI-watch execution beside the batch path. Do not add migration readers, dual paths, aliases, or feature flags.

The autoimplement built-in revision changes from 4 to 5. Active runs from revision 4 must start again. Terminal bundles remain readable.

Do not publish a package or create a release without separate authorization.

## Boundaries

- Do not add a workflow-engine primitive.
- Do not add a controller, child workflow, service, database, queue, webhook receiver, distributed worker, or artifact store.
- Do not parallelize model turns, code edits, comment fixes, pushes, pull request mutations, merges, releases, or rollbacks.
- Do not add a full multi-repository campaign or target graph.
- Do not add partial-item durable recovery until measured replay cost justifies it.
- Do not infer command independence, dependency relations, resource limits, remote authority, or CI ETA.
- Do not change Pi core, private Pi APIs, external tools, providers, credentials, or repository policy.

## Contract impact

- **Session state:** normal workflow messages and tool results only.
- **Other persistent data:** normal node outputs, updates, trace records, and artifacts in existing run bundles.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension APIs only.
- **Public Pi Workflows API:** new `runCommandBatch` helper and command-batch types; existing action, update, shell, timeout, and cancellation interfaces.
