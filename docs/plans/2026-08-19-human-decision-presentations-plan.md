---
title: Add readable human decision presentations
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-19
---

# Add readable human decision presentations

pi-workflows currently sends a structured human decision body to Telegram with
`JSON.stringify()`. A plan approval therefore reaches the operator as machine
JSON. Pi also shows only the decision title in its basic selection prompt.

The operator must receive clear text in every channel. Structured data must
remain the durable source for validation, routing, and audit evidence. The
[human decision presentations specification](../HUMAN_DECISION_PRESENTATIONS.md)
defines the selected contract.

## Outcome

Add one versioned, channel-independent presentation format beside the canonical
subject. Pi and Telegram render the same complete content with their own native
layout. The visible presentation and machine subject are both bound to the
accepted decision.

The design uses the existing checkpoint engine, decision store, channel
interface, and documented Pi extension APIs. It does not require Pi core,
another service, or a Telegram change.

## Scope

- Add `DecisionPresentation v1` and `HumanDecisionRequest v2` schemas and types.
- Add deterministic presentation normalization and digests.
- Keep the current typed subject as machine truth.
- Require an explicit presentation for new structured subjects.
- Add a reusable plan presenter.
- Render complete readable messages in Pi and Telegram.
- Add durable multipart delivery evidence and safe recovery.
- Update TypeScript and Rust viewers.
- Preserve v1 definitions and immutable run bundles.

## Non-goals

- Do not modify Pi core or use undocumented Pi APIs.
- Do not change Telegram or create a delivery relay.
- Do not add a template language or general rich text system.
- Do not derive new operator text from arbitrary v2 subject data.
- Do not rewrite v1 requests, accepted answers, or run bundles.
- Do not store Telegram identifiers or credentials in public durable records.

## Implementation

### 1. Add the durable contracts

Create schemas and TypeScript types for the presentation, v2 request, and
multipart delivery evidence. Keep all v1 schemas and readers unchanged.

Generate and validate canonical examples. Reject unknown blocks, object-valued
display fields, missing summaries, missing presentations, and excessive
content.

### 2. Add deterministic normalization

Add a workflow-core module that validates the flat presentation blocks,
normalizes line endings, enforces the specification limits, and computes the
presentation digest. Keep it independent of Pi and Telegram.

Add a v1 compatibility presenter. A string body becomes a paragraph. An object
body becomes readable sections, labels, fields, and lists in stable key order.
The adapter reads only the historical display body.

### 3. Update the authoring API and request identity

Add the preferred `subject` plus `presentation` request form. Keep the current
`body` form as a deprecated compatibility overload. The preferred form fails
validation when either value is missing.

For v2, compute separate subject and presentation digests and bind the request
revision, subject, visible presentation, choices, and input prompts into the
overall request digest. Select the v1 or v2 digest algorithm from the stored
request schema.

### 4. Add the plan presenter

Create one reusable presenter for plan approvals. Derive its summary and
sections from the same typed plan stored in the subject. Use it in the built-in
plan approval path and composed workflows. Do not serialize missing or unknown
fields.

### 5. Narrow the channel boundary

Normalize the stored request before channel dispatch. Give each channel only
the normalized presentation and typed choices. Remove direct channel access to
the subject and remove the `JSON.stringify()` fallback.

### 6. Render complete Telegram messages

Render plain text with no parse mode. Precompute all message parts, split at
readable boundaries, add deterministic part numbers and a short fingerprint,
and put buttons on the final part only.

Write intent before sending and one durable content receipt for each confirmed
part. Keep remote IDs in the private projection. Stop automatic delivery after
an ambiguous send. Never clip approval content.

### 7. Add the full Pi decision view

Use documented `ctx.ui.custom()` APIs and existing TUI components to show the
complete presentation, fingerprint, choices, and text prompt. Support wrapping,
scrolling, resizing, cancellation, and theme changes. Preserve the abort signal
that closes Pi when another channel wins.

### 8. Update recovery and viewers

Recover confirmed multipart sends without duplication. Resume only when the
next part is provably unsent. Keep one accepted answer and one continuation.

Update the TypeScript and Rust viewers to show the human presentation by
default and machine data as separate detail. Continue to render v1 through the
compatibility presenter without changing stored bytes.

### 9. Verify compatibility and failure handling

Add tests for:

- presentation schemas, normalization, bounds, Unicode, and canonical digests;
- subject and presentation changes that reject stale answers;
- old definitions, pending v1 decisions, and accepted v1 decisions;
- complete and sparse plan presentations;
- Pi and Telegram content parity;
- unsafe markup-like text and terminal control characters;
- single-part and multipart Telegram messages;
- partial, ambiguous, resumed, and settled delivery;
- Pi scrolling, input, resize, cancellation, and external settlement;
- one answer and one continuation under concurrency and crash injection;
- TypeScript and Rust viewer parity; and
- absence of raw JSON subject serialization in channel output.

## Rollout

The preferred authoring path starts emitting v2 after release. Existing
body-based workflows continue to create and read v1 until a separate removal is
approved. No migration runs. Historical records remain immutable.

A live Telegram smoke can use an already configured private audience profile.
The test must not print, copy, or persist credentials. Fake Bot API and real-Pi
end-to-end tests remain the required automated evidence.

## Acceptance criteria

- New structured decisions cannot reach a channel without an explicit readable
  presentation.
- Telegram and Pi show the same complete decision meaning.
- Telegram never shows raw JSON or silently truncates approval content.
- Pi shows the full decision instead of only its title.
- The accepted record binds the exact subject and visible presentation.
- V1 definitions and bundles remain readable without rewrites.
- Ambiguous Telegram sends fail closed without duplicate messages or
  continuation.
- All repository, documentation, privacy, TypeScript, Rust, and real-Pi checks
  pass.

## Verification

```bash
npm run check
npm run test:e2e
cargo test --manifest-path tui/Cargo.toml
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
npm pack --dry-run --json
```
