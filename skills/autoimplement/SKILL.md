---
name: autoimplement
description: Implements an existing plan end to end, tests it, runs pi-reviewer until no P0/P1 issues remain, and verifies CI/CD. Use only when the user explicitly asks to run autoimplement.
compatibility: Requires Pi Workflows and the built-in autoimplement workflow.
---

# Autoimplement

## Start the workflow

Use the built-in `autoimplement` workflow when it is available. At top level, list workflows, build the complete input, and start `autoimplement` once. Do not start with a partial input and repair it in later turns.

Build the input as follows:

- `task`: Preserve the user's requested end state.
- `plan`: Pass the selected plan or the full contents of its canonical plan document. Do not devise a new initial plan.
- `repository`: Use the absolute path of the repository that owns the work.
- `scope`: Always include a concrete authority statement. Name every allowed repository and the allowed edit, test, commit, push, pull-request, merge, and release actions. Carry forward exclusions from the conversation. A repository path alone is not a scope.
- `constraints`: Include all applicable user and repository constraints. Use an empty array when none apply.
- `baseBranch`: Use the requested base or the repository default branch.
- `workspaceMode`: Use `auto` unless the user or repository requires `branch`, `worktree`, or `defaultBranch`. `auto` keeps a correct task branch, creates a task branch from a clean default branch, and isolates a dirty default checkout in a standard sibling worktree. Use `defaultBranch` only with explicit direct-work authority.
- `preparedWorkspace`: Include a previously confirmed `pi-workflows.prepared-workspace.v1` result when the workspace was prepared before the run. Omit it otherwise.
- `directDefaultBranchAuthorized`: Set `true` only when direct work on the actual default branch is explicit. It does not grant commit, push, merge, or release authority.
- `merge`: Set `true` only when the user explicitly requested merge or an applicable standing instruction authorizes it. Otherwise set `false`.
- `documents`: Include known canonical plan or specification paths. Use an empty array when none are known.
- `approval`: Omit it for the default behavior: ask on each new plan and continue after 10 minutes without an answer. Use `{ "mode": "required" }` when the user says to block on plan changes. Use `{ "mode": "skip" }` when the user says to continue without asking about plan changes.
- `concurrency`: Include it only when the conversation gives explicit limits.

When one repository is clearly named, derive the scope without asking the user to restate it. A safe derived scope permits only work needed for the task in that repository, including local verification and normal branch and pull-request publication. It excludes unrelated repositories, merge, release, deployment, credentials, and policy changes unless those actions are explicitly authorized.

Replace the example values below with facts from the conversation, then make one start call:

```json
{
  "action": "start",
  "workflow": "autoimplement",
  "input": {
    "task": "Implement the selected timeout fallback plan end to end.",
    "plan": {
      "canonicalDocument": "docs/plans/timeout-fallback-plan.md",
      "summary": "Add a bounded timeout fallback.",
      "requirements": [
        "Route supported timeouts to one read-only fallback.",
        "Keep cancellation terminal."
      ],
      "verification": ["npm run check", "npm run test:e2e"]
    },
    "repository": "/absolute/path/to/repository",
    "scope": "Only /absolute/path/to/repository. May edit and test task-related files, create commits, push the task branch, and open or update its pull request. Must not modify other repositories, merge, release, deploy, change credentials, or change repository policy.",
    "constraints": ["Preserve immediate cancellation.", "Keep deferred-turn work separate."],
    "baseBranch": "main",
    "workspaceMode": "auto",
    "merge": false,
    "documents": ["docs/plans/timeout-fallback-plan.md"]
  }
}
```

### Plan-change decisions

The workflow gates only plans that it creates or changes after the run starts. A supplied or discovered existing plan does not receive another decision.

Use required approval when the user says to block on plan changes:

```json
{
  "approval": {
    "mode": "required"
  }
}
```

Skip plan decisions when the user says to accept every new plan immediately:

```json
{
  "approval": {
    "mode": "skip"
  }
}
```

Omit `approval` for autonomous mode. It asks the `operator` audience and continues with the exact presented plan after 10 minutes without an accepted answer. The workflow owns this decision. The model must not answer the protected decision through the workflow tool.

Do not manually duplicate stages already owned by the workflow. Autoimplement runs independent pi-reviewer commands, pending CI watches, and local verification commands from separate repositories in bounded batches. It keeps model turns, fixes, pushes, comment changes, merges, and releases ordered. One repository uses the same batch path with concurrency one.

When this skill is loaded inside an active workflow step, do not start another workflow. Complete the current step contract with the available tools.

Outside Pi, or when the workflow is unavailable, do the following in the order that makes sense. Choose the most efficient order for dependencies, and parallelize independent work.

0. Find the clear existing plan in the user's input, conversation, or referenced canonical documents. Do not devise an initial plan. If no clear plan exists, stop as blocked. If the plan exists but its canonical documentation is missing or stale, use `autodoc` to record it before implementation.

1. Implement the given plan end-to-end.
   - Implement the most elegant and long-term production-ready solution, but do not take longer than necessary.
   - When implementation, verification, review, or CI produces evidence that invalidates the plan, use `autoplan` with the previous plan and new evidence, then continue from the revised plan. Keep local implementation bugs in the normal fix loop.
   - Context compaction might happen during implementation or review. If not enough of the plan was preserved after compaction, re-read the written plan to stay on track with the plan.
   - Finish to completion. If there is a PR open for the implementation plan, do it in the same PR. If there is no PR already, open PR.
   - Before finishing, commit and push any new or changed documentation, specification, or plan file in the relevant repo or repos, including the `~/scratch` repo when used, unless the user asked not to.

2. Once you finish implementing, make sure to test it.
   - This will depend on the nature of the problem. If needed, run local smoke tests, spin up dev servers, make requests and such.
   - Run commands from independent repositories in a bounded batch only when their working directories are distinct and local resources can support the overlap.
   - Keep one repository's dependent checks in order. Do not batch shell wrappers, remote mutations, package publication, or commands with unclear side effects.
   - Try to test as much as possible, without merging.
   - State explicitly what could not be tested locally and what still needs staging or production verification.
   - Do not put mutation testing on the critical path unless repository policy explicitly requires it; keep the mutation test scripts available.

3. Push your latest commits before running review so the review is always against the current PR head.
   - Run pi-reviewer with its configured defaults against the base branch: `pi-reviewer --base <branch_name>`. The model and thinking level come from the reviewer's own config, not from this skill.
   - Run reviewer commands for independent repositories in one bounded batch. Keep each result tied to its repository, base branch, pushed head, and relevant dependency fingerprint.
   - In later rounds, rerun only repositories whose pushed head or relevant dependency fingerprint changed.
   - Use a 10 minute timeout for each reviewer item, not the shell `timeout` program. If pi-reviewer takes more than 10 minutes, stop that item.
   - Do not silently fall back to `codex review` when pi-reviewer is unavailable; stop and report the missing command or configuration for that repository.
   - Treat truncated reviewer output as an invalid review, never a clean result.
   - Record every review round with separate P0, P1, P2, and lower findings for each repository.
   - Run pi-reviewer in a loop and address any P0 or P1 issues until there are none left.
   - If a round reports only P2 or lower findings, address valid proportionate P2 findings, verify and push them, then move to the next stage without running pi-reviewer again solely because of that P2 work.
   - Ignore issues about supporting legacy behavior unless the plan requires compatibility.
   - Look at CI only after pi-reviewer passes, meaning the last completed run found no issues or only P2 or lower issues.

4. pi-reviewer reports findings locally and does not post them to the pull request.
   - Separately check existing inline review comments and PR issue comments, and address valid comments.
   - Ignore irrelevant comments and stale comments from before the latest commit unless they still apply.
   - Reply to and resolve each comment either way.
   - Do not wait a fixed five minutes; wait only when a required review is known to be pending, and keep that wait bounded.

5. In the final step, make sure that CI/CD is green.
   - Inspect every pull request once before deciding to wait. If waiting is useful, state the exact `gh` tracking command for each pending pull request.
   - Run supported pending CI watches in one bounded batch. Keep every result tied to its pull request and current head.
   - Bound each CI watch to five minutes. If CI is still pending, use the next model turn for additional useful local tests or smoke tests instead of waiting. Then inspect CI again.
   - Do not invent an ETA when the CI provider does not supply one.
   - Ignore the fails unrelated to your changes, others break stuff sometimes and don't fix it.
   - Make sure whatever changes you did don't break anything.
   - If CI/CD is not fully green, state explicitly which failures are unrelated and why.
   - For documentation-only changes, including SimpleDoc changes, relevant local checks are enough; do not wait for CI/CD after they pass.

6. Once CI/CD is green, or the relevant local checks have passed for a documentation-only change, decide whether merge is authorized.
   - Merge only when the user explicitly requested it or an applicable standing instruction authorizes it. Otherwise leave the PR ready.
   - Then finish and give a summary with the PR link.
   - Include the exact validation commands you ran and their outcomes.
   - Also comment a final report on the PR.

If this skill is queued many times, treat that as a reminder to make sure the work is fully finished. Once the work is fully finished, you can ignore the repeated instructions. If the work is not finished, continue working.
