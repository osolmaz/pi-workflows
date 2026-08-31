# Workflow step messages

This specification defines how pi-workflows shows agent-step instructions in an interactive Pi session. The model receives the complete step prompt, while the user sees a small workflow card that can be expanded.

## Goal

Agent-step prompts contain the task, workflow identity, attempt identity, output form, and completion rules. Submitted steps call the workflow tool. Assistant-message steps reply normally. This information is required by the model, but showing it as a large user message makes the conversation hard to read.

pi-workflows sends the same prompt as a custom Pi message. A custom renderer shows a compact summary by default and the full content when expanded.

Both output forms use the existing `agent` node. The completion form changes through `expectedOutput`; no new node type is added.

## Message contract

Interactive agent-step messages use the custom type `pi-workflows-agent-step`.

The message has this shape:

```ts
export type WorkflowAgentStepMessageDetails = {
  schema: "pi-workflows.agent-step-message.v1";
  kind: "step" | "reminder" | "resume";
  contract: AgentStepContract;
  presentation?: {
    runTitle?: string;
    statusDetail?: string;
  };
};

pi.sendMessage(
  {
    customType: "pi-workflows-agent-step",
    content: completeModelPrompt,
    display: true,
    details,
  },
  {
    triggerTurn: true,
  },
);
```

`content` is the complete prompt that the existing executor would send as a user message. It remains available to the model and in session history.

`details` contains structured display data. The renderer reads this object directly and never parses the prompt text. `AgentStepContract` remains the source of every identity field, the completion form, the submitted output description, and any explicit assistant character limit.

`kind` distinguishes the first delivery from a reminder or a resume that must repeat the instructions. An ordinary resume that can continue without another prompt does not create a message.

## Session delivery

One shared coordinator delivers step prompts, protected decisions, notifications, and final workflow results. It does not claim or send a new message while Pi is busy or another message is pending. Before it calls `pi.sendMessage()`, it records the stable delivery ID in a process-local queued map. The one-second poll can then look for the matching session entry, but it cannot send that ID again.

The coordinator clears the queued ID only after it observes the custom message in the active branch and saves the public Pi session entry ID through the workflow host. If Pi becomes idle but does not expose that entry after the confirmation interval, the coordinator reports an ambiguous delivery and keeps it blocked. Reload and restart recovery first search the branch for that stable ID. An existing entry is adopted. A new message is sent only when no entry exists and the host grants a new claim.

The host does not grant another live presentation claim to the same extension client. Claim expiry permits recovery by a new claimant; it is not permission for the current process to resend a queued message.

## Engine boundary

The workflow engine remains independent of Pi. It continues to produce an `AgentStepRequest` with a complete prompt and structured contract.

The request carries optional presentation data for the run title and node status detail. The workflow host stores the prompt, contract, presentation data, and delivery kind for the origin Pi extension. The RPC executor handles submitted steps. An assistant-message step parks for the origin Pi session; a detached run with no origin session fails before prompting.

One pure formatter remains responsible for the model prompt used by both executors. Interactive delivery must not shorten, summarize, or rebuild the model prompt from display fields.

Before the step contract, the formatter adds the active settings scope, change number, bounded current value, allowed model paths, and exact `change-settings` action when that scope declares settings. It also shows the `queue-follow-up` and `remove-follow-up` actions. Actor identity is never part of model input. The extension derives it from the documented tool call.

## Compact display

The collapsed card shows only useful workflow identity and current work. For example:

```text
▶ monitor › check
Checking the monitored target
```

A reminder or resumed delivery adds a short label:

```text
↻ monitor › check · reminder
Checking the monitored target
```

The card uses the run title when it is more useful than the workflow name. It omits missing status detail instead of inventing one. Long fields are clipped or wrapped to the available terminal width.

The expanded card shows:

- workflow name and run title
- run id
- node id
- attempt id
- delivery kind
- completion form
- expected output and optional character limit
- full model prompt

Expansion uses Pi's existing custom-message expansion state and keys. pi-workflows does not add another toggle or store separate expansion state.

## Reminders and resumes

The existing bounded reminder behavior stays in place for submitted steps. A reminder uses the same custom message type and renderer. It keeps the contract and sets `kind: "reminder"`. Assistant-message steps do not nudge or retry after a visible response.

A resumed step uses `kind: "resume"` only when the executor must send the instructions again. An interrupted assistant-message step keeps its attempt id. If its matching prompt already has a completed assistant child on the active branch, the executor adopts that exact response instead of displaying it again. Stale attempts and responses from another branch remain invalid.

## Notifications

Workflow notifications keep the separate custom type `pi-workflows-notification`.

Agent-step messages use `triggerTurn: true` because they ask the model to work. Notifications use `triggerTurn: false` because they report state to the user without asking for an assistant response.

The two message types use the same delivery coordinator but keep separate send policies. The coordinator never changes whether a message starts a model turn.

## Session and persistence impact

Interactive step deliveries use `sendMessage` instead of `sendUserMessage`. Existing session entries remain readable and are not rewritten.

The custom prompt and visible assistant response are normal documented Pi session messages. pi-workflows adds no Pi session schema, private entry type, or separate persistent store. SQLite stores each settled Pi entry once. Small relational links connect the workflow attempt to its prompt, response, first, and last entries. The attempt keeps only the assistant digest receipt. It does not copy the prompt or visible response into another blob.

If the renderer is unavailable, Pi still retains the custom message content. pi-workflows does not add a fallback path that sends a duplicate user message.

## Public API boundary

This design uses the documented `pi.sendMessage()` and `pi.registerMessageRenderer()` APIs. The renderer uses Pi's standard `expanded` state.

It does not require a Pi core change or private Pi API.

The workflow package adds `assistantMessage()` as an `expectedOutput` value for the existing `agent` node. It adds no node type, graph action, Pi tool, private API, or message-rendering option.

## Validation and tests

Tests verify:

- interactive and RPC executors give the model the same complete prompt
- one step message starts one model turn, even when Pi stays busy longer than the poll interval and delivery claim lease
- collapsed rendering does not show the full prompt
- expanded rendering shows the full prompt, settings scope and change number, allowed paths, and exact contract ids
- long and missing display fields render safely
- reminders and resumed deliveries keep the active attempt id
- submitted steps still reject stale attempts after timeout or cancellation
- assistant steps wait for `agent_settled` and capture only visible text
- empty, failed, aborted, tool-only, and explicitly over-limit responses fail once
- session replay restores the same custom prompt and adopts an existing response once
- detached execution parks for the origin session or fails clearly when none exists
- notifications still enter context without starting a model turn
- no duplicate prompt or assistant response is sent

The end-to-end test inspects the provider-facing prompt as well as the TUI message record. A correct card with missing model instructions is a failure.

## Security

Workflow prompts and expected-output descriptions may contain untrusted text. The renderer treats them as text, applies terminal-safe wrapping, and does not interpret control sequences or markup from workflow data.

Collapsed cards avoid showing full prompts in the normal conversation view. Expanded content and session files still contain the complete prompt, so existing session privacy rules continue to apply.
