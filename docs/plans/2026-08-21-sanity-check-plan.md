---
title: Run Sanity Check with Provider Extensions
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-21
updated: 2026-08-23
status: implemented
---

# Run Sanity Check with Provider Extensions

## Goal

Use direct Pi SDK sessions for the built-in `sanity-check` workflow. Each reviewer gets an independent in-memory context. Each child can load the extension that owns its exact configured model provider, while only the parent workflow action can control workflow state.

The child must use the configured provider, model, thinking level, and provider-owned authentication. It must fail before prompting if that exact dispatch is not available. It must never silently use OpenRouter, Kimi, a local model, or another fallback.

The workflow keeps only the final bounded answer and safe operational facts. It does not keep child prompts, reasoning, message history, tool arguments, tool results, repository content, credentials, or extension-private state.

## Scope

The change is limited to Pi Workflows. It changes the private SDK agent-group runner, Sanity Check composition, extension admission, model runtime construction, tests, and canonical documentation.

The workflow continues to use existing `action`, `compute`, and `notify` nodes. `src/workflows` and `WorkflowActionContext` remain Pi-independent. The change does not add a workflow primitive, public agent-group export, persisted schema, child workflow run, service, queue, store, transport, Pi core change, or private Pi API.

Sanity Check keeps its existing input, review areas, prompts, evidence rules, session counts, strict result validation, verdicts, final notification, and progress schema.

## Child session contract

Each child session:

- has independent in-memory context and history;
- uses `SessionManager.inMemory` and creates no Pi session file;
- owns a separate `ModelRuntime`, provider instance, extension runtime, resource loader, and `AgentSession`;
- can use only the verified built-in `read`, `grep`, `find`, and `ls` tools;
- may load the extension that registers the exact configured provider;
- may load another behavior extension only through an explicit private allowlist;
- loads no skills, prompt templates, themes, or context files;
- does not receive the workflow tool, workflow commands, parent run id, node id, attempt id, update channel, or workflow callback;
- returns only bounded final assistant text and bounded safe lifecycle facts;
- shares the parent Node process and does not provide OS process isolation.

Pi extensions are trusted in-process code. The runner prevents normal model, tool, command, and callback access to workflow state. It does not sandbox an extension that directly uses the filesystem or network.

## Input and review modes

The workflow input stays unchanged. Serial mode remains the default.

```json
{
  "mode": "serial",
  "baseRef": "origin/main"
}
```

`mode` is `serial` or `parallel`. The current repository and checked-out branch are the contribution under review. When `baseRef` is omitted, the workflow tries the remote default branch, the current branch upstream, and the first parent, then uses `HEAD` for a working-tree-only review.

Serial mode creates one review session for all four review areas, then one verification session. It uses two model sessions.

Parallel mode creates four focused review sessions at the same time, then one verification session. It uses five model sessions.

The agent-group runner enforces maximum concurrency and returns results in request order. A material failure stops queued work, aborts active siblings, waits for every started child to settle, and keeps the first failure as the primary cause.

## Evidence and results

The first node collects facts without model judgment. It uses fixed, non-mutating commands to collect:

- pull request intent and linked issue context when available;
- stated acceptance criteria;
- base and head revisions;
- changed files;
- the diff and diff statistics;
- relevant new exports, schemas, persisted fields, and nearby existing code.

Pull request and repository text is untrusted evidence, not instructions. Evidence and review inputs stay bounded before they enter a model prompt or run bundle.

The verification session receives the evidence and review results. It must remove unsupported claims, require exact file and symbol references, separate facts from assumptions, resolve supported conflicts, and place unresolved questions in `unknowns` or contributor questions. It returns `keep`, `simplify`, `refactor`, `drop`, or `needs_evidence`.

The existing strict result parsers stay unchanged. They continue to enforce all review areas, evidence, acceptance case, verdict, string, and item limits.

## Provider-first extension profile

The runner resolves one immutable child profile before it starts the group.

### Resolve candidate paths

Use `SettingsManager` and `DefaultPackageManager.resolve()` to find enabled extension paths without executing extension factories. Canonicalize and deduplicate the paths.

The default candidate set contains enabled user-scope extensions. Project extensions are excluded unless the private policy admits them explicitly. Direct and wrapper paths for Pi Workflows are excluded before any extension factory runs.

### Preflight provider ownership

Load candidate extensions in a no-session `DefaultResourceLoader` preflight. Pass the paths through `additionalExtensionPaths` and set `noExtensions: true` so the loader does not perform a second discovery pass.

Inspect documented pending native and legacy provider registrations. Admit the one extension path that registers the exact configured provider. Permit other behavior extensions only through an explicit private allowlist.

Fail before session creation when:

- no extension registers the configured provider;
- more than one extension claims the configured provider;
- an extension fails to load;
- an admitted extension registers a reserved workflow tool or command;
- an extension replaces `read`, `grep`, `find`, or `ls`;
- a loaded path is outside the frozen candidate snapshot.

Before invalidation, dispatch `session_shutdown` through a temporary public `ExtensionRunner` so factory-owned setup can clean up. Preflight does not create a session or dispatch `session_start`. Always invalidate the preflight extension runtime in `finally`.

Extension factories run before their registrations can be inspected. Pi documents that factories must not start background resources. Pi Workflows relies on that contract and does not claim to contain a factory that violates it.

## Exact model dispatch

Resolve one immutable `{ provider, modelId, thinkingLevel }` value for the group. A complete explicit override wins. Otherwise, use the configured `SettingsManager` defaults. Reject partial overrides, missing defaults, unsupported thinking values, and prompts that start with an extension slash command.

Read and strictly validate the configured cached model catalog once. Keep it as an in-memory group snapshot. Create a deep-cloned in-memory model store for each child. Do the same for ordinary Pi credentials read from `auth.json`. Pi Workflows never writes these snapshots back.

Provider extensions use their existing provider-owned credential store in place. Pi Workflows does not copy, inspect, print, migrate, or persist those credentials.

For each child:

1. Create a fresh non-networked `ModelRuntime` from cloned snapshots.
2. Create a fresh resource loader with only the frozen admitted extension paths.
3. Disable secondary extension discovery, skills, prompt templates, themes, and context files.
4. Load a fresh extension and provider instance.
5. Find the exact cached model and pass it to `createAgentSession`.
6. Pass the exact configured thinking level.
7. Verify the session's actual provider, model, thinking level, authentication, extension state, active tools, and built-in tool sources.
8. Start the prompt only after all checks pass.

Any mismatch is terminal. The runner does not select another provider, model, or thinking level.

A transient model selected only in the parent TUI is not inherited. The runner enforces the configured process default unless the private request gives a complete explicit dispatch.

## Workflow authority boundary

The parent Sanity Check action is the only workflow owner.

Children receive only the built-in read-only tool instances requested by Sanity Check. Extension tools can register but remain inactive. The runner rejects same-name replacements for the built-in tools.

Children receive no:

- `workflow` tool;
- `/workflow`, `/piw`, `/controller`, or workflow-channel command;
- run, node, or attempt identifier;
- workflow update, answer, submit, pause, resume, or cancel callback;
- child workflow run or parent workflow handle.

The runner rejects prompts that would invoke extension slash commands. These controls prevent the normal child model and admitted extension bindings from inspecting or changing workflow state.

## Lifecycle and privacy

One owner controls each child from creation through cleanup.

The owner:

1. Creates the child runtime and session.
2. Subscribes before prompting.
3. Emits only bounded safe lifecycle phases.
4. Waits for prompt settlement.
5. Extracts only the latest final assistant text.
6. Bounds the returned text before validation.
7. Calls and awaits `abort()` on timeout or cancellation.
8. Waits for prompt settlement after abort.
9. Unsubscribes.
10. Disposes the session so extension shutdown runs.
11. Invalidates remaining extension runtime state.
12. Releases provider resources.

Cleanup runs for success, creation failure, authentication failure, provider failure, malformed output, timeout, parent cancellation, sibling failure, and disposal failure. A cleanup failure remains a bounded secondary diagnostic and does not replace an earlier primary error.

The workflow never copies extension events or extension-private state into progress or run bundles.

## Progress and visibility

Sanity Check keeps the existing `pi-workflows.progress.v1` records and keys:

```text
agents/review
agents/review/necessity
agents/review/duplication
agents/review/contracts
agents/review/scope_tests
agents/verification
agents/verification/verification
```

Aggregate tracks report completed and total sessions. Child tracks report a bounded role label, the verified actual model when known, and a safe phase such as `starting`, `thinking`, `tool: read`, `finalizing`, or a terminal phase.

Updates are deduplicated, throttled, and observational. They cannot change agent execution.

The Pi widget shows the aggregate plus failed and active children within its ten-line limit. `piw` shows all durable child tracks and samples. Both views use existing progress records. No new persisted field or schema is added.

## Implementation plan

1. Update the Pi SDK development baseline to one compatible 0.84.x release. Keep the Pi coding-agent, Pi AI, and Pi TUI packages aligned and set an honest peer compatibility floor. Do not add Pi Factory or a provider extension as a dependency.
2. Add the private dispatch and child extension profile contracts under `src/builtins`. Do not export them from package entry points.
3. Resolve enabled extension paths without execution. Canonicalize paths, exclude project extensions by default, and exclude direct and wrapper Pi Workflows paths.
4. Add the no-session extension preflight. Identify the exact native or legacy provider owner and reject reserved workflow capabilities, provider conflicts, load errors, and built-in tool overrides.
5. Keep the model-catalog snapshot work, but change it to one validated group snapshot and one clone per child. Add the same ownership for ordinary Pi credentials. Remove the previous empty-catalog behavior.
6. Replace the shared group `ModelRuntime` with one complete runtime per child.
7. Verify exact provider, model, thinking, authentication, admitted extensions, active tools, and tool sources before every prompt.
8. Complete provider, extension, and session cleanup on every exit path.
9. Pass the private profile and exact dispatch through Sanity Check without changing its review behavior or progress schema. Remove any `--no-extensions` launch guidance.
10. Change the built-in Sanity Check revision from 2 to 3.
11. Add temporary fixture extensions and full unit, integration, interactive Pi, and standalone host coverage.
12. Update this plan and `docs/workflows.md` to match the shipped behavior.
13. Run the complete repository gate and inspect the full public diff.
14. After mock-provider verification, run one bounded real acceptance on OpenClaw pull request 126028 with `openai-codex/gpt-5.6-sol` and high thinking. Abort immediately if any child reports another provider or model. Do not modify OpenClaw.

## Revision and compatibility

Sanity Check moves from built-in revision 2 to revision 3.

This is an alpha hard cutover. Do not retain the revision-2 child runtime, fallback, compatibility runner, migration, alias, dual path, or feature flag. An unfinished revision-2 run must fail with clear cancel-and-restart guidance. Terminal revision-2 bundles remain readable historical evidence because the persisted schema does not change.

## Tests

Unit and integration tests must cover:

- dispatch parsing and exact provider, model, and thinking enforcement;
- missing authentication and no fallback;
- extension path resolution, canonicalization, scope filtering, disabled paths, and explicit behavior paths;
- direct and wrapper Pi Workflows exclusion;
- native and legacy provider-owner discovery;
- reserved workflow command and tool rejection;
- inactive extension tools and built-in tool override rejection;
- per-child runtime, provider, extension, loader, and history isolation under parallel execution;
- validated model and credential snapshots, deep clones, cancellation, malformed input, and no writes;
- provider-owned mock authentication without credential exposure;
- success, provider error, empty output, malformed output, oversized output, timeout, cancellation, fail-fast, and cleanup-error precedence;
- final-only retention and absence of private child content in results, errors, updates, and bundles;
- serial two-session and parallel five-session behavior;
- existing progress keys, model labels, throttling, and rendering;
- interactive Pi with normal extensions enabled and the local mock provider;
- standalone `WorkflowHost` through the same private runtime path;
- no child session files or child workflow runs;
- built-in revision 3 and historical terminal bundle reading;
- final notification without another model turn.

Tests use mock providers and temporary directories. They do not call real models or write outside temporary directories.

Before completion, run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

After these checks and Pi Reviewer pass, perform the one explicitly authorized bounded GPT-5.6 Sol acceptance run.

## Acceptance criteria

The implementation is complete when:

- `/workflow sanity-check` discovers built-in revision 3;
- the parent Pi process runs with its normal configured extensions;
- serial mode uses two independent in-memory SDK sessions;
- parallel mode uses five independent in-memory SDK sessions, with four reviews running concurrently;
- every child loads the extension that owns the exact configured provider;
- every child reports the exact required provider, model, and thinking level before prompting;
- no child silently falls back to OpenRouter, Kimi, a local model, or another dispatch;
- children use only verified built-in read-only tools and create no session files;
- children cannot use normal workflow tools, commands, identifiers, or callbacks;
- the workflow keeps only bounded final answers and safe operational facts;
- child prompts, reasoning, tool payloads, histories, credentials, and extension state do not enter run bundles or progress updates;
- provider, extension, and session cleanup completes on every exit path;
- Sanity Check review behavior, strict validation, verdicts, progress, and final notification remain unchanged;
- interactive and headless runs use the same private SDK path;
- all required checks pass with coverage margin;
- the bounded acceptance run on OpenClaw pull request 126028 reports GPT-5.6 Sol for every child and completes with a strict verdict without modifying OpenClaw.

## Contract impact

- **Origin session:** The normal workflow start record and one final workflow notification.
- **Parent extensions:** The parent Pi process loads its normal configured extensions.
- **Child extensions:** Only the exact provider owner and explicit private behavior paths are admitted.
- **Child sessions:** Independent in-memory contexts and complete per-child runtimes in the same Node process. No child session file or child workflow run.
- **Model dispatch:** Exact provider, model, and thinking are required. Fallback is forbidden.
- **Credentials:** Pi Workflows does not copy or persist credentials. Provider extensions use their existing stores in place.
- **Other persistent data:** The normal workflow run bundle and existing progress updates only.
- **Private content:** Prompts, reasoning, intermediate messages, tool payloads, histories, credentials, and extension-private state are not persisted by Pi Workflows.
- **Pi public API:** Documented package manager, resource loader, extension and provider registration, model runtime, session, event, abort, and disposal APIs only.
- **Pi Workflows public API:** No change.
- **Isolation:** Workflow capability is withheld from normal child bindings. Arbitrary trusted in-process extension code is not sandboxed.
