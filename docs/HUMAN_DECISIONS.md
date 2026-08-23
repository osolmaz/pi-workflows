# Human decisions

pi-workflows needs a reusable way to stop at a proposal and wait for a person. The same decision must appear in Pi and Telegram, and either channel must be able to continue the run. Workflows must be able to offer plain choices, choices that collect text, and choices that route back to planning.

This document defines that behavior. The implementation is tracked in the [human decision gates plan](plans/2026-08-19-human-decision-gates-plan.md).

The [human decision presentation contract](HUMAN_DECISION_PRESENTATIONS.md)
separates canonical subject data from the complete readable message shown in Pi
and Telegram. Its [implementation plan](plans/2026-08-19-human-decision-presentations-plan.md)
preserves v1 records without rewriting them.

## Goals

A workflow author can:

- add a typed human decision without writing channel code;
- route every choice exhaustively;
- collect exact text with a choice such as `replan`;
- address a logical audience instead of a Telegram chat or Pi session;
- reuse a standard plan approval workflow; and
- rely on one accepted answer and one continuation after a crash or concurrent reply.

The feature uses the existing checkpoint execution primitive. It does not add another engine node type.

## Authoring API

`humanDecision()` is the human counterpart to the existing model-driven `decision()` helper. It returns a checkpoint definition with a typed request and response contract.

```typescript
import {
  choice,
  defineHumanChoices,
  humanDecision,
  humanDecisionEdge,
  textInput,
} from "@osolmaz/pi-workflows";

const planChoices = defineHumanChoices({
  continue: choice({ label: "Yes, continue" }),
  stop: choice({ label: "No, stop" }),
  replan: choice({
    label: "Replan",
    input: textInput({
      name: "instructions",
      prompt: "What should change?",
      minLength: 1,
      maxLength: 4_000,
    }),
  }),
});

export default defineWorkflow({
  name: "approve-example",
  startAt: "propose",
  nodes: {
    propose: agent({
      prompt: "Prepare a proposal.",
      expectedOutput: '{ "summary": "text", "plan": {} }',
    }),
    approve: humanDecision({
      audience: "operator",
      choices: planChoices,
      onTimeout: {
        afterMs: 10 * 60_000,
        response: { choice: "continue" },
      },
      request: ({ outputs }) => ({
        title: "Approve the implementation plan",
        subject: outputs.propose,
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Review the implementation plan.",
          blocks: [
            { kind: "section", title: "Changes" },
            { kind: "paragraph", text: "Implement the proposed changes." },
          ],
        },
      }),
    }),
    implement: agent({ prompt: "Implement the approved proposal." }),
    revise: agent({
      prompt: ({ outputs }) => `Revise the plan: ${JSON.stringify(outputs.approve)}`,
    }),
    stopped: compute({ run: () => ({ status: "stopped" }) }),
  },
  edges: [
    { from: "propose", to: "approve" },
    humanDecisionEdge({
      from: "approve",
      choices: planChoices,
      cases: {
        continue: "implement",
        stop: "stopped",
        replan: "revise",
      },
    }),
    { from: "revise", to: "approve" },
  ],
});
```

The accepted result is a discriminated union:

```typescript
type PlanDecision =
  | { choice: "continue" }
  | { choice: "stop" }
  | { choice: "replan"; input: { instructions: string } };
```

`humanDecisionEdge()` requires one destination for every choice. A missing or extra case is a TypeScript error. Runtime validation applies the same choice and input contract before an answer can win.

`onTimeout` is optional. It supplies a positive duration and a response that satisfies the same choice contract. The request stores the resulting absolute deadline and validated response. When no human answer wins before the deadline, the decision recovery owner applies that response with `timeout` provenance. Omitting `onTimeout` keeps an indefinite wait. A request cannot combine `onTimeout` with a separate `expiresAt` value.

## Checkpoint behavior

A human decision still has `nodeType: "checkpoint"`. The helper adds a human decision contract to that checkpoint.

When the engine reaches the node, it:

1. evaluates and validates the decision request;
2. computes a canonical request digest from the subject, choices, audience, run, node, and attempt;
3. writes an immutable decision request linked to the waiting run;
4. asks the configured channels to deliver it; and
5. parks the run in `waiting` state.

When a valid answer is accepted, the continuation keeps the workflow's original input. The human answer becomes the checkpoint node's output in the continuation. Ordinary checkpoints keep their current behavior, where `/workflow answer` supplies the continuation input.

## Request and response contracts

A new decision request contains:

- a decision ID;
- the waiting run, node, and attempt IDs;
- a short title;
- a canonical structured subject;
- a normalized human-readable presentation;
- separate subject and presentation digests;
- a positive decision revision;
- the logical audience;
- the complete choice contract;
- the canonical request digest;
- an optional absolute deadline and automatic response; and
- the creation time.

The presentation is an explicit display allowlist. A channel does not receive the subject and cannot infer operator text from it. The request digest binds the subject, visible presentation, title, revision, choices, input prompts, deadline, and automatic response. Each choice has a stable ID and may have no input or one validated text input contract.

Human decisions use only `pi-workflows.human-decision-request.v1`. The former `body` request and all human-decision `v2` records are invalid. This is an alpha hard cutover: old waiting runs and decision state must be reset rather than migrated or reinterpreted.

A submitted response contains:

- the decision ID and request digest;
- the selected choice;
- the validated input, when required;
- the channel and verified actor;
- a channel event ID;
- an idempotency key; and
- the receipt time.

A stale request digest, unknown choice, malformed input, unapproved actor, or model-originated answer is rejected before acceptance.

## Human answer boundary

The model-facing `workflow` tool cannot satisfy a human decision. Its `answer` action remains available for ordinary checkpoints, but returns an error when the waiting node requires a verified human channel.

The accepted human sources are:

- the Pi interactive decision view; and
- a configured external decision channel such as Telegram.

The host assigns the source. A workflow or model cannot claim that an answer came from a person. Pi non-interactive modes can wait for Telegram, but they cannot manufacture a Pi UI answer.

## Audiences and channel profiles

Workflows address a logical audience:

```typescript
humanDecision({ audience: "operator", ... });
```

Private configuration maps the audience to channels:

```json
{
  "schema": "pi-workflows.channels.v1",
  "audiences": {
    "operator": {
      "channels": ["pi", "telegram:default"],
      "accept": "first-valid-answer"
    }
  },
  "telegramProfiles": {
    "default": {
      "credential": "telegram-default",
      "allowedUserIds": ["<telegram-user-id>"],
      "allowedChatIds": ["<telegram-chat-id>"]
    }
  }
}
```

The workflow never receives a bot token, user ID, chat ID, Telegram message ID, or Pi session detail. Channel profiles are private host configuration and are excluded from run presentation.

pi-workflows keeps credential references in a separate private file. A Telegram credential points to an existing absolute mode-`0600` token file:

```json
{
  "schema": "pi-workflows.credentials.v1",
  "telegram": {
    "telegram-default": {
      "tokenFile": "<absolute-mode-0600-token-file>"
    }
  }
}
```

Run `/workflow-channel setup` in Pi TUI to verify and install a profile, `/workflow-channel status` to inspect whether profiles are active, and `/workflow-channel reload` after a private configuration change. Setup asks for the token file path, not the token. It updates mode-`0600` private files and does not copy the token. Token values never enter source files, workflow inputs, SQLite runs, logs, child environments, or model-visible tool results.

The same Unix account can read a local credential file. This design prevents accidental propagation, not a hostile same-account process. A separately owned connector can implement the same channel interface later if stronger isolation becomes necessary.

## Channel interface

All decision channels implement one interface:

```typescript
interface HumanDecisionChannel {
  readonly id: string;
  start(): Promise<void>;
  deliver(request: HumanDecisionRequest): Promise<DecisionDeliveryResult>;
  settle(decision: AcceptedHumanDecision | HumanDecisionCancellation): Promise<void>;
  stop(): Promise<void>;
}
```

The context exposes a narrow answer submission function. It does not expose the workflow engine, arbitrary run mutation, or another channel's credentials.

Channel delivery is independent from workflow routing. A failed Telegram delivery leaves the decision available in Pi. Audience policy decides whether one successful channel is enough or whether all configured channels are required before the request is considered delivered.

### Pi channel

The Pi channel uses documented extension UI APIs. It shows the request, lists the choices, and opens a text editor when the selected choice requires input. The host records the interactive session as the answer source.

The waiting workflow remains durable before the UI opens. Closing Pi or cancelling the view cannot lose the checkpoint. A later Pi session can reopen pending decisions.

### Telegram channel

The Telegram channel uses the Bot API and private profile configuration. It sends one decision message with inline buttons.

A choice without input submits from its button. A text choice such as `replan` works as follows:

1. the operator presses **Replan**;
2. the bot sends a `ForceReply` prompt tied to that decision and choice;
3. the operator replies to that exact prompt;
4. the channel verifies the numeric user ID, chat ID, reply message ID, decision ID, and request digest; and
5. the exact received text becomes `input.instructions`.

The adapter does not infer a choice from ordinary chat text. Callback payloads contain short opaque IDs because Telegram limits callback data. Private local SQLite rows map each opaque ID to the validated decision presentation. Credentials remain outside the database.

Telegram permits one long-polling consumer for a bot profile. Active Pi processes use the shared SQLite lease so one process owns polling and the others observe the same channel state. The lease owner can accept a verified reply, but only the Pi session that owns the waiting run creates its continuation. Active sessions inspect the durable accepted-answer fence and recover their own continuation. If no Pi process is running, Telegram delivery and reply collection resume when Pi starts again. Running an always-on service is outside this design.

The Bot API does not provide an idempotency key for `sendMessage`. pi-workflows therefore writes a delivery intent before sending and never blindly retries an ambiguous send. A timed-out send is recorded as `unknown`; Pi remains available and an operator can request another delivery. This avoids automatic duplicate messages while keeping decision acceptance exactly once.

## Durable decision records

Human decisions use the canonical [SQLite state](SQLITE_STATE.md) database:

- `human_decisions` stores each immutable request;
- `human_decision_submissions` records human, policy, channel, and control candidates;
- `human_decision_resolutions` stores the one accepted-or-cancelled winner;
- `continuations` links the parent and continuation runs;
- `effects` records parent settlement, continuation, and presentation settlement work; and
- channel tables store delivery and settlement receipts.

A valid human answer, eligible timeout policy, explicit cancellation, or no-default expiry competes for the same resolution primary key. The winning transaction records the immutable resolution, audit event, and required effects together. A retry adopts the existing matching result. A conflicting or late answer receives the durable winner.

A deadline with a validated default response is timeout-policy acceptance. It cannot become expiry cancellation. No-default expiry can cancel. Automatic policy and continuation creation require the current run owner's token and lease generation. A verified channel can submit a human candidate without gaining run ownership.

The continuation run ID is derived from the decision ID. The owner adopts an existing matching continuation or creates it once. The continuation record and redacted receipt carry the resolution provenance, decision ID, request digest, gate node ID, choice, acceptance time, and answer digest. Human actor, channel, event, and idempotency details remain private and do not enter model-visible status output.

## Planning workflow composition

pi-workflows keeps solution choice, documentation, and implementation in separate built-ins:

- `autoplan` chooses a solution or revises one after new evidence.
- `autodoc` records an already selected solution in the canonical specification and implementation plan. It does not choose a solution or implement it.
- `autoimplement` executes a clear existing plan.

`autodoc` runs by itself and as an included workflow. It returns a documented-plan record with the plan, plan digest, document paths, document digests, and check results. If the canonical documents already describe the selected plan, it adopts them without rewriting files.

`autoimplement` first finds the clear existing plan in its input, the conversation, or referenced canonical documents. It blocks when no clear plan exists. A caller can bypass discovery and autodoc only by supplying both the explicit plan and a `documentation` receipt whose plan digest matches it. A plan without that current-document evidence enters autodoc so the canonical documents are inspected and adopted or updated. The absence of a structured `plan` input never authorizes `autoplan`.

If later implementation, verification, review, comments, or CI evidence invalidates the plan, Autoimplement enters the shared plan-change workflow. That workflow runs Autoplan, Autodoc, plan approval, and bounded exact-text replanning. Monitor uses the same workflow for each new repair plan and passes the selected plan into Autoimplement without a second decision.

## Reusable plan approval workflow

pi-workflows ships a typed `plan-approval` workflow built on `humanDecision()`. Its policy has three modes:

- `auto` asks the configured audience and continues after the configured deadline. It defaults to audience `operator` and 10 minutes.
- `required` waits for an explicit human answer.
- `skip` creates no human decision and continues immediately.

The workflow has `continue`, `stop`, and exact-text `replan` exits. Continue reports `human`, `timeout`, or `skipped` provenance. Stop and replan always require a human answer.

The internal plan-change workflow composes Autoplan, Autodoc, and plan approval once. It owns the replan count, plan digest, and positive revision. Autoimplement and Monitor include this workflow instead of copying approval routes. A plan supplied by the caller or already selected by Monitor bypasses another decision. Only a changed plan digest enters the gate.

## Recovery and cancellation

Recovery follows these rules:

- missing channel deliveries can be attempted;
- confirmed deliveries are adopted;
- Telegram records intent and confirmed evidence for every multipart message;
- Telegram resumes only when the next part is provably unsent;
- ambiguous Telegram sends are not retried automatically;
- duplicate channel updates are harmless;
- stale responses are rejected;
- one human or timeout response creates one continuation;
- the winning human answer or timeout policy dismisses any pending Pi dialog;
- confirmed channel settlement is adopted without another remote call;
- failed channel settlement has a bounded retry count and cannot create an unbounded record loop; and
- cancellation resolves the owned waiting decision from durable state, even after restart, closes pending views, and prevents a later answer from continuing the run.

A required decision with no available channel remains waiting and reports the configuration problem. An automatic decision does not need a channel to apply its saved response after the deadline. A skipped plan policy creates no decision.

## Compatibility

This alpha change updates the current request, accepted-result, receipt, resolution, continuation, and snapshot contracts in place. Old active runs refuse resume through normal source and definition identity checks. There is no compatibility reader, migration, dual path, or new schema generation. Updated viewers label a human decision as a checkpoint, show its deadline and automatic action when present, and keep the canonical subject separate. Private channel configuration and transport identifiers remain hidden.

The engine remains independent from Pi and Telegram. Core code owns decision contracts, validation, durable acceptance, and continuation. The Pi extension owns UI and channel lifecycle. The Telegram adapter owns Bot API translation. Workflow definitions own only the question, choices, audience, and routes.

## Contract impact

- **Session state:** Pi records normal workflow messages and interactive decision results.
- **Other persistent data:** decision requests and resolutions can carry a deadline, automatic response, and resolution provenance in the existing decision store. The private channel index remains rebuildable.
- **Pi internals:** none.
- **Public Pi API:** documented extension lifecycle and UI methods only.
- **Public pi-workflows API:** typed human choices, `humanDecision().onTimeout`, `humanDecisionEdge()`, the channel interface, the plan approval policy, and the shared plan-change workflow.

## Verification requirements

The implementation must test:

- compile-time exhaustive choice routing;
- choices with no input and choices with exact text input;
- runtime choice and input validation;
- legacy checkpoint continuation;
- model-tool answer rejection;
- Pi interactive answers;
- Telegram callbacks and reply binding with a fake Bot API;
- unauthorized users and chats;
- stale request digests;
- concurrent Pi and Telegram answers;
- identical and conflicting retries;
- crashes before and after answer acceptance and continuation creation;
- ambiguous Telegram sends;
- long-poll lease handoff between Pi processes;
- decision cancellation and expiry;
- included `plan-approval` routes and bounded replan loops;
- viewer redaction; and
- real Pi execution without real Telegram credentials or network calls.
