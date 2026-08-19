---
name: autoplan
description: Use when the user asks to devise, choose, or plan the most elegant long-term production-ready solution, compare it with the ideal end state, and produce the best practical in-scope implementation plan without asking the user to resolve the gap.
compatibility: Requires Pi Workflows and the built-in autoplan workflow.
---

# Autoplan

Use the built-in `autoplan` Pi Workflow when it is available. At top level, list workflows, then start `autoplan` once with the problem, authorized scope, constraints, previous plan, and new evidence from the conversation.

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
