# Workflow step messages

This specification defines how pi-workflows shows agent-step instructions in an interactive Pi session. The model receives the complete step prompt, while the user sees a small workflow card that can be expanded.

This contract is implemented for the release after `0.5.3`.

## Goal

Agent-step prompts contain the task, workflow identity, attempt identity, output shape, and submission rules. This information is required by the model, but showing it as a large user message makes the conversation hard to read.

pi-workflows will send the same prompt as a custom Pi message. A custom renderer will show a compact summary by default and the full content when expanded.

This is a presentation change. It does not add a workflow primitive, change graph execution, or change the step completion contract.

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
    deliverAs: streaming ? "steer" : "followUp",
  },
);
```

`content` is the complete prompt that the existing executor would send as a user message. It remains available to the model and in session history.

`details` contains structured display data. The renderer reads this object directly and never parses the prompt text. `AgentStepContract` remains the source of every identity field and the expected-output field.

`kind` distinguishes the first delivery from a reminder or a resume that must repeat the instructions. An ordinary resume that can continue without another prompt does not create a message.

## Engine boundary

The workflow engine remains independent of Pi. It continues to produce an `AgentStepRequest` with a complete prompt and structured contract.

The request gains optional presentation data for the run title and node status detail. The conversation executor passes the prompt, contract, presentation data, delivery kind, and streaming state to the Pi extension. The RPC executor sends the same complete prompt to headless Pi without TUI metadata.

One pure formatter remains responsible for the model prompt used by both executors. Interactive delivery must not shorten, summarize, or rebuild the model prompt from display fields.

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
- expected output
- full model prompt

Expansion uses Pi's existing custom-message expansion state and keys. pi-workflows does not add another toggle or store separate expansion state.

## Reminders and resumes

The existing bounded reminder behavior stays in place. A reminder uses the same custom message type and renderer. It keeps the contract and sets `kind: "reminder"`.

A resumed step uses `kind: "resume"` only when the executor must send the instructions again. The attempt id must still identify the active attempt. Stale attempts remain invalid.

## Notifications

Workflow notifications keep the separate custom type `pi-workflows-notification`.

Agent-step messages use `triggerTurn: true` because they ask the model to work. Notifications use `triggerTurn: false` because they report state to the user without asking for an assistant response.

The two message types must not share delivery code that can accidentally change this behavior.

## Session and persistence impact

New interactive step deliveries replace `sendUserMessage` with `sendMessage`. Existing session entries remain readable and are not rewritten.

The custom message is a normal documented Pi session message. pi-workflows adds no Pi session schema, private entry type, or separate persistent store. Run bundles keep the existing full prompt and structured step contract, so this change does not alter the run-bundle schema.

If the renderer is unavailable, Pi still retains the custom message content. pi-workflows does not add a fallback path that sends a duplicate user message.

## Public API boundary

This design uses the documented `pi.sendMessage()` and `pi.registerMessageRenderer()` APIs. The renderer uses Pi's standard `expanded` state.

It does not require a Pi core change or private Pi API.

The workflow package adds no node, graph action, tool action, or workflow-file field for this feature. Workflow authors do not configure message rendering.

## Validation and tests

The implementation must verify:

- interactive and RPC executors give the model the same complete prompt
- one step message starts one model turn
- collapsed rendering does not show the full prompt
- expanded rendering shows the full prompt and exact contract ids
- long and missing display fields render safely
- reminders and resumed deliveries keep the active attempt id
- stale attempts remain rejected after timeout or cancellation
- session replay restores the same custom message
- notifications still enter context without starting a model turn
- no duplicate user message is sent

The end-to-end test must inspect the provider-facing prompt as well as the TUI message record. A correct card with missing model instructions is a failure.

## Security

Workflow prompts and expected-output descriptions may contain untrusted text. The renderer treats them as text, applies terminal-safe wrapping, and does not interpret control sequences or markup from workflow data.

Collapsed cards avoid showing full prompts in the normal conversation view. Expanded content and session files still contain the complete prompt, so existing session privacy rules continue to apply.
