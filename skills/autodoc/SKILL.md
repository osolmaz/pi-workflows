---
name: autodoc
description: Records or updates an existing selected plan in canonical documentation without implementing it. Use only when the user explicitly asks to run autodoc.
compatibility: Requires pi-workflows and the built-in autodoc workflow.
---

# Autodoc

## Start the workflow

Use the built-in `autodoc` workflow when it is available. At top level, list workflows, build the complete input, and start `autodoc` once. Do not manually duplicate stages owned by the workflow.

Build the input as follows:

- `task`: State what selected plan must be recorded and that this run is documentation-only.
- `plan`: Pass the complete selected plan. Autodoc does not devise or improve it.
- `repository`: Use the absolute path of the repository that owns the canonical documentation.
- `baseBranch`: Use the requested base or the repository default branch.
- `scope`: Name the allowed repository and documentation edits. Exclude implementation and unauthorized remote actions.
- `workspaceMode`: Use `auto` unless the conversation requires `branch`, `worktree`, or explicitly authorized `defaultBranch` work. Autodoc prepares the workspace only when documentation needs an update.
- `preparedWorkspace`: Include a previously confirmed `pi-workflows.prepared-workspace.v1` result when a parent workflow already prepared the workspace. Omit it otherwise.
- `documents`: Include every known canonical specification or plan candidate. Use an empty array when none is known.
- `evidence`: Include implementation evidence or current-document evidence when it affects whether documentation is current.

Replace the example values below with facts from the conversation, then make one start call:

```json
{
  "action": "start",
  "workflow": "autodoc",
  "input": {
    "task": "Record the selected timeout fallback plan without implementing it.",
    "plan": {
      "summary": "Add one bounded read-only timeout fallback.",
      "requirements": ["Keep cancellation terminal."]
    },
    "repository": "/absolute/path/to/repository",
    "baseBranch": "main",
    "scope": "Only /absolute/path/to/repository. May update canonical documentation and run documentation checks. Must not implement, push, merge, release, or deploy.",
    "workspaceMode": "auto",
    "documents": ["docs/plans/timeout-fallback-plan.md"],
    "evidence": {
      "currentBehavior": "A timeout ends the run."
    }
  }
}
```

When this skill is loaded inside an active workflow step, do not start another workflow. Complete the current step contract.

Autodoc records an existing selected solution or clear plan. It does not choose, devise, improve, or revise the solution. If no clear plan exists in the input, conversation, or referenced canonical documents, stop as blocked and use `autoplan` separately.

Outside Pi, or when the workflow is unavailable:

- Prepare or update the canonical plan and documentation without changing the selected solution.
- Do not take longer than necessary.
- Preserve the entropy and information in the user's request, including its intent, when writing the plan. Keep the user's concern and any specific wording that carries important meaning near the start of the document, in an introduction that clearly states its intended purpose or goal.
- Read the relevant code and existing docs before writing. Update the canonical document instead of creating competing sources of truth.
- Separate user requirements from assumptions and unresolved questions.
- In plans, state the scope, non-goals, acceptance criteria, and exact verification steps.
- If there is no plan Markdown document for the task, create one. Do not implement from this skill.
- Create or update documentation in repositories that the user authorized for documentation changes.
- For a repository outside the authorized scope, keep the plan in an approved scratch location unless the user explicitly asks to track it in that repository.
- Create or update the requisite amount of documentation in either existing files or new files in the relevant repos.
- Avoid unnecessary duplication and keep the relevant existing documentation up to date.
- When work spans repositories, keep one canonical explanation and link to it rather than copying the same text.
- After implementation, update the docs to match what actually shipped and record meaningful departures from the plan.
- Do not spend a long time updating a large set of docs only for this purpose.
- Use the `plain-writing` skill for all documentation.
- Read the SimpleDoc specification from the local checkout at `~/repos/SimpleDoc/docs/SIMPLEDOC_SPEC.md`. Do not fetch the specification or related SimpleDoc documentation from online sources.
- If `~/repos/SimpleDoc` is missing, clone `https://github.com/osolmaz/SimpleDoc.git` there, then read the specification from the local checkout. If the checkout exists, do not switch its branch or modify it only to read the specification.
- Use the `simpledoc` skill and follow the locally read SimpleDoc convention when creating or updating documentation.
- Use capitalized filenames for evergreen, long-term documentation and specifications, and dated SimpleDoc filenames for time-bound documents tied to a certain time.
- Name specification files after the feature itself without `spec` or `specification` in the filename. The document title may include `Spec` or `Specification`.
- End filenames for non-evergreen implementation plans with `-plan.md`, not `-implementation-plan.md`.
- Use `cutover` only to describe replacement behavior in prose. Do not use `cutover` or `cutover plan` in filenames, document titles, headings, plan names, issue titles, pull request titles, commit subjects, test names, or other identifiers. Name the target capability directly, adding `plan` only when a plan suffix is useful.
- Use the `kill-ai-smell` skill for capitalized evergreen documents. AI smell may remain in one-off implementation plans.
- Test commands and examples when practical.
- Never place secrets, credentials, private data, or accidental machine-specific paths in tracked documentation.
- Use `[skip ci]` in the commit message for documentation-only changes.
- Run `npx -y @simpledoc/simpledoc check` (or `simpledoc check`) locally in each repo where documentation changed.
