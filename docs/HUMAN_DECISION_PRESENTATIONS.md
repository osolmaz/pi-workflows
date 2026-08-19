# Human decision presentations

This contract is implemented. New human decision requests separate their canonical
subject from the complete readable message shown to an operator. Historical requests
that use `body` remain compatible through a deterministic readable formatter.
The implementation plan is in
[the human decision presentations plan](plans/2026-08-19-human-decision-presentations-plan.md).

A human decision contains machine data and a separate message for the operator.
Pi Workflows stores and validates the machine data. Pi and Telegram render only
the operator message, and future channels follow the same rule.

## Minimal example

```typescript
approve: humanDecision({
  audience: "operator",
  choices,
  request: () => ({
    title: "Approve the implementation plan",
    subject: {
      task: "Add readable human decisions",
      plan: selectedPlan,
      planDigest,
      revision: 1,
    },
    presentation: {
      schema: "pi-workflows.decision-presentation.v1",
      summary: "Replace raw JSON decisions with readable messages.",
      blocks: [
        { kind: "section", title: "Changes" },
        {
          kind: "bullets",
          items: [
            "Keep structured data as the durable source.",
            "Show the same readable message in Pi and Telegram.",
          ],
        },
        {
          kind: "fields",
          items: [{ label: "Plan revision", value: "1" }],
        },
      ],
    },
  }),
});
```

The operator sees the summary and sections along with lists and fields. The operator does
not see `subject` unless the workflow explicitly copies selected text into
`presentation`.

## Request contract

A new request uses `pi-workflows.human-decision-request.v2`. It contains:

| Field                | Required | Meaning                                         |
| -------------------- | -------- | ----------------------------------------------- |
| `title`              | Yes      | Short decision title shown by every channel.    |
| `subject`            | Yes      | Canonical JSON data used by the workflow.       |
| `presentation`       | Yes      | Human-readable content defined below.           |
| `audience`           | Yes      | Named audience resolved by the host.            |
| `choices`            | Yes      | Typed choices and optional input contracts.     |
| `revision`           | Yes      | Positive decision revision.                     |
| `subjectDigest`      | Yes      | SHA-256 digest of the canonical subject.        |
| `presentationDigest` | Yes      | SHA-256 digest of the normalized presentation.  |
| `requestDigest`      | Yes      | SHA-256 digest that binds the complete request. |

The runtime adds the usual run binding and lifecycle fields as it does for
current decisions.

A request that supplies `subject` without `presentation` is invalid. A channel
must not derive a presentation from `subject`.

## Presentation contract

`pi-workflows.decision-presentation.v1` is a small ordered document:

```typescript
type DecisionPresentation = {
  schema: "pi-workflows.decision-presentation.v1";
  summary: string;
  blocks: DecisionPresentationBlock[];
};
```

`summary` is required and non-empty. Every channel shows it first. `blocks` can be empty. Block
order is meaningful and every channel preserves it.

### Blocks

The first version supports five flat block types.

#### Paragraph

```json
{ "kind": "paragraph", "text": "This change affects active workflows." }
```

#### Section

```json
{ "kind": "section", "title": "Verification" }
```

A section labels the blocks that follow it until the next section. Sections do
not contain nested blocks.

#### Bullets

```json
{
  "kind": "bullets",
  "items": ["Run the unit tests.", "Run the real-Pi test."]
}
```

#### Fields

```json
{
  "kind": "fields",
  "items": [
    { "label": "Repository", "value": "pi-workflows" },
    { "label": "Action", "value": "Update the decision contract" }
  ]
}
```

#### Preformatted text

```json
{
  "kind": "preformatted",
  "text": "npm run check\nnpm run test:e2e"
}
```

Preformatted text preserves spacing and line breaks. It does not permit HTML,
Markdown, terminal escape sequences, or executable channel instructions.

## Validation and normalization

The authoring API validates the presentation before it creates a pending
request.

- Unknown fields and unknown block kinds are invalid.
- Display values are strings. Arbitrary nested objects are invalid.
- The summary, section titles, labels, bullet items, and field values must not
  be empty after whitespace checks.
- The normalizer converts CRLF and CR line endings to LF.
- The normalizer preserves block order, item order, Unicode text, and other
  spacing.
- Terminal control characters are invalid. Paragraph and preformatted text can
  contain LF and tab. Titles and labels plus bullet items cannot contain control
  characters.
- The complete normalized presentation is limited to 64,000 UTF-16 code units.
- A presentation can contain at most 256 blocks.
- One bullets or fields block can contain at most 256 items.
- One string can contain at most 16,000 UTF-16 code units.
- A renderer can produce at most 20 transport parts for one recipient.

If a presentation exceeds a limit, request creation fails with the exact limit
and observed value. The runtime does not create a pending request and does not
send a partial message.

## Digests

The runtime uses canonical JSON with a trailing newline, as defined by the run
bundle contract.

```text
subjectDigest = sha256(canonicalJson(subject))
presentationDigest = sha256(canonicalJson(normalizedPresentation))
requestDigest = sha256(canonicalJson(requestBasis))
```

`requestBasis` contains the request schema and run binding. It also contains the
audience, title, subject, normalized presentation, choices, typed input
contracts, revision and optional expiry. It does not contain the three digest
fields or the derived decision ID.

An answer must match the exact request revision and request digest. A change to
only the subject, visible text, choice label, or input prompt makes an older
answer stale.

Channels can show a short prefix of `presentationDigest` so an operator can
compare the decision in Pi and Telegram. The viewer shows the same fingerprint.
The complete digest remains in the durable request and accepted answer evidence.

## Channel rendering

The workflow creates one presentation. It does not contain channel names,
Telegram markup, terminal colors, message limits, buttons, or callback data.

Each channel can change spacing and wrapping as well as styling, navigation, or
controls. It must preserve the title and summary together with block order and
contents. It must also preserve every choice and input prompt. A channel must
not omit or reinterpret approval-relevant content.

### Telegram

Telegram uses plain text without a parse mode. Text that resembles HTML,
Markdown, a command, or a mention remains inert text.

The renderer:

1. Renders the complete normalized presentation.
2. Splits at block and paragraph boundaries before splitting a line.
3. Splits a long line at Unicode-safe boundaries only when required.
4. Reserves space for `Part n/N` and a short presentation fingerprint.
5. Keeps every Telegram message below the Telegram limit.
6. Adds choice buttons only to the final part.
7. Stores durable part indexes and content digests.
8. Keeps chat and message IDs only in the private channel projection.

The renderer never adds an ellipsis in place of omitted decision content.

The channel records intent before sending. It records each part after an
unambiguous response. If a send result is ambiguous, it marks delivery unknown
and does not retry that part or later parts automatically. Another configured
channel can still answer the decision.

### Pi

Pi uses the documented extension TUI API. A custom decision component shows the
complete presentation and fingerprint together with the choices and optional
text prompt. It wraps and scrolls while responding to resize, theme, cancellation,
and `AbortSignal` events.

When Telegram or another channel accepts the decision, the signal closes the Pi
dialog. Pi Workflows does not modify Pi core or use undocumented TUI state.

### Other channels

A new channel consumes the normalized presentation and typed interaction
contract. It must pass the same conformance tests. It cannot access the subject
for display.

## Plan presentation

Pi Workflows provides a reusable plan presenter for built-in workflows. It
derives a presentation from the same typed plan stored as the subject.

The presenter uses these sections when data exists:

1. Goal
2. Proposed changes
3. Verification
4. Boundaries
5. Risks and mitigations
6. Evidence

It omits absent sections. It never serializes the plan object. `plan-approval`,
`monitor`, `autoplan`, `autodoc`, and `autoimplement` reuse this presenter where
they ask a person to approve a plan.

## Compatibility

Current v1 requests remain immutable.

- A v1 string body becomes one readable paragraph at delivery time.
- A v1 object body uses a deterministic compatibility formatter. It converts
  stable key order into readable labels and fields with sections and lists.
- An oversized v1 body remains answerable. The formatter keeps a bounded readable
  prefix and adds an explicit omission notice with the full body digest and size.
  It never hides omitted content behind an ellipsis.
- The compatibility formatter reads only the historical `body`, which was
  already the display field. It never reads a new structured subject.
- V1 request bytes and digests do not change.
- Pending and accepted v1 decisions continue to use v1 validation and digest
  rules.
- New preferred authoring emits v2. The existing body form remains a deprecated
  compatibility overload until a separate removal is approved.

No migration rewrites run bundles or decision records.

## Privacy and security

The presentation is an explicit display allowlist. Data does not become visible
because it exists in the subject.

Channel adapters do not receive the subject. Durable public records do not
contain Telegram chat IDs, message IDs, bot tokens, credential profile values,
or private audience configuration. The private channel projection retains only
the transport identifiers required for recovery and settlement.

Workflow authors remain responsible for not putting a secret in the explicit
presentation. Renderers treat all text as untrusted and inert.

## Failure behavior

- Invalid or excessive content fails before a request becomes pending.
- A renderer that cannot represent every block fails closed.
- Confirmed multipart delivery requires a receipt for every part.
- Ambiguous Telegram delivery remains unknown and is not retried blindly.
- A channel failure does not choose a default answer.
- Rules for the first valid answer and stale answers remain unchanged, as do
  cancellation and settlement rules together with exactly-once continuation.

## Verification

Implementation must pass:

```bash
npm run check
npm run test:e2e
cargo test --manifest-path tui/Cargo.toml
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
```

Tests must cover schema validation, canonical digests, readable legacy bodies,
plan rendering, Pi and Telegram content parity, unsafe text, Unicode, multipart
delivery, ambiguous sends, recovery, stale answers, viewer output, and proof
that no channel serializes a subject as JSON.

## Boundaries

This contract does not add a new workflow node, template language, rich text
framework, translation service, delivery relay, Telegram resource, credential,
or Pi core change.
