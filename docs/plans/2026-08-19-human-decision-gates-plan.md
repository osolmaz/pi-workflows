---
title: Add reusable human decision gates
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-19
---

# Add reusable human decision gates

Pi Workflows must let any workflow stop after a proposal, ask the operator in Pi and Telegram, and continue from a verified human choice. A `replan` choice must collect the operator's exact alternative text, send it back to planning, and present the revised plan for another decision.

The canonical behavior and public contracts are in [Human decisions](../HUMAN_DECISIONS.md). This plan covers the practical implementation in Pi Workflows without changing Pi core or adding a persistent operating-system service.

## Outcome

Workflow authors get three reusable levels:

1. `humanDecision()` adds a custom typed decision gate to any graph.
2. The included `plan-approval` workflow provides standard `continue`, `stop`, and `replan` exits.
3. The standalone `autodoc` workflow records selected plans and is composed into autoimplement and monitor repair.

Pi and Telegram implement one channel interface. Workflows address a named audience and contain no transport details. The first valid human response wins, stale and conflicting responses fail, and crash recovery creates one continuation.

## Scope

### Planning workflow contracts

- Add a standalone typed `autodoc` built-in with `ready` and `blocked` exits.
- Make autodoc locate an already selected plan, update or adopt canonical documents, run documentation checks, and return a documented-plan record.
- Keep autodoc separate from solution selection and implementation.
- Make autoimplement locate and record an existing plan from input, conversation context, or referenced documents.
- Block autoimplement when no clear plan exists.
- Skip autodoc when canonical documents are current.
- Route every evidence-driven revision through `autodevise`, then `autodoc`, before implementation resumes.
- Never run initial autodevise only because the structured plan input is absent.

### Public authoring API

- Add `defineHumanChoices()`, `choice()`, and `textInput()`.
- Add `humanDecision()` as a typed checkpoint helper.
- Add `humanDecisionEdge()` with exhaustive TypeScript cases.
- Infer a discriminated response union from the choice contract.
- Validate the request and selected choice at runtime, including any choice input.
- Export a reusable typed `plan-approval` workflow.

### Engine and storage

- Add a human decision contract to checkpoint definitions and snapshots.
- Preserve the original workflow input when a human decision continues.
- Make the accepted response the gate's output in the continuation.
- Keep legacy checkpoint continuation unchanged.
- Add immutable records for requests, deliveries, answer attempts, accepted answers, settlement results, and continuation results.
- Accept the first valid response with a no-replace write.
- Adopt identical retries and reject conflicting responses.
- Derive one continuation identity from the accepted decision.
- Reject stale responses by decision ID and canonical request digest.
- Rebuild the pending-decision index from immutable records.

### Host and channels

- Add a `HumanDecisionChannel` interface outside the engine layer.
- Add a Pi channel using documented TUI APIs.
- Add a Telegram channel using the Bot API and private profiles.
- Add named audience resolution and private channel configuration.
- Add a setup command that writes private configuration with mode `600`, references an existing mode-`0600` token file, and verifies the Telegram bot without reading the token into a prompt or printing it.
- Keep Telegram optional. Pi Workflows must start and run normal workflows without Telegram configuration.
- Use one leased long-poll owner per Telegram profile across active Pi processes.

### Documentation and display

- Add the authoring API to `docs/workflows.md`.
- Add human decision state to `docs/run-bundles.md`.
- Add channel setup and recovery instructions.
- Add a custom gate example and a composed plan approval example.
- Show pending and accepted choices in TypeScript and Rust viewers.
- Redact credentials, chat IDs, user IDs, message IDs, and private profile names from model-visible and public presentation.

## Non-goals

- Change Pi core or use undocumented Pi APIs.
- Create a Telegram bot or copy a token without explicit source and destination approval.
- Add Telegram-specific logic to monitor, autoimplement, autodevise, or user workflows.
- Run an always-on service when no Pi process is active.
- Promise exactly-once Telegram message creation after an ambiguous Bot API response.
- Add arbitrary forms in the first release. Choice buttons and one text input cover the required flows.
- Change existing checkpoints or historical run bundles.
- Enable human approval by default in existing built-in workflows.

## Design decisions

### Extend checkpoints instead of the engine graph

`humanDecision()` returns `nodeType: "checkpoint"`. The engine already knows how to park a run and create a continuation. The added contract defines who can answer, how to validate the answer, and how to deliver the request.

The new behavior applies only when a checkpoint carries a human decision contract. Ordinary checkpoints keep using the continuation input supplied by `/workflow answer`.

### Separate workflow intent from delivery

A workflow declares its question and choices together with the subject and audience. Private host configuration maps the audience to Pi, Telegram, or later channels. This keeps workflow files portable and lets one Telegram adapter serve every workflow.

### Verify the answer source in the host

The model-facing workflow tool is not a human channel. It must reject `answer` while a human decision is waiting. The Pi UI path and Telegram adapter call an internal submission API that assigns the source and actor. Callers cannot supply a trusted source label themselves.

### Keep exact response text

The Telegram adapter accepts replan text only as a reply to the exact `ForceReply` prompt created for the pending decision and choice. It validates the numeric user and chat IDs and preserves the received text. Planning receives that string without a choice-classification model call.

### Make answer acceptance exact

Channel delivery can be retried or fail independently. Decision acceptance is one atomic no-replace operation. The accepted response and deterministic continuation identity prevent two channels from starting two continuations.

### Handle Telegram delivery limits honestly

Telegram Bot API `sendMessage` has no client idempotency key. The adapter writes an intent before sending. A confirmed response records the Telegram message ID. A timeout after a possible send becomes `unknown` and is not retried automatically. This prevents an automatic duplicate at the cost of a possibly missing Telegram notification. Pi remains available, and an operator can request a new delivery attempt.

## Data model

Add versioned JSON schemas for:

- `human-decision-request-v1`;
- `human-decision-delivery-v1`;
- `human-decision-answer-attempt-v1`;
- `human-decision-accepted-v1`;
- `human-decision-cancellation-v1`;
- `human-decision-resolution-v1`;
- `human-decision-receipt-v1` for redacted continuation state;
- `human-decision-settlement-v1`; and
- `human-decision-continuation-v1`.

Use canonical JSON for request and answer digests. Keep credential values and private channel configuration outside every schema.

Store decision records under the existing workflow state root:

```text
decisions/<decision-id>/
  request.json
  deliveries/<channel>/<attempt-id>.json
  answers/<attempt-id>.json
  resolution.json
  accepted.json
  cancelled.json
  settlements/<channel>/<attempt-id>.json
  continuation.json
```

All final records use no-replace creation and adopt only byte-identical content. Temporary files remain in the same filesystem so rename and exclusive-create rules stay valid.

A private SQLite index may track pending decisions, channel leases, Telegram update offsets, opaque callback IDs, and known message IDs. It is a projection and can be deleted and rebuilt from immutable records plus current private channel state.

## Work plan

### Contracts and compile-time API

- Add generic choice and input types.
- Build the response union from choice keys.
- Add `humanDecision()` and exhaustive `humanDecisionEdge()`.
- Extend workflow validation and definition snapshots.
- Add compile-time fixtures for every invalid route shape.

### Durable decision storage

- Add schemas and generated types.
- Add canonical request and response digest helpers.
- Add the decision store with no-replace writes and identical-byte adoption.
- Add a rebuildable pending-decision projection.
- Test concurrent writers and partial records.

### Safe human decision continuation

- Detect a human decision at `continueRun()`.
- Validate the accepted response through the node contract.
- Preserve the parent's original workflow input.
- Expose the response as the checkpoint output.
- derive and adopt the continuation identity; and
- leave the legacy checkpoint path unchanged.

Test crashes before acceptance, after acceptance, during continuation creation, and after continuation completion.

### Channel management

- Add the channel interface and audience resolver in the extension layer.
- Start channels during documented session lifecycle hooks.
- Stop them idempotently during shutdown and reload.
- Fan out one decision to all audience channels.
- Send every channel response through the same acceptance method.
- Settle all confirmed channel messages after acceptance, cancellation, or expiry.

### Pi channel

- Render pending decisions in the workflow widget.
- Open a TUI choice view from the checkpoint notification and workflow command.
- Open a text editor for text choices.
- Mark answers from this path as Pi interactive answers.
- Reject model-tool answers for human decisions.
- Restore pending decisions after restart.

### Telegram channel

- Add private profile and credential-reference parsing.
- Add a configuration command that accepts a private token-file reference and performs `getMe` verification without copying or displaying the token.
- Add the shared long-poll lease and durable update offset.
- Render choice buttons with opaque callback IDs.
- Implement the bound `ForceReply` text flow.
- Verify every bound reply field, including the actor, chat, reply message, decision ID, selected choice, and request digest.
- Record every delivery outcome without leaking request URLs or tokens.
- Edit confirmed messages after a decision settles.

Use a fake Bot API in all automated tests. Do not require a real token or network access.

### Autodoc and autoimplement

- Define the typed standalone `autodoc` built-in workflow.
- Add a durable documented-plan result shared by autodoc, autoimplement, and monitor.
- Replace autoimplement's missing-input redesign route with existing-plan discovery.
- Block when discovery finds no clear plan.
- Skip autodoc for current canonical documents.
- Route undocumented and revised plans through autodoc.
- Keep autodevise only on evidence-driven redesign edges.

### Reusable plan approval

- Define the typed `plan-approval` built-in workflow.
- Return named `continue`, `stop`, and `replan` exits.
- Include the accepted decision receipt in every exit.
- Return exact instructions from `replan`.
- Add an example that loops through `autodevise`, plan approval, and implementation.
- Keep monitor and autoimplement behavior unchanged unless their input requests the approval workflow.

### Viewers and documentation

- Display the audience label, choice labels, waiting state, and accepted choice.
- Keep actor and transport details out of public or model-visible views.
- Document setup, authoring, cancellation, recovery, Telegram delivery ambiguity, and the no-service limitation.
- Update the plan with meaningful implementation departures.

## Implementation note

The setup command uses an existing mode-`0600` token file instead of collecting and copying a token. This keeps credential ownership with the existing private store and follows the no-copy credential boundary while still verifying the bot with `getMe`.

## Acceptance criteria

- Autodoc runs alone, adopts current documents, updates stale documents, and blocks without a selected plan.
- Autoimplement uses the plan already present in context or documentation and never devises merely because `input.plan` is absent.
- Every revised plan is documented before implementation resumes.
- A TypeScript workflow can define custom human choices and route them exhaustively.
- A text choice returns the exact submitted text.
- The engine and run snapshot still identify the node as a checkpoint.
- The workflow tool cannot answer a protected human decision.
- Pi and Telegram can receive the same decision through one audience profile.
- The first concurrent valid answer wins and creates one continuation.
- An identical retry is adopted; a conflicting or stale answer is rejected.
- The original workflow input survives a human-decision continuation.
- Old checkpoints and old bundles pass their existing tests unchanged.
- The Telegram adapter accepts text only from the bound reply and approved numeric actor.
- A missing Telegram profile leaves Pi decisions usable.
- A Telegram timeout does not cause an automatic duplicate send.
- Restart recovery adopts confirmed deliveries and accepted continuations.
- The standard plan approval workflow loops through replan and requires approval for the revised digest.
- No credential or private channel value appears in source, fixtures, run bundles, logs, screenshots, or model-visible output.

## Verification

Run focused tests while implementing:

```bash
npx vitest run test/human-decision-api.test.ts test/human-decision-store.test.ts
npx vitest run test/human-decision-engine.test.ts test/run-resume.test.ts
npx vitest run test/pi-decision-channel.test.ts test/telegram-decision-channel.test.ts
npx vitest run test/plan-approval.test.ts test/composition.test.ts
```

Run all repository gates before review:

```bash
npm run check
npm run test:e2e
cargo test --manifest-path tui/Cargo.toml
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

Run Pi Reviewer against the pushed branch. Fix every P0 and P1 finding and rerun it. Address valid P2 findings, but do not rerun review solely because of a P2-only change. Open or update a pull request and leave it unmerged unless merge is separately authorized.

## Release

This work adds compatible public APIs and additive persisted records. Release it as the next minor pre-1.0 version after the compatibility checks, viewer tests, real-Pi tests, and recovery tests pass.

## Contract impact

- **Session state:** normal workflow messages and interactive decision results.
- **Other persistent data:** additive decision records, a rebuildable private channel index, and private channel configuration.
- **Pi internals:** none.
- **Public Pi API:** documented extension lifecycle plus command and UI methods only.
- **Public Pi Workflows API:** typed human choices, `humanDecision()`, `humanDecisionEdge()`, the channel interface, and the `plan-approval` workflow.
