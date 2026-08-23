---
name: sanity-check
description: Use when the user asks for a read-only sanity check of a repository contribution, including whether it is necessary, duplicates existing code, adds justified contracts, or has proportionate scope and tests. Starts the built-in sanity-check workflow and returns an evidence-backed keep, simplify, refactor, drop, or needs-evidence verdict.
compatibility: Requires pi-workflows and the built-in sanity-check workflow.
---

# Sanity Check

## Start the workflow

Use the built-in `sanity-check` workflow when it is available. At top level, list workflows, build the complete input, and start `sanity-check` once.

The workflow reviews the repository of the current Pi session. Before starting, confirm that Pi's current working directory is inside the repository that owns the contribution. Do not claim to check a different repository. If the current directory is wrong, start or use a Pi session in the correct repository first.

Build the input as follows:

- `mode`: Use `serial` unless the user explicitly requests parallel review. Serial mode reviews all four areas in one isolated session. Parallel mode runs one isolated review per area with concurrency four. Both modes run a separate verification review.
- `baseRef`: Use the requested base Git reference. When the base is clear, pass it explicitly, such as `origin/main`. Omit it only when the workflow should derive the base from `origin/HEAD`, the current branch upstream, or `HEAD^`.

Replace the example values below with facts from the conversation, then make one start call:

```json
{
  "action": "start",
  "workflow": "sanity-check",
  "input": {
    "mode": "serial",
    "baseRef": "origin/main"
  }
}
```

The workflow is read-only. It collects committed and working-tree evidence, reads matching pull-request metadata when available, runs isolated reviews, and verifies their claims. It then shows the full detailed report as a normal assistant message, followed by a short plain-language assistant summary. The strict verified verdict remains the workflow result. It does not edit files, post comments, or fix findings.

When this skill is loaded inside an active workflow step, do not start another workflow. Complete the current step contract.

Outside Pi, or when the workflow is unavailable:

1. Collect the committed diff from the selected base through `HEAD`, the working-tree diff, untracked files, and matching pull-request context.
2. Review necessity, duplication, contracts, and scope and tests.
3. For each area, report pass, concern, or unclear with exact file and symbol evidence.
4. State the strongest evidence-based case for accepting the contribution.
5. Verify the findings, remove unsupported claims, and return keep, simplify, refactor, drop, or needs evidence.
6. Stay read-only unless the user separately asks to implement the required changes.
