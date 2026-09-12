---
title: Make the workflow widget scroll shortcuts configurable
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-12
status: approved
---

# Make the workflow widget scroll shortcuts configurable

## Goal

Let a user who installs both `@osolmaz/pi-workflows` and `pi-background-tasks` keep, move, or turn off the workflow widget scroll shortcuts through one documented mechanism, without patching `node_modules`. Keep today's defaults when no configuration exists. Register no shortcut for a direction that fails validation, instead of silently falling back. Show the effective keys in the widget hint. Cover the default, remapped, disabled, and invalid paths with tests, and document the mechanism and the conflict.

Tracked as `osolmaz/pi-workflows#90`.

## Observed failure

With both packages installed, pi reports at startup:

> Extension shortcut conflict: 'shift+down' registered by both .../pi-workflows/src/extension/index.ts and .../pi-background-tasks/extensions/background-tasks.ts. Using .../pi-background-tasks/...

The extension registers `shift+up` and `shift+down` in `src/extension/index.ts` for `sessionView.scrollUp` and `sessionView.scrollDown`. Pi keys extension shortcuts by the lowercased literal key string in one map and keeps only the last registration, so the widget scroll-down binding stops working, and the surviving binding depends on package load order. A user can only fix this by patching `node_modules` today.

Reported environment: pi 0.85.1, `@osolmaz/pi-workflows` 0.16.10, `pi-background-tasks` 2.5.0. The reporter worked around it by moving the widget scroll to `ctrl+alt+up` and `ctrl+alt+down`.

Two Pi facts bound the solution. `registerShortcut` accepts a key, not a named action, and `~/.pi/agent/keybindings.json` governs Pi's own keybinding ids, so a user cannot remap an extension shortcut there. Pi also exposes no shortcut conflict information to extensions, so the extension cannot detect the collision itself. The fix has to live in pi-workflows and reach the end state by choosing what this extension registers.

## Selected change

Add one optional configuration file that owns the two scroll shortcuts, and make registration and the widget hint follow the resolved values. A missing file keeps today's behavior exactly.

The file is `<configDir>/shortcuts.json` with the schema identifier `pi-workflows.shortcuts.v1` and the optional fields `scrollUp` and `scrollDown`. `configDir` follows the existing `PI_WORKFLOWS_CONFIG_DIR` rule, with the default `~/.config/pi-workflows`, which is the directory the extension already uses for `channels.json`.

Example:

```json
{
  "schema": "pi-workflows.shortcuts.v1",
  "scrollUp": "ctrl+alt+up",
  "scrollDown": "ctrl+alt+down"
}
```

Field rules: an omitted field keeps the default, which is `shift+up` or `shift+down`; `null` removes that binding; a string replaces it.

A new module, `src/extension/shortcuts.ts`, becomes the single owner of the shortcut decision. It exports the schema identifier, the default pair `{ scrollUp: "shift+up", scrollDown: "shift+down" }`, the type `ScrollShortcuts = { scrollUp: string | null; scrollDown: string | null }`, a key validator, a synchronous loader `loadScrollShortcuts({ configDir, read })` that returns `{ shortcuts, notices, path }`, and `scrollShortcutHint(shortcuts)` that returns the widget label. The loader reads the file with `fs.readFileSync` and reuses `decisionConfigDir()` from `src/channels/config.ts` for the directory rule instead of repeating the path logic.

Loading rules:

- A missing file yields the defaults with no notice.
- A parse error, a non-object value, a missing or unknown schema, or an unreadable file registers no scroll binding at all and adds one notice that names the path and the problem.
- An invalid value for one field leaves that direction unregistered, keeps the other field at its resolved value, and adds one notice that names the field and the offending value.
- A valid value matches Pi's documented `modifier+key` format, with at least one of `ctrl`, `shift`, `alt`, `super`, and a key from Pi's documented key list.
- A resolved pair that repeats one key registers only the scroll-up direction and notices the duplicate.
- A key equal to the extension's own `PIW_SHORTCUT`, imported from `src/extension/herdr-viewer.ts`, is rejected with a notice.
- `scrollShortcutHint` renders `"<prefix>↑/↓ scroll"` when both keys share one modifier prefix and end in `up` and `down`, joins the two keys with `" · "` otherwise, renders one key alone when one direction is enabled, and returns `undefined` when both are `null`.

`src/extension/index.ts` calls the loader once at load, registers only the effective bindings, and keeps its synchronous default export. The two hardcoded registrations are deleted in place.

## Scope

Only `/home/onur/repos/pi-workflows`. The change may edit the extension source, its tests, and its documentation, run the local checks and the required live end-to-end run, create commits on the task branch `fix/configurable-widget-scroll-shortcuts`, push that branch, and open or update its pull request. It may merge that pull request after review passes and CI is green. It must not modify another repository, release, deploy, change credentials, or change repository policy.

## Non-goals

- Do not change Pi core, `node_modules`, or `pi-background-tasks`, and do not open an upstream request as part of this work.
- Do not add an environment variable or a CLI flag for the shortcuts.
- Do not add an alias, a fallback, or a compatibility path for the removed hardcoded registration. The alpha policy forbids one.
- Do not add automatic conflict detection or automatic yielding. Pi exposes no shortcut diagnostics to extensions.
- Do not change `/piw`, `Ctrl+Shift+R`, the scroll step size, follow mode, or the ten-line widget budget.
- Do not add a limit to user-visible output.
- Do not add a private-file permission check for `shortcuts.json`, because it holds no credential. `requirePrivateFile` stays specific to the channel profile.
- Do not change the workflow engine, the protocol, SQLite state, or the viewer.
- Do not write migration work. With no file present, behavior is identical to today.

## Requirements

1. In the new `src/extension/shortcuts.ts`, export the schema identifier, the default pair `{ scrollUp: "shift+up", scrollDown: "shift+down" }`, the type `ScrollShortcuts = { scrollUp: string | null; scrollDown: string | null }`, a key validator, the synchronous loader `loadScrollShortcuts({ configDir, read })` returning `{ shortcuts, notices, path }`, and `scrollShortcutHint(shortcuts)`. Read `<configDir>/shortcuts.json` with `fs.readFileSync`, and take the directory rule from `decisionConfigDir()` in `src/channels/config.ts`. Import `PIW_SHORTCUT` from `src/extension/herdr-viewer.ts` for the reserved-key rule.
2. In `src/extension/index.ts`, call `loadScrollShortcuts()` once near the top of the factory, before `new SessionWorkflowView()` at line 178, store the returned notices in a module-local `pendingShortcutNotices` array, compute `const scrollHint = scrollShortcutHint(shortcuts)`, and pass the label to `SessionWorkflowView`.
3. In `src/extension/index.ts`, delete the two hardcoded registrations at lines 581 to 589 and register one shortcut per non-null direction in a stable order: `ctrl+shift+r`, then scroll up, then scroll down. Keep the existing `sessionView.scrollUp` and `sessionView.scrollDown` handlers and the existing descriptions.
4. In the `pi.on("session_start", ...)` handler at `src/extension/index.ts` line 589, after `sessionContext` is set, flush `pendingShortcutNotices` with `ctx.ui.notify(notice, "warning")` and clear the array, so a broken file produces exactly one warning per loaded extension and nothing is repeated on a second session.
5. In `src/extension/widget.ts`, append the optional parameter `scrollHint?: string` to `buildWidgetView` at line 86 and pass it into `windowLines` at line 466. Replace the literal `"shift+↑/↓ scroll"` at line 488 with the label when it is defined, and omit that segment when it is undefined. The hint stays a single segment of the existing controls line, so the widget keeps its current row budget.
6. In `src/extension/session-view.ts`, accept the label as one optional construction argument and pass it as the last argument of the `buildWidgetView` call in `render()` at line 102.
7. Add `test/shortcuts.test.ts` covering a missing file, a valid remap, a one-direction remap, `null` on one field, `null` on both, a parse error, a wrong schema, a missing schema, a non-object value, an invalid modifier, an invalid key name, a key without a modifier, a duplicate pair, a key equal to `ctrl+shift+r`, and a reader that throws `EACCES`. Each failure case asserts both the returned shortcuts value and the exact notice text. Assert the hint label cases against exact strings.
8. Extend `test/extension.test.ts` with the registered key list for the default, remapped, both-disabled, duplicate, and reserved-key configurations, a handler case that the configured key moves the widget window, and the notification cases: exactly one warning that names the file and the offending value on the first `session_start` after a bad file, none for a valid file, and no repeat on a second `session_start`. Extend `test/widget.test.ts` for the four hint cases and for the row budget.
9. Update `docs/WORKFLOWS.md` in the widget paragraph of the Model workflow control section around lines 588 to 592, and add one short subsection with the file path, the `PI_WORKFLOWS_CONFIG_DIR` rule, the schema with an example, the omitted-versus-null rule, the validation rules including the reserved `ctrl+shift+r` key and the duplicate rule, the `/reload` requirement, the consequence of disabling both directions, the `pi-background-tasks` conflict and its remedy, and the terminal caveat. Correct `docs/WORKFLOW_SERVER.md` line 395 and the scroll-controls wording in `docs/TUI_VIEWER.md` around line 60. Mention the file in `README.md` only if the README states the scroll keys today.
10. Run the repository gates and one live end-to-end run as listed under Verification.

## Constraints

- Use only documented public Pi extension interfaces. Do not patch Pi core, `node_modules`, or a third-party package.
- Apply the alpha compatibility policy. Change contracts in place, keep existing version identifiers, and add no compatibility shim, alias, dual read, or feature flag.
- Keep the widget scroll feature available by default and keep the widget inside Pi's ten-line limit.
- Do not add arbitrary limits to user-visible output.
- Automated tests must not call a real model and must not write outside temp directories. Every test that loads the extension stubs `PI_WORKFLOWS_CONFIG_DIR` to a temp directory through the existing `makeTempDir` helper.
- Respect the dependency boundaries in `slophammer.yml`. `src/workflows` never imports pi or the other layers, and `src/extension` and `src/viewer` may import `src/workflows` and never each other.
- Use Conventional Commits for commit messages and the pull request title, and cite `osolmaz/pi-workflows#90` in the pull request body. Add no coding-agent branding.

## Verification

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

Then run one live end-to-end run with an authenticated low-cost model, using an exact provider and model id. The run must show the extension loading with no file present, the widget rendering the default hint, and a remapped file changing the hint after `/reload`.

The documented default hint text and the documented example keys must match the exact strings that `scrollShortcutHint` produces, which `test/shortcuts.test.ts` and `test/widget.test.ts` pin. A grep over `docs` for the old fixed wording returns only the sections that intentionally describe the defaults.

## Acceptance criteria

- One documented mechanism, available without patching `node_modules`, sets the scroll-up and scroll-down shortcuts and turns them off.
- With no file present, the extension registers exactly `ctrl+shift+r`, `shift+up`, and `shift+down`, and the widget hint still reads `shift+↑/↓ scroll`.
- When a user remaps or disables the scroll shortcuts, pi-workflows registers neither `shift+up` nor `shift+down`, so pi reports no shortcut conflict that names pi-workflows for those keys.
- The widget hint shows the effective keys and drops the scroll segment when scrolling is off, and the widget stays inside its current row budget.
- An unusable configuration produces one clear message that names the file and the offending value, and registers no shortcut for the affected direction. It never falls back to a default or to another key.
- The resolver tests, the hint label tests, the extension tests, and the widget tests cover the default, remapped, disabled, and invalid paths, and the registered shortcut set is asserted as a list.
- `docs/WORKFLOWS.md` documents the mechanism, the defaults, and the conflict, and the widget documentation matches the rendered hint.
- The four commands above and the live run pass.

## Contract impact

- **New persisted file:** `<configDir>/shortcuts.json`, schema `pi-workflows.shortcuts.v1`, optional fields `scrollUp` and `scrollDown`, each a shortcut string or `null`. The file is optional, and `configDir` follows the existing `PI_WORKFLOWS_CONFIG_DIR` rule.
- **Registered shortcut set:** becomes configuration-dependent. The default set stays exactly `ctrl+shift+r`, `shift+up`, `shift+down` when no file is present. The two hardcoded registrations are removed, not wrapped.
- **Source export:** `buildWidgetView` in `src/extension/widget.ts` gains a trailing optional `scrollHint` parameter, and `SessionWorkflowView` gains one optional construction argument. The positional call sites in `test/widget.test.ts` stay valid.
- **Extension loading:** `src/extension/index.ts` keeps a synchronous default export and reads the file synchronously at load, so no test call site changes shape.
- **Notices:** delivered once per loaded extension through the existing `session_start` notification path.
- **Engine, protocol, SQLite state, viewer, Pi internals, and the public Pi API:** no change.

## Risks

- A silent fallback to defaults could reappear on a bad configuration, which is the failure this issue is about. The resolver returns explicit nulls plus notices and never substitutes a default after a failure, and tests assert that an invalid value and an unreadable file both register no binding for the affected direction.
- Pi keys extension shortcuts by literal key string in a map, so registering one key twice inside one extension silently replaces the earlier binding. A user could move a scroll key onto `ctrl+shift+r` and quietly lose the `/piw` shortcut. Validation rejects a repeated key and a key equal to `PIW_SHORTCUT`, and tests assert the resulting registered set.
- Turning both directions off makes hidden widget rows unreachable, which a user may not expect. The documentation states that consequence, notes that the run stays visible through `/piw`, and notes that the row counters keep showing how many rows are hidden.
- Tests could read the developer's real shortcuts file and become flaky. Every test that loads the extension stubs `PI_WORKFLOWS_CONFIG_DIR` to a temp directory and writes nothing outside temp directories.
- The hint text and the registered keys could drift apart, because they are two consumers of one decision. Both derive from the same resolved object, and tests assert the registered set and the rendered hint in the same scenario.
- A remapped combination might not reach Pi, for example `super`-based keys in a terminal that does not report the modifier. This is outside the extension's control. Validation accepts only Pi's documented key format with at least one modifier, and the documentation recommends the documented keys and states the terminal caveat.
- A user edits the file and sees no effect until the session restarts. The documentation states that `/reload` or a restart applies the change, and the notice for a broken file says the file was ignored.
