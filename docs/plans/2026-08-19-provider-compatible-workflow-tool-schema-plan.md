---
title: Provider-compatible workflow tool schema plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-19
---

# Provider-compatible workflow tool schema plan

## Goal

Fix the workflow tool schema so strict OpenAI-compatible providers accept it without weakening action validation. Apply the fix to the interactive Pi extension and the headless RPC bridge in PR #33.

## Requirements

- Every provider-facing tool schema has `type: "object"` at its root.
- Provider-facing schemas do not use root unions or conditional object schemas.
- Each action keeps its current required fields and rejects fields for other actions.
- The exact action schemas remain the source for TypeScript types and runtime validation.
- Invalid input is rejected before workflow state changes or RPC output.
- The existing action names and input fields do not change.

## Implementation

1. Define the exact action object schemas in a shared, Pi-independent workflow module.
2. Build the interactive and submission-only schemas from those action objects.
3. Generate flat provider-facing object schemas from the same action definitions.
4. Parse each tool call against the exact action schema before dispatch.
5. Use the shared submission schema in the RPC bridge.
6. Add unit tests for valid actions, missing fields, wrong-action fields, nested update data, and both provider schema roots.
7. Add an integration test that sends the schemas through Pi's OpenAI Completions adapter to a strict local endpoint.

## Non-goals

- Do not change Pi core or provider adapters.
- Do not add provider-specific branches.
- Do not add a schema version, new action format, or compatibility path.
- Do not change persisted workflow data.

## Acceptance

- The strict local endpoint accepts both workflow tool schemas.
- Runtime parsing rejects malformed calls before execution.
- `npm run check`, `npm run test:e2e`, Rust tests, Slophammer checks, and `git diff --check` pass.
- pi-reviewer reports no P0 or P1 findings.
- PR #33 CI passes before merge.
