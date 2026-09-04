---
title: Change workflow settings during a run
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-25
---

# Change workflow settings during a run

A workflow can expose a JSON settings value that authorized actors can change while the workflow runs. A change affects only future node attempts and future settings routes. It does not change the workflow definition, immutable input, completed work, or a running node.

## Declare settings

Use `workflowSettings()` in `defineWorkflow()`:

```ts
import {
  allowSettingsPath,
  defineWorkflow,
  settingsRoute,
  workflowSettings,
} from "@osolmaz/pi-workflows";

const settings = workflowSettings({
  initial: {
    instructions: [],
    merge: false,
    route: "normal",
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
    allowSettingsPath("/route", {
      read: ["session", "human"],
      replace: ["session", "human"],
    }),
  ],
  validateChange: ({ before, after, actor }) => {
    if (actor.type === "session" && before.merge === false && after.merge === true) {
      throw new Error("A model cannot grant merge authority");
    }
  },
});

export default defineWorkflow({
  name: "example",
  settings,
  startAt: "choose",
  nodes: {
    choose: settingsRoute({
      run: ({ settings }) => ({ route: settings.route }),
    }),
    normal: compute({ run: ({ settings }) => settings.instructions }),
    careful: compute({ run: ({ settings }) => settings.instructions }),
  },
  edges: [
    {
      from: "choose",
      switch: { on: "$.route", cases: { normal: "normal", careful: "careful" } },
    },
  ],
});
```

The parser must validate without changing the patched value. `validateChange` can reject a valid JSON shape because of a cross-field or authority rule.

A workflow without `settings` has no editable settings. A change request fails clearly.

## Change settings

The workflow tool accepts RFC 6902 JSON Patch:

```json
{
  "action": "change-settings",
  "scopeId": "run-id:$root:1",
  "expectedChangeNumber": 3,
  "patch": [
    { "op": "replace", "path": "/route", "value": "careful" },
    { "op": "add", "path": "/instructions/-", "value": "Run the full test suite." }
  ]
}
```

A direct verified user can use:

```text
/workflow change-settings [{"op":"replace","path":"/merge","value":false}]
```

Controllers use the same saved change path:

```ts
await ctx.workflows.changeSettings({
  requestKey: "disable-merge",
  runId,
  scopeId,
  expectedChangeNumber: 3,
  patch: [{ op: "replace", path: "/merge", value: false }],
});
```

Each request has a stable server-issued ID. Repeating the same ID and content returns the first result. Reusing an ID with different content fails. When one model response emits several workflow tool calls, the extension applies them in source order so a settings change cannot race past a later step submission.

`expectedChangeNumber` protects the complete settings value. A JSON Patch `test` operation can protect one field. When no expected number is supplied, the patch applies to the latest saved value in database acceptance order.

## Path permissions

Paths use RFC 6901 JSON Pointer. They deny access by default. Rules apply to their path and descendants on segment boundaries. The most specific rule wins.

The permissions mean:

- `read`: use a path as the source of `test`, `copy`, or `move`;
- `add`: add a new object value or array item;
- `remove`: remove a value;
- `replace`: replace an existing value.

`copy` checks source read and destination add or replace. `move` checks source read and remove, then destination add or replace.

`read` is not a privacy filter. Workflow code in that scope receives the complete typed settings value.

The server records the actor outside the patch:

- `session` for a model workflow-tool call;
- `human` for a direct command or verified human decision;
- `controller` for a resource manager request; this internal version-1 actor value is retained;
- `policy` only for existing saved policy code.

Patch data cannot claim another actor type.

## Runtime rules

Each node attempt gets one deep-copied, frozen settings value, scope ID, change number, and settings hash. A change accepted while that node runs does not alter it. The next attempt or node captures the latest value.

Use `settingsRoute()` when a future route must use the latest settings. It is a pure compute node. The database compares its change number in the same transaction that saves the route result. If the number is stale, the engine reruns only that pure route. It never repeats an agent step, shell command, function action, or other external effect because settings changed.

A settings scope accepts changes when its workflow chain is running, paused, parked, or waiting at a checkpoint. A terminal completed, failed, timed-out, or cancelled run rejects new changes.

## Included workflows and checkpoints

The root workflow has one settings scope when it declares settings. Each included-workflow invocation that declares settings gets its own scope. Its ID uses the root run, mount path, and saved invocation number. Re-entry gets fresh settings.

Parent and child settings do not mix automatically. The child initializer receives its mapped child input.

A checkpoint creates a continuation run. The transaction that creates that run transfers the active settings scopes to it. Scope IDs, change numbers, saved changes, and current values remain unchanged. This keeps one ordered settings history across the logical workflow chain.

## Limits

One patch can contain at most 256 operations and 64 KiB. One JSON Pointer can contain at most 1 KiB. The resulting settings value can contain at most 256 KiB.

The engine rejects malformed operations, unknown fields, invalid indexes, invalid pointer escapes, non-JSON values, unsafe object access, and invalid moves. A rejected patch changes nothing.

Workflow settings must not contain credentials or raw secrets. Use the existing credential stores and authority checks instead.

## Saved state and inspection

Each settings scope uses one `resources` row of type `settings`. Its resource revision is the public change number. `workflow_settings` stores the current value. `workflow_setting_changes` stores every accepted patch, actor, source, old hash, new hash, and time.

Node attempts store the scope ID, change number, and settings hash they used. Workflow status, the TypeScript viewer, and `piw` show bounded settings data without printing private values by default.

This is an alpha hard change. The schema keeps its existing v1 name and changes in place. Incompatible old local state remains untouched and must be backed up or reset. There is no old-state reader, second schema, dual write, alias, fallback, or feature flag.
