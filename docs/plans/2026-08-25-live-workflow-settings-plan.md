---
title: Change workflow settings during a run
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-25
---

# Change workflow settings during a run

A workflow run must be able to accept setting changes while it is active. The changes can affect future instructions, values, route choices, merge behavior, and other behavior that the workflow exposes. A workflow can also save follow-up prompts and send them as normal user messages after the run is officially complete.

Use one JSON settings value for each workflow scope. Apply setting changes with [JSON Patch](https://www.rfc-editor.org/rfc/rfc6902). Save every accepted patch in order. Keep follow-up prompts in a separate list because they are actions to perform later, not workflow settings.

This replaces the earlier idea of defining a custom command type for every possible setting change. JSON Patch gives all workflows one standard change format.

## Goals

- Let a workflow declare the settings that users and other authorized actors can change.
- Let changes affect only future steps and future route choices.
- Keep running actions and completed work unchanged.
- Save changes in a clear order so restart and replay produce the same result.
- Keep the source of each change outside the patch data.
- Prevent a model from granting itself protected authority.
- Save several follow-up prompts and send them in order after completion.
- Keep the completed workflow terminal while follow-up prompts start normal agent turns.
- Keep the one-active-workflow-per-session rule.
- Use the existing Pi Workflows database and documented Pi extension APIs.

## Non-goals

- Do not change workflow source, graph structure, immutable run input, completed outputs, or completed effects.
- Do not interrupt or restart a running action when settings change.
- Do not infer setting changes by parsing session history in the extension.
- Do not use progress updates or ordinary node outputs as another settings store.
- Do not put pause, resume, cancel, or follow-up delivery state inside the JSON settings value.
- Do not change Pi core or use private Pi APIs.
- Do not add an external queue, service, daemon, or database.
- Do not promise delivery after permanent loss of the process, database, machine, session, or provider.

## Public authoring API

Add an optional `settings` declaration to `defineWorkflow`.

```ts
import {
  allowSettingsPath,
  defineWorkflow,
  settingsRoute,
  workflowSettings,
} from "@osolmaz/pi-workflows";

type Settings = {
  instructions: string[];
  merge: "allow" | "forbid" | "ask";
  variables: Record<string, unknown>;
};

export default defineWorkflow({
  name: "example",

  settings: workflowSettings<Settings>({
    initial: {
      instructions: [],
      merge: "ask",
      variables: {},
    },

    parse: parseSettings,

    paths: [
      allowSettingsPath("/instructions", {
        read: ["session", "human"],
        add: ["session", "human"],
        remove: ["session", "human"],
        replace: ["session", "human"],
      }),
      allowSettingsPath("/merge", {
        read: ["session", "human"],
        replace: ["human"],
      }),
      allowSettingsPath("/variables", {
        read: ["session", "human"],
        add: ["session", "human"],
        remove: ["session", "human"],
        replace: ["session", "human"],
      }),
    ],

    validateChange: ({ before, after, actor }) => {
      if (actor.type === "session" && before.merge !== "allow" && after.merge === "allow") {
        throw new Error("A model cannot grant merge authority.");
      }
    },
  }),

  // nodes, routes, and exits
});
```

The parser checks the complete settings value after every patch. `validateChange` handles rules that depend on both the old and new values.

A workflow with no `settings` declaration has no editable settings. A request to change its settings fails clearly.

### Path rules

Path rules use JSON Pointer paths from [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901). They deny changes by default.

A rule applies to its path and descendants on pointer-segment boundaries. The most specific matching rule wins. The workflow definition is invalid when two equally specific rules disagree.

Each JSON Patch operation needs these permissions:

| Operation | Required permission                                             |
| --------- | --------------------------------------------------------------- |
| `test`    | Read the path                                                   |
| `add`     | Add at the destination                                          |
| `remove`  | Remove the source                                               |
| `replace` | Replace the path                                                |
| `copy`    | Read the source and add or replace the destination              |
| `move`    | Read and remove the source, then add or replace the destination |

The engine checks the source and destination of `copy` and `move` separately. The `read` permission controls only JSON Patch `test`, `copy`, and `move` source access. It does not hide fields from workflow code. Every node in a settings scope receives the complete typed settings value.

### Node context

Every node attempt receives one fixed settings value:

```ts
type WorkflowNodeContext<TInput, TSettings> = {
  input: TInput;
  outputs: Record<string, unknown>;
  results: Record<string, WorkflowNodeResult>;
  state: WorkflowRunState;
  settings: TSettings;
  settingsScopeId?: string;
  settingsChangeNumber?: number;
  signal: AbortSignal;
};
```

The engine deep-copies and freezes the settings before the node starts. A change accepted while the node runs does not alter that attempt. The next attempt or next step reads the latest settings.

The change number belongs to one settings scope in one run. It is not a workflow definition revision, package version, or Git revision. Use the existing SQLite resource revision for this number instead of adding another version system.

## Changing settings

Add a `change-settings` action to the workflow tool.

```json
{
  "action": "change-settings",
  "scopeId": "optional-scope-id",
  "expectedChangeNumber": 12,
  "patch": [
    {
      "op": "replace",
      "path": "/merge",
      "value": "forbid"
    },
    {
      "op": "add",
      "path": "/instructions/-",
      "value": "Run the release checks before finishing."
    }
  ]
}
```

The extension supplies the source and the stable request ID. The model cannot provide or replace those fields.

The engine performs one database transaction:

1. Return the earlier result when the same request ID and same content were already accepted.
2. Reject the request when the same ID has different content.
3. Confirm that the run is running, paused, parked, or waiting at a checkpoint, and that the settings scope exists.
4. Compare `expectedChangeNumber` when the caller supplied it.
5. Parse and authorize every JSON Pointer used by the patch.
6. Apply the patch to a copy of the current settings.
7. Parse the complete result and run `validateChange`.
8. Save the exact patch, old settings hash, new settings hash, source, time, and new change number.
9. Update the current settings value and emit one run event.

When `expectedChangeNumber` is absent, the patch applies to the latest settings in database acceptance order. A JSON Patch `test` operation can protect one field without rejecting unrelated changes.

### Limits

Use fixed safety limits:

- at most 256 operations in one patch;
- at most 64 KiB for one patch;
- at most 1 KiB for one JSON Pointer;
- at most 256 KiB for the resulting settings value.

Reject non-JSON values, unknown operation fields, invalid array indexes, invalid pointer escaping, unsafe object access, and invalid moves. A rejected patch must not change the saved settings.

## Source and authority

Use the existing saved actor types:

- `session` for a model workflow-tool call in a Pi session;
- `human` for a direct interactive command or accepted human decision;
- `controller` for a controller request;
- `policy` only when existing saved policy code makes the change.

Save a separate source label, such as `workflow-tool`, `interactive-command`, or `controller-request`, when it helps inspection. The host supplies both fields. They never come from JSON Patch data.

A normal user message that asks the model to change settings still produces a `session` change through a model tool call. The workflow can allow safe session changes, such as forbidding merge, while requiring a verified `human` action to grant authority, spend money, use credentials, or widen repository scope.

Add a direct command for protected changes:

```text
/workflow change-settings <json-patch>
```

Add these exact controller methods:

```ts
ctx.workflows.changeSettings({ requestKey, runId, scopeId, expectedChangeNumber, patch });
ctx.workflows.queueFollowUp({ requestKey, runId, prompt });
ctx.workflows.removeFollowUp({ requestKey, runId, followUpId });
```

The model tool, direct command, and controller methods must call the same database operations. Do not add a new policy API until a real policy caller needs it.

## Route changes

Add `settingsRoute()` for route choices that must observe the latest settings.

`settingsRoute()` is a pure compute step. It records the settings change number it used. Before the engine saves the selected route, it compares that number with the current settings scope.

If the number changed, the engine discards the unsaved result and runs the pure route step again. It never repeats an agent step, shell command, function action, or other external effect because settings changed.

Workflow authors place `settingsRoute()` after effectful work when later settings may change the next path.

## Included workflows

The root workflow gets one settings scope when it declares settings. Each included workflow invocation that declares settings gets a new scope.

Each scope uses one row in `resources` with resource type `settings`. Its public scope ID is derived from the run ID, mount path, and saved invocation number. A repeated or re-entered included workflow gets a new invocation number and fresh settings. It does not reuse values from an earlier invocation.

Settings do not flow between parent and child automatically. A parent can initialize child settings through an explicit typed mapping when the child starts. A change targets the active local scope by default and can target another initialized scope by ID.

## Saved data

Add these tables to the existing SQLite database:

- `workflow_settings` stores each root or included-workflow settings scope and its current value.
- `workflow_setting_changes` stores each accepted JSON Patch in order.
- `workflow_follow_ups` stores prompts that must run after completion.

Use one `resources` row of type `settings` for each settings scope. Its resource revision is the public change number. Use the existing content-addressed value store for settings, patches, prompts, and source details. Use existing leases for delivery claims.

Store these fields for each setting change:

- settings scope;
- stable request ID;
- change number;
- source type and source details;
- exact JSON Patch;
- old settings hash;
- new settings hash;
- acceptance time.

Add the settings scope, change number, and settings hash to each node attempt.

Do not store setting changes in `workflow_updates`. Updates keep their current progress and status meaning.

## Follow-up prompts

Follow-up prompts use separate actions because they do not change workflow settings.

```json
{
  "action": "queue-follow-up",
  "prompt": "Release version 0.5.0 and verify every published package."
}
```

```json
{
  "action": "remove-follow-up",
  "followUpId": "follow-up-id"
}
```

Each accepted prompt gets a stable ID and order number. Several prompts are kept in acceptance order. Reusing the same request ID with the same content returns the earlier result. Reusing it with different content fails.

Use these states:

- `queued`: the workflow is running, paused, parked, or waiting at a checkpoint;
- `pending-presentation`: the workflow completed successfully and its final response has not settled;
- `ready`: the prompt can be sent;
- `sent`: the normal user message exists in the session;
- `removed`: an allowed actor removed it before delivery;
- `cancelled`: workflow failure, timeout, or user cancellation prevented delivery.

A delivery lease is temporary coordination state. It is not another follow-up state.

### Run-state rules

| Run state                                 | Setting changes | New follow-ups | Existing follow-ups              |
| ----------------------------------------- | --------------- | -------------- | -------------------------------- |
| Running or paused                         | Accept          | Accept         | Keep queued                      |
| Parked queue entry with a nonterminal run | Accept          | Accept         | Keep queued                      |
| Waiting at a checkpoint                   | Accept          | Accept         | Keep queued                      |
| Continued from a checkpoint               | Accept          | Accept         | Carry forward in order           |
| Completed                                 | Reject          | Reject         | Wait for presentation, then send |
| Failed, timed out, or cancelled           | Reject          | Reject         | Cancel unsent items              |

The checkpoint continuation is a new stored run, but it is the same logical workflow chain. The transaction that creates the continuation transfers the active settings scopes and queued follow-ups to the new run. Scope IDs, change numbers, saved changes, and current values stay unchanged. A crash cannot leave the new run without its settings or split its follow-up list.

- Pause and park keep queued prompts.
- Resume keeps their order.
- Successful completion moves them to `pending-presentation` in the same transaction that records the terminal run state.
- A run with no final presentation records that fact and makes them ready after terminal state.
- A final presentation must settle before the first prompt becomes ready.
- Workflow failure, timeout, and user cancellation cancel every unsent prompt with a saved reason.
- A terminal workflow accepts no new prompt, but a repeated request ID can still return its earlier result.
- A prompt can be removed only before it is sent. A `session` actor can remove only a prompt added by the same session tool source. A verified `human` actor can remove any unsent prompt for that run. Controllers can remove only prompts they added with the same managed resource.

### Presentation and delivery

Save one durable presentation state for a completed run: `not-needed`, `pending`, `settled`, or `unavailable`. When the extension sends the hidden presentation prompt, include the run ID in its documented custom-message details. On `agent_settled`, save `settled` only after the active session branch contains that presentation message and its completed assistant child. On restart, use the same branch evidence to recover a missed database update. A timeout or a definite presentation failure saves `unavailable`; it does not claim that a presentation succeeded.

Add a follow-up coordinator to the Pi extension. It is separate from the existing interruption-turn coordinator because the two features solve different problems.

The coordinator sends one prompt at a time:

1. Wait until the run is terminal and the saved presentation state is `not-needed`, `settled`, or `unavailable`.
2. Wait until the target session is available, no workflow is active, and the prior agent turn has settled.
3. Claim the first ready prompt with a lease.
4. Search the current durable session branch for that follow-up ID.
5. If the message already exists, save its session entry ID and sent time without sending it again.
6. Otherwise, put the stable, nonsecret follow-up ID in the message text and call documented `pi.sendUserMessage`.
7. Scan the durable session branch for the new user message, then save its session entry ID and sent time.
8. Wait for that user turn to settle before considering the next prompt.

`pi.sendUserMessage` returns no message ID. Branch evidence is therefore required after both a new send and restart recovery. Do not expose session IDs or source details in the visible text.

If one follow-up starts another workflow, later prompts wait until that workflow ends. The completed original workflow remains terminal and never enters its start node again.

## Restart and failure behavior

Setting changes are complete when their database transaction commits. Restart loads the current settings and verifies that the saved changes rebuild the same value.

Follow-up delivery handles these failures:

- A crash before the claim leaves the prompt ready.
- A crash after the claim lets another process continue after the lease expires.
- A crash before message append leaves no session message and permits a retry.
- A crash after message append but before the database update is resolved by finding the follow-up ID in the active session branch.
- A definite send failure releases the claim.
- An unavailable session leaves the prompt pending.

The current Pi API cannot guarantee that the model starts or finishes the follow-up turn exactly once. The implementation guarantees only the saved state, claim, normal-message evidence, and local delivery status that it can observe.

## User and model surfaces

Extend workflow status, CLI output, the TUI, and the workflow card to show:

- current settings scope and change number;
- a bounded settings summary;
- accepted setting changes and their source type;
- the settings number used by each node and route;
- queued follow-up order and state;
- claim, sent message, removal, and cancellation status.

Keep large values in the value store. Show short summaries and hashes in normal views. Hide raw source IDs, session IDs, prompts, and other private content unless an explicit detailed view requires them.

Workflow step messages must show the active scope, current change number, a bounded settings summary, allowed paths, and exact tool calls. This tells the model how to handle later user messages without parsing workflow source.

## Implementation steps

### 1. Document and test JSON Patch

Add `src/workflows/json-patch.ts` and `test/json-patch.test.ts`. Implement all RFC 6902 operations over canonical JSON values. Add the limits and unsafe-object protections listed above.

### 2. Add workflow settings types

Update:

- `src/workflows/types.ts`
- `src/workflows/definition.ts`
- `src/workflows/schema.ts`
- `src/workflows/catalog.ts`
- `src/workflows/store.ts`
- `src/workflows/index.ts`

Add `src/workflows/settings.ts`. Provide `workflowSettings()`, `allowSettingsPath()`, `settingsRoute()`, and its typed exhaustive edge helper.

### 3. Add settings scopes for included workflows

Update `src/workflows/composition.ts`, workflow snapshots, and composition tests. Save a new scope for each included-workflow invocation and a new scope on every re-entry.

### 4. Save settings and changes

Update:

- `src/state/schema.ts`
- `src/state/database.ts`
- `src/state/mutation.ts`
- `src/state/json.ts`
- `src/workflows/store.ts`

Add the three tables described above. Add atomic change, lookup, replay, and inspection methods.

### 5. Bind settings to node attempts

Update `src/workflows/engine.ts`, `src/server/runner.ts`, and `src/server/rpc-executor.ts`. Save and expose one fixed settings value for every attempt.

### 6. Add safe route changes

Update `src/workflows/graph.ts`, `src/workflows/engine.ts`, snapshots, and route tests. Retry only a pure `settingsRoute()` result when its change number becomes stale before the route is saved.

### 7. Add tool and operator actions

Update:

- `src/workflows/tool-input.ts`
- `src/extension/workflow-tool.ts`
- `src/extension/index.ts`
- `src/extension/step-message.ts`
- `src/resource-managers/workflows.ts`
- `src/resource-managers/types.ts`

Add `change-settings`, `queue-follow-up`, and `remove-follow-up`. Keep source data outside model input. Use provider-compatible string action schemas.

### 8. Add completion and delivery behavior

Update terminal handling in `src/workflows/engine.ts` and `src/workflows/store.ts`. Add `src/extension/follow-up-coordinator.ts` and connect it through `src/extension/index.ts`, `src/extension/session-events.ts`, and `src/extension/recorder.ts`.

Reuse lease and session-branch checks from `src/extension/deferred-turn-coordinator.ts`. Do not reuse interruption-turn rows or states.

### 9. Add inspection views

Update:

- `src/viewer/cli.ts`
- `src/viewer/render.ts`
- `src/viewer/session-reducer.ts`
- `src/viewer/tui.ts`
- `src/render/graph-render.ts`
- `src/extension/widget.ts`
- `tui/src/state/reader.rs`
- `tui/src/state/types.rs`
- the affected Rust view and test files under `tui/`

Add bounded, private-by-default views for settings changes and follow-up prompts. Update the Rust schema check and reader in the same hard change so `piw` can open the new database.

### 10. Add one example and one built-in use

Add `examples/workflows/live-settings.workflow.ts`. It must change future instructions, one variable, one route, and queue two follow-up prompts.

Update Autoimplement to expose future merge behavior and added instructions through the general settings API. A model can forbid merge when that reduces authority. It cannot grant missing merge authority. Keep release work out of Autoimplement-specific logic.

### 11. Update documentation

Update:

- `docs/workflows.md`
- `docs/WORKFLOW_COMPOSITION.md`
- `docs/WORKFLOW_STEP_MESSAGES.md`
- `docs/SQLITE_STATE.md`
- `docs/DEFERRED_TURNS.md`
- `docs/DESIGN_PHILOSOPHY.md`
- `README.md`

Add `docs/2026-08-25-workflow-settings.md` and `docs/2026-08-25-workflow-follow-ups.md`. Keep this file as the dated implementation plan.

## Tests

Add focused tests for:

- every RFC 6901 and RFC 6902 rule;
- malformed, oversized, unsafe, and unauthorized patches;
- complete settings parsing and cross-field rules;
- duplicate request IDs and conflicting reuse;
- expected change numbers and JSON Patch `test` operations;
- concurrent changes, cancellation, terminal state, and database rollback;
- fixed settings for agent, shell, function, compute, checkpoint, retry, pause, park, resume, timeout, and cancellation;
- route changes before selection, during selection, before save, and after save;
- root, nested, repeated, and re-entered workflow scopes;
- session, human, and controller sources, plus payload attempts to spoof actor data;
- changes and follow-ups while running, paused, parked, and waiting;
- checkpoint continuation with settings and follow-ups carried forward atomically;
- invalid initial settings, equally specific conflicting path rules, and a workflow with no settings;
- two concurrent setting writers on one scope and both directions of split `copy` and `move` permission;
- exact size and operation-count boundaries;
- step messages with scope ID, change number, allowed paths, and exact action shape;
- several queued prompts, removal authority, failure, timeout, cancellation, and presentation ordering;
- crashes before and after claim, send, session append, and database update;
- extension restart, lease expiry, session branches, and two delivery processes;
- a follow-up prompt that starts another workflow;
- CLI, TUI, graph, workflow card, redaction, and layout output;
- Autoimplement with no changes, merge forbidden later, and missing merge authority;
- restart rebuild mismatch that fails instead of silently changing saved state;
- the Rust `piw` reader opening the new schema and rejecting the old schema clearly;
- a real Pi run with model changes and several follow-up prompts.

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
npx -y @simpledoc/simpledoc check
```

## Rollout

This is an alpha hard change.

Keep existing `v1` names and the current database user version. Update the exact database shape and digest in place. Do not add a second schema, old-state reader, dual write, alias, fallback, feature flag, or migration shim.

Before upgrading, users must finish active work and back up or reset the old local database. The new version must leave incompatible state untouched and stop with a clear reset instruction. Increase the revision of every changed built-in workflow so an old active built-in run cannot resume with new behavior.

Do not publish a package, create a release, or update downstream pins without separate authorization.

## Contract impact

- **Pi session state:** follow-up prompts are normal user messages whose text contains a short stable follow-up ID for restart checks. Final presentation messages include the run ID in documented custom-message details.
- **Other saved data:** add workflow settings, setting changes, follow-up prompts, node settings numbers, claims, and delivery status to the existing Pi Workflows SQLite database.
- **Pi internals:** unchanged.
- **Public Pi API:** use documented session lifecycle, branch reads, idle state, and `sendUserMessage` only.
- **Public Pi Workflows API:** add workflow settings declarations, settings-aware node context, safe route selection, and the three new actions.
- **External applications:** unchanged.

## Limits

A workflow can change only settings and routes that its author exposes. It cannot rewrite code, history, completed work, or a running effect.

Follow-up delivery needs a later live Pi process and the target session. The current Pi API does not provide native exactly-once message delivery. If Pi later adds a durable user-message queue with caller IDs and queryable delivery results, only the delivery code should change. Workflow definitions, JSON Patch data, setting changes, and follow-up states should remain the same.
