---
name: autoimplement
description: Use when the user asks to implement a plan end-to-end, test it, run Pi Reviewer against the base branch in a loop until no P0/P1 issues remain, and make sure CI/CD is green before finishing.
compatibility: Requires pi-workflows and the built-in autoimplement workflow.
---

Use the built-in `autoimplement` Pi Workflow when it is available. At top level, list workflows, then start `autoimplement` once with the task, existing plan, repository, scope, constraints, base branch, and merge policy from the conversation. Set `merge: true` only when the user explicitly requested merge or an applicable standing instruction authorizes it. Otherwise set it to false. Do not manually duplicate stages already owned by the workflow.

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
   - Try to test as much as possible, without merging.
   - State explicitly what could not be tested locally and what still needs staging or production verification.
   - Do not put mutation testing on the critical path unless repository policy explicitly requires it; keep the mutation test scripts available.

3. Push your latest commits before running review so the review is always against the current PR head.
   - Run Pi Reviewer with its configured defaults against the base branch: `pi-reviewer --base <branch_name>`. The model and thinking level come from the reviewer's own config, not from this skill.
   - Use a 10 minute timeout on the tool call available to the model, not the shell `timeout` program. If Pi Reviewer takes more than 10 minutes, kill it.
   - Do not silently fall back to `codex review` when Pi Reviewer is unavailable; stop and report the missing command or configuration.
   - Record every review round with separate P0, P1, P2, and lower findings.
   - Run Pi Reviewer in a loop and address any P0 or P1 issues until there are none left.
   - If a round reports only P2 or lower findings, address valid proportionate P2 findings, verify and push them, then move to the next stage without running Pi Reviewer again solely because of that P2 work.
   - Ignore issues about supporting legacy behavior unless the plan requires compatibility.
   - Look at CI only after Pi Reviewer passes, meaning the last completed run found no issues or only P2 or lower issues.

4. Pi Reviewer reports findings locally and does not post them to the pull request.
   - Separately check existing inline review comments and PR issue comments, and address valid comments.
   - Ignore irrelevant comments and stale comments from before the latest commit unless they still apply.
   - Reply to and resolve each comment either way.
   - Do not wait a fixed five minutes; wait only when a required review is known to be pending, and keep that wait bounded.

5. In the final step, make sure that CI/CD is green.
   - Inspect CI once before deciding to wait. If waiting is useful, state and run the exact `gh` tracking command.
   - Bound one CI watch to five minutes. If CI is still pending, use the next model turn for additional useful local tests or smoke tests instead of waiting. Then inspect CI again.
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
