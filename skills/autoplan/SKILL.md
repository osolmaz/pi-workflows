---
name: autoplan
description: Use when the user asks to devise, choose, or plan the most elegant long-term production-ready solution, compare it with the ideal end state, and produce the best practical in-scope implementation plan without asking the user to resolve the gap.
compatibility: Requires pi-workflows and the built-in autoplan workflow.
---

# Autoplan

## Start the workflow

Use the built-in `autoplan` workflow when it is available. At top level, list workflows, build the complete input, and start `autoplan` once.

Build the input as follows:

- `problem`: State the decision or implementation-planning problem and its observable end state.
- `scope`: Name the repositories, systems, and interfaces that may change. State important exclusions. Derive an unambiguous repository-local scope without asking the user to restate it.
- `constraints`: Preserve all user, repository, safety, compatibility, cost, and authority limits. Use an empty array when none apply.
- `previousPlan`: Include it only when revising an existing plan.
- `newEvidence`: Include it only when evidence caused the revision request.

Replace the example values below with facts from the conversation, then make one start call:

```json
{
  "action": "start",
  "workflow": "autoplan",
  "input": {
    "problem": "Choose a production-ready timeout fallback and write its implementation plan.",
    "scope": "Only /absolute/path/to/repository. Plan changes to its public workflow API, built-in workflow, tests, and documentation. Exclude Pi core, external services, credentials, releases, and unrelated repositories.",
    "constraints": ["Keep cancellation terminal.", "Use only documented public interfaces."]
  }
}
```

When this skill is loaded inside an active workflow step, do not start another workflow. Complete the current step contract.

Outside Pi, or when the workflow is unavailable:

1. Frame the problem, observable success criteria, scope, constraints, and interfaces under our control.
2. Devise the most elegant long-term production-ready solution within that scope.
3. Describe the holy grail separately. Name every dependency outside our authority.
4. Choose the right option without asking the user to decide between them.
   - Choose the ideal when it is proportionate, production-ready, in scope, and implementable through interfaces we control.
   - Otherwise choose the strongest practical in-scope solution with a clear path toward the ideal.
   - Do not block only because the ideal requires an upstream or external change.
5. Write a detailed implementation plan. For each step, state what changes, where it changes, and how to verify it.
6. Stop as blocked only when no truthful in-scope solution can meet the success criteria.

When revising a plan, preserve the previous plan and new evidence. State whether the plan changed and why. Do not implement unless the user also requested implementation.
