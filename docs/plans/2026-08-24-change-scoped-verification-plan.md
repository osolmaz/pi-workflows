---
title: Make Autoimplement verification change-scoped
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-24
---

# Make Autoimplement verification change-scoped

Autoimplement and Autodoc must judge the current change, not the complete health of the repository. A check failure that already exists on the base branch must stay visible, but it must not stop unrelated work. A new failure caused by the current change must enter a bounded fix-and-check loop.

Known commands and safe mechanical fixes must run as program actions. The model must handle only work that needs judgment, such as proposing a branch name, editing prose, changing code, or classifying evidence that a direct comparison cannot settle.

This plan also fixes the related workflow problems found during the failed Autoimplement run on 2026-08-24:

- documentation verification returns one Boolean result;
- a documentation failure stops without a repair loop;
- an included Autodoc blocker bypasses Autoimplement's blocker challenge;
- documentation can change before Autoimplement selects a safe workspace;
- the same model can edit documents and run deterministic checks;
- repository-wide failures are not compared with the base branch;
- the final blocked result can lose the original reason and evidence;
- ordinary node failures can stop without safe recovery;
- a mistaken missing-plan result can stop without challenge; and
- documentation failure has no clear handoff back to implementation.

The failed SimpleDoc check that exposed these problems was unchanged on the candidate and a clean `origin/main` worktree. It reported the same 30 renames, 32 frontmatter insertions, and 8 reference updates in both places. Formatting, links, privacy, whitespace, and changed-file digests passed. Autoimplement should have reported the SimpleDoc backlog and continued.

## Goal

Add two reusable internal workflow compositions:

1. workspace preparation, which selects and confirms where edits will happen; and
2. change verification, which runs checks, compares eligible failures with the base branch, repairs current-change failures, and preserves exact evidence.

Use them in Autodoc first. Then apply the same result and routing rules to Autoimplement's local checks, review commands, CI inspection, and delivery. Keep each stage's external actions separate. Do not add a general effect runner or a workflow-engine primitive.

## Principles

- Prepare the workspace before the first edit.
- Let the model propose names and make semantic decisions.
- Let program actions run Git commands, checks, comparisons, and safe mechanical fixes.
- Judge failures against the current change.
- Keep all base failures visible.
- Repair new failures within a fixed limit.
- Challenge every claimed blocker except explicit cancellation and verified human rejection.
- Observe a possible partial effect before retrying a mutating step.
- Keep the graph explicit, durable, bounded, and easy to inspect.

## Workspace selection

Autoimplement gains a `workspaceMode` input with these values:

- `auto`: select the safest allowed mode from the current repository state and authority;
- `branch`: work in the current checkout on a task branch;
- `worktree`: work in a standard sibling worktree on a task branch; and
- `defaultBranch`: work directly on the repository's real default branch.

`auto` is the default. It follows these rules:

1. Keep the current branch when it is already the correct non-default task branch.
2. For a clean default branch, ask the workspace-planning model for a clear task branch name, then create or confirm that branch programmatically.
3. When unrelated changes must remain in the current checkout, ask for a task branch name and create a standard sibling worktree programmatically.
4. Use `defaultBranch` only when the task authority or repository policy explicitly permits direct work on the default branch.

For `branch` and `worktree`, the model proposes the branch name. A program action validates and applies the proposal. Validation rejects an empty name, an invalid Git reference, a reserved or conflicting name, the wrong base, a path outside the standard worktree location, and a proposal that would move or overwrite existing work.

For `defaultBranch`, no task branch or worktree is created. A program action confirms all of these facts before mutation:

- the checked-out branch is the repository's actual default branch;
- direct default-branch work is authorized by the request or repository policy;
- the expected base revision is current;
- existing unrelated changes will not be overwritten or included; and
- later commit and push actions stay within their separate authority.

Working directly on the default branch does not imply commit, push, merge, release, or deployment authority. Delivery must support a direct-default result: commit and push only when authorized, otherwise leave the verified local change and report it. It must not try to open a pull request from the default branch to itself.

The workspace result becomes the source of truth for later paths. It records:

- mode;
- repository path;
- worktree path when applicable;
- base branch and base revision;
- work branch;
- whether direct default-branch work is authorized;
- pre-existing changed paths;
- creation or adoption evidence; and
- the scope that later stages may change.

All later prompts and actions use the prepared absolute path. They do not fall back to the Pi process working directory.

## Programmatic checks

Known checks run through action or shell nodes. The model does not run them through tools inside an agent step.

Each check request records:

- a stable ID;
- executable and argument array;
- absolute working directory;
- timeout;
- output limit;
- whether the command is read-only;
- whether it is eligible for base comparison;
- whether it supports changed-file scope; and
- the finding format when the tool provides one.

A command request cannot use a shell wrapper, hidden environment changes, standard input, or an unbounded timeout. Verification records the exit code, signal, duration, stdout, stderr, truncation state, timeout state, and spawn failure. A truncated or incomplete result cannot pass.

Repository guidance remains the first source for command selection. If it gives a complete command list, the workflow uses it without a model turn. If it does not, one model step proposes a structured command plan. Program code validates that plan before execution.

## Candidate and base comparison

When a repository-wide read-only check fails and the output does not prove that the current change caused it, change verification runs the same command on a temporary detached worktree at the selected base revision.

The base action must:

1. create a temporary worktree outside the candidate checkout;
2. run only checks marked read-only and base-eligible;
3. use the same executable, arguments, timeout, and output limit;
4. record setup and dependency limitations;
5. remove the temporary worktree in a bounded cleanup path; and
6. preserve cleanup evidence if removal fails.

Comparison first uses stable finding IDs when a tool provides them. Otherwise it normalizes only line endings and the temporary worktree path. It does not remove timestamps, counts, file names, or other facts merely to make outputs match.

The result separates:

- `relatedFailures`: new failures caused by the candidate change;
- `unrelatedFailures`: matching failures already present on the base;
- `fixedBaselineFailures`: base failures that the candidate removes;
- `unknownFailures`: differences that available evidence cannot attribute safely;
- `untestedChecks`: checks that could not produce complete evidence; and
- the complete candidate and base command results.

Unrelated failures are reported but do not fail the current change. Unknown failures require bounded model judgment or blocker challenge. A `ready` result requires complete candidate checks and no related or unknown failure.

## Repair and recheck

A change-related failure enters a bounded repair loop. Start with two repair attempts. Keep the limit explicit in the workflow graph.

Mechanical repair is allowed only when the command plan declares:

- the direct executable and arguments;
- the exact changed files it may edit;
- the check IDs it is expected to fix;
- its timeout; and
- the expected type of diff.

The action records the diff before and after the fixer. It rejects an edit outside the declared files. It does not infer or run a broad repository migration such as applying all SimpleDoc recommendations to an old repository.

When no safe mechanical fix exists, a model repair step receives the approved plan plus related and unknown failures. It does not receive unrelated failures as work to fix. It may make semantic documentation or code changes only inside the prepared workspace and declared scope.

After each repair, the same programmatic checks run again. Stop the loop when:

- verification succeeds;
- the repair makes no diff;
- the failure fingerprint repeats; or
- the attempt limit is reached.

An exhausted repair loop creates a complete blocker claim and goes to blocker challenge. It does not stop directly.

## Shared verification result

Replace stage-specific Boolean results with one internal result shape. It uses these routes:

- `ready`: all current-change checks passed;
- `repairable`: a safe repair path exists;
- `needsJudgment`: evidence is complete but attribution or repair needs model judgment; and
- `blocked`: a material outside-scope problem remains after safe recovery.

The result records:

- originating workflow and qualified node;
- current workspace identity;
- changed files;
- candidate commands;
- base commands;
- related, unrelated, fixed, unknown, and untested findings;
- repair attempts and failure fingerprints;
- output references;
- reason; and
- concrete evidence.

Keep large command output in the existing action result and refer to it from findings. Do not copy large output into each failure entry.

## Autodoc changes

Autodoc keeps model steps for these tasks:

- finding or confirming the selected plan;
- choosing canonical documentation;
- writing or updating prose; and
- repairing semantic documentation failures.

Autodoc uses program steps for:

- workspace preparation when an update is required;
- documentation checks;
- base comparison;
- safe mechanical fixes;
- result classification when exact comparison is sufficient; and
- graph routing.

Replace `verifyDocumentation` and its `passed` Boolean with the shared change-verification composition. A matching base SimpleDoc failure returns `ready` with visible unrelated failures. A new documentation failure enters repair and recheck.

Autodoc's blocked exit must preserve the originating node, exact command evidence, related and unrelated failures, all repair attempts, and the accepted reason. Its blocked reason must not ignore verification output.

## Autoimplement changes

Run workspace preparation before the first edit-capable node. Read-only plan discovery may run first. Documentation updates and implementation must use the prepared workspace.

Route these blocker sources through one challenge path:

- included Autodoc blocked exits;
- missing-plan claims;
- implementation classification;
- local verification;
- review command failures;
- review findings that claim an external block;
- CI inspection and CI command failures;
- delivery failures;
- exhausted repair loops; and
- ordinary node execution failures that safe recovery cannot resolve.

Explicit cancellation and verified human rejection remain terminal and bypass challenge.

A mistaken missing-plan claim may return to bounded discovery or adopt a plan already proved by the input or canonical documents. The challenge cannot invent an initial plan.

The blocker challenge must return the next practical stage, such as plan discovery, documentation, implementation, repair, review, CI inspection, delivery, redesign, or terminal blocked. A stable counter and failure fingerprint prevent loops.

## Ordinary node failures

Extend the current timeout fallback into one bounded step-failure recovery path. Classify workflow steps as:

- pure;
- read-only;
- idempotent mutation; or
- mutation that needs observation before retry.

Pure and read-only failures can retry within the limit. For a mutating step, inspect durable repository or remote state first. Adopt an effect that already completed. Retry only the missing effect. Send an unsupported or ambiguous effect to blocker challenge with exact evidence.

This policy applies to both timeouts and ordinary failed outcomes. It never recovers explicit cancellation.

Examples:

- inspect the current diff before repeating a model edit;
- inspect commits before repeating a commit;
- inspect the remote branch after a lost push response;
- inspect existing comments before posting again;
- inspect merge state before repeating merge; and
- inspect recorded action output before rerunning a command batch.

## Later Autoimplement stages

Apply the same related, unrelated, unknown, repairable, and blocked meanings to:

- local verification;
- reviewer command execution;
- CI inspection; and
- delivery verification.

Keep separate adapters for local commands, reviewer output, CI providers, pull-request comments, commits, pushes, and merges. Do not place all effects behind one universal runner.

CI failures that predate the candidate or belong to an unrelated target remain visible and do not fail the current change. When local reproduction is not possible, use provider evidence and model judgment. Never classify an unavailable or truncated result as unrelated automatically.

## Blocker evidence

Create a durable blocker claim before challenge. It records:

- qualified source node;
- node attempt ID;
- current route;
- exact reason;
- evidence references;
- failed commands;
- related and unrelated failures;
- recovery attempts;
- alternatives checked; and
- the authority or external fact that could prevent progress.

Parent workflows preserve included child evidence. The final blocked result uses the accepted claim directly. It must not replace available evidence with a generic reason or `null`.

## Implementation order

Implement the change in these complete slices:

1. Add the regression for the 2026-08-24 SimpleDoc incident.
2. Add shared types, validation, finding comparison, and evidence helpers.
3. Add workspace planning and programmatic workspace preparation with all four modes.
4. Add candidate checks, base checks, comparison, and temporary worktree cleanup.
5. Add mechanical and semantic repair with bounded recheck.
6. Migrate Autodoc and remove the Boolean verification route.
7. Put workspace preparation before Autoimplement mutation and pass its path to every later stage.
8. Route all blocker claims through one challenge and preserve qualified child evidence.
9. Extend timeout fallback to safe ordinary-failure recovery.
10. Apply the shared verification meanings to local checks, review, CI, and delivery.
11. Update skills, workflow documentation, examples, and built-in revision data.
12. Run focused, full, persistence, and real-Pi tests before release.

Each slice must compile and pass its focused tests. Use a hard replacement during alpha. Do not keep the old Boolean route, duplicate verification path, compatibility alias, or feature flag.

## Tests

### Workspace

- A clean default branch in `auto` mode gets an LLM-proposed, programmatically created task branch.
- An existing correct task branch is adopted without creating another branch.
- A dirty default checkout gets an LLM-proposed branch in a standard sibling worktree.
- Explicit `branch` and `worktree` modes use the proposed name only after programmatic validation.
- `defaultBranch` succeeds only with direct-work authority and the actual default branch checked out.
- `defaultBranch` does not imply commit or push authority and never opens a pull request to itself.
- Detached HEAD, wrong base, invalid name, name conflict, hook failure, and worktree cleanup failure preserve evidence and route safely.
- Existing user changes are never stashed, reset, moved, overwritten, or included.
- Restart adopts the same prepared workspace instead of creating another one.

### Verification

- All candidate checks pass.
- Candidate and base fail with the same SimpleDoc backlog; the run reports it as unrelated and continues.
- A candidate-only documentation failure is related.
- A base-only failure is recorded as fixed by the candidate.
- Base setup or command failure stays unknown.
- Timeout, spawn failure, cancellation, and output truncation cannot pass.
- Finding order and temporary worktree paths do not cause false differences.
- Only read-only base-eligible checks run on the base.
- Temporary base worktrees are cleaned after success, failure, restart, and cancellation.

### Repair

- An allowlisted formatter changes only declared files and verification then passes.
- A fixer that changes an undeclared file is rejected with the diff preserved as evidence.
- A broad repository migration is not run automatically.
- Semantic repair sees related and unknown failures, not unrelated backlog.
- No diff, repeated fingerprint, and attempt exhaustion stop the loop and enter blocker challenge.

### Routing and evidence

- An included Autodoc blocker reaches the shared challenge.
- A mistaken missing-plan claim retries discovery or adopts proved input without inventing a plan.
- Every non-exempt blocker source reaches challenge.
- Explicit cancellation and verified human rejection stay terminal.
- Qualified child evidence survives composition, restart, and final presentation.
- The final blocked result names the source node, commands, reason, evidence, and recovery attempts.

### Failure recovery

- Safe read-only and pure steps retry within the limit.
- A partial local edit is inspected before continuation.
- A lost push or comment response is adopted when the remote effect exists.
- An uncertain consequential effect is not replayed blindly.
- Repeated failures stop at the bounded challenge path.
- Existing timeout behavior remains covered by the new general path.

### Complete workflow

- A real-Pi Autoimplement fixture with a matching base SimpleDoc failure reaches implementation.
- A change-related documentation failure is repaired and rechecked.
- A true repository-rule or authority blocker ends with complete evidence.
- Documentation, local checks, review, CI, and delivery use the same failure meanings.
- Old terminal run data remains readable.
- Active runs with an incompatible built-in revision refuse unsafe resume.

## Acceptance criteria

- No edit-capable node runs before workspace confirmation.
- The model proposes every new branch name; program actions validate and create branches and worktrees.
- `auto`, `branch`, `worktree`, and `defaultBranch` modes work as specified.
- Known checks and mechanical fixes run programmatically.
- Candidate and base results are recorded separately.
- Matching base failures remain visible and do not block the current change.
- New failures enter a bounded repair and recheck loop.
- No included blocker bypasses challenge.
- Missing-plan and ordinary-failure claims have bounded recovery.
- Final blocked results preserve the original reason and evidence.
- The same policy applies to documentation, local verification, review, CI, and delivery.
- The implementation uses existing workflow primitives and adds no Pi core change or engine primitive.
- Full repository and real-Pi tests pass.

## Rollout

This is a hard built-in replacement under the alpha policy.

Land the pure contracts and tests first. Then land workspace preparation, Autodoc migration, Autoimplement blocker and failure recovery, and later-stage adapters in that order. Keep each commit complete and reversible.

Finish or cancel active runs that use the old built-in definitions before package reload. Old terminal runs remain readable. An active run with an incompatible source revision continues to use the existing revision guard and must restart rather than mixing graphs.

After implementation, update [Workflow authoring reference](../workflows.md), [Workflow composition](../WORKFLOW_COMPOSITION.md), the Autoimplement and Autodoc skills, examples, and built-in revision records. Reload or restart Pi and verify discovery through the installed package path.

Do not release or deploy this change without separate authority.

## Boundaries

- Do not modify Pi core or use a private Pi API.
- Do not add a workflow-engine primitive, hidden retry, service, database, daemon, or external store.
- Do not change SimpleDoc, Git, GitHub, CI provider, or target repository behavior.
- Do not require repositories to add a machine-readable quality manifest.
- Do not run broad repository migrations automatically.
- Do not use the model for deterministic command execution, counting, comparison, or routing.
- Do not hide baseline, nonzero, unknown, or truncated command results.
- Do not overwrite, stash, reset, or silently move existing user work.
- Do not merge different remote effects into one universal runner.
- Do not preserve the superseded alpha behavior through compatibility code.

## Contract impact

- **Session state:** normal workflow prompts, action results, model results, and final presentation only.
- **Other persistent data:** normal node outputs in the existing SQLite state. No new persistence location.
- **Pi internals:** none.
- **Public Pi API:** existing documented extension and tool interfaces only.
- **Autoimplement input:** add optional `workspaceMode` with `auto`, `branch`, `worktree`, and `defaultBranch`. Omission means `auto`.
- **Autodoc input:** add optional base, scope, workspace mode, and prepared-workspace fields so standalone and included runs use the same safety rules.
- **Public pi-workflows API:** existing `agent`, `action`, `shell`, `compute`, `includeWorkflow`, named exits, structured outputs, command batches, and edge routing. Shared verification and workspace result contracts remain internal unless later use proves a public need.

## Related plans

- [Confirm blockers before autoimplement stops](2026-08-20-autoimplement-blocker-challenge-plan.md)
- [Run independent commands in bounded batches](2026-08-20-bounded-command-batches-plan.md)
- [Add Autoimplement timeout fallback](2026-08-21-autoimplement-timeout-fallback-plan.md)
- [Add shared plan-change approval](2026-08-21-plan-change-approval-policy-plan.md)
