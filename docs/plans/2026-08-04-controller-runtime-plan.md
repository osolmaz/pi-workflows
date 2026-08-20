---
title: Add a durable controller runtime
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-04
updated: 2026-08-04
status: implemented
---

# Controller runtime plan

pi-workflows needs a controller mode for automation that spans repeated events, external state changes, and process restarts. The design in [CONTROLLERS.md](../CONTROLLERS.md) follows the Kubernetes controller pattern. Durable resources hold desired and observed state, events enqueue resource keys, and each reconciliation reads current facts before acting.

The implementation keeps the graph engine focused on finite jobs. Controllers start and observe workflows through a child-run interface. Workflow graphs keep their finite execution model.

## Shipped design

The implementation follows [CONTROLLERS.md](../CONTROLLERS.md) with these resolved choices:

- The local store uses `better-sqlite3` because the Node 22 SQLite module still emits an experimental warning.
- Controllers are discovered from `.pi/controllers/` and `~/.pi/agent/controllers/`.
- The existing `pi-workflows` executable provides read-only `controllers` and `controller` commands. Headless workers use the public `ControllerManager` API.
- The TypeScript CLI lists and inspects resources. The Rust viewer understands interrupted workflow runs. Resource views stay in the CLI for this release.
- Per-controller concurrency limits are manager configuration, while controller definitions contain reconciliation behavior and timeout only.

The persisted model was reviewed with Schemator before implementation. The review removed generic timestamps from public resources, kept provider details opaque, moved concurrency policy to the manager, and tightened event payloads to recursive JSON values. The run failed aggregate validation on two proposed structural moves, so those moves received a manual review instead of automatic application.

## Requirements

The first release must provide:

- Typed controller definitions and durable resources with `spec`, `status`, generations and conditions, plus compare-and-swap versions.
- A durable keyed queue with deduplication, delayed wakeups, bounded concurrency, retry backoff, and expiring claims.
- Level-based reconciliation that receives a resource instead of an event payload.
- Effect records that recover safely when a process stops around an external mutation.
- Stable child workflow requests and completion wakeups.
- Deterministic mutation authority outside agent workflows.
- Public engine APIs, a Pi extension control surface, and local read-only status views.
- Tests for retries, duplicate events, conflicts, process interruption, and ambiguous external effects.

## Assumptions

The default controller store will use SQLite and local filesystem permissions that match the private run-bundle directory. The public store and queue contracts will allow another host to provide remote storage later.

The first release will support several workers in one process. Queue claims will survive process failure, but cross-host leader election will wait for a real remote deployment.

Existing workflow definitions and run bundles remain valid. Controller resources use a separate schema and store. Child workflow attempts use the current run-bundle format; their parent links live in the controller store.

## Open questions

Implementation should resolve these points before the public API is frozen:

- Confirm that the built-in Node SQLite API meets package portability and transaction requirements on every supported Node 22 release. Choose one documented dependency if it does not.
- Decide whether controller discovery belongs in `.pi/controllers/` and `~/.pi/agent/controllers/`, or whether controllers should be registered only from installed packages.
- Decide whether the existing `pi-workflows` executable should gain controller subcommands or whether the package should expose another binary.
- Set queue claim and retry defaults from local fault tests. Use the same evidence for retention and payload limits.
- Define the smallest viewer change that makes blocked and indeterminate resources easy to find.

## Source layout

Add a `src/controllers/` layer with no dependency on Pi:

```text
src/workflows/                 finite graph execution
src/controllers/types.ts      resources, conditions, results, definitions
src/controllers/store.ts      store and queue interfaces
src/controllers/sqlite.ts     local durable implementation
src/controllers/manager.ts    claims, workers, retries, cancellation
src/controllers/effects.ts    effect lifecycle and recovery
src/controllers/workflows.ts  child workflow scheduler adapter
src/extension/                 Pi commands and lifecycle hooks, plus UI
src/viewer/                    read-only local views
```

`src/workflows` must never import `src/controllers`. The controller layer may depend on exported workflow contracts through `controllers/workflows.ts`. The extension and viewer may use both layers and remain independent from each other. Update `slophammer.yml` before adding cross-layer imports.

## Work stages

### Resource contract

Define the TypeScript API, persisted schemas, condition helpers, generation rules, and compare-and-swap behavior. Review the persisted model with Schemator before implementation. Document the final decisions in [CONTROLLERS.md](../CONTROLLERS.md).

Add tests for spec updates, status-only writes, stale versions, condition transition times, deletion requests, and finalizer removal. A spec update must increase `generation`; a status update must preserve it.

### Store and queue

Implement the SQLite store in WAL mode with restrictive file permissions. Keep schema migration code explicit and fail closed on unknown schema versions.

Implement one queue row per controller and resource key. Enqueue must deduplicate, an expired claim must become available again, and a delayed requeue must survive process restart. Add bounded exponential backoff with jitter and a test clock.

Run concurrent worker tests that force compare-and-swap conflicts and claim expiry. All tests must use temporary directories.

### Controller manager

Implement `defineController`, `ControllerManager`, and the settled, immediate requeue, and delayed requeue results. Reconciliation requests carry a key; the manager reads the resource immediately before calling user code.

Enforce one active reconciliation per key. Apply returned status against the version that was read. A conflict discards the stale status and queues another pass. Add global and per-controller worker limits.

Emit structured lifecycle records with stable reconcile IDs and bounded error messages. Cancellation must stop new claims and give active reconcilers a fixed shutdown period.

### Effect recovery

Implement `ctx.effects.ensure()` around a request fingerprint and stable key. Save the pending record before calling the provider. Record each outcome as applied, rejected, or indeterminate without treating a local timeout as proof that the provider failed.

Require every effect driver to define observation and application behavior. Reusing a key with different input must fail. Add crash tests around the claim and provider request, then after the response and receipt storage.

Use a fake provider to prove that an indeterminate merge-like operation is observed before any retry. Test provider idempotency tokens and conditional request failures separately.

### Child workflows

Implement `ctx.workflows.ensure()` with a stable request key and input fingerprint. A repeated call must find the same active or completed request. A completion or interruption must enqueue the parent resource.

Keep run attempts immutable. Add an explicit interrupted outcome for an abandoned child attempt. Route action nodes through the effect interface when they participate in a controller operation. Document the recovery rule for each node type.

Test duplicate child requests, changed fingerprints, completion races, parent generation changes, and host restart between run creation and parent status update.

### Extension and viewer

Add controller discovery and a `/controller` command for listing resources, inspecting conditions, requesting reconciliation, and cancelling active local work. Use only documented Pi extension APIs.

Start local sources from `session_start` and close them idempotently during `session_shutdown`. Pi exit must leave durable resources and queue rows ready for another host. No background service is installed.

Add a resource list and detail view to the TypeScript viewer first. Extend the Rust viewer only after the text model and fixtures settle. Keep both views read-only.

### Acceptance controller

Build a local pull request controller against a fake GitHub-compatible server. Its spec names a repository, pull request, expected head, requested workflow, and approved mutations. Its status reports the observed head and child run together with check results and readiness conditions.

The controller must re-read the pull request before each effect. A changed head blocks the mutation. Duplicate webhooks and scheduled polls must converge on the same resource and child workflow request. No credential belongs in the child request. Strict credential isolation requires a separate authenticated effect broker because the Pi host and agent tools share a process environment.

Keep this controller as an example or integration package. GitHub-specific policy must stay outside the controller core.

## Acceptance criteria

The work is ready when all of the following hold:

- Ten identical enqueue calls produce one pending key and no duplicate child run.
- Two workers cannot reconcile the same key concurrently.
- A stale resource version cannot overwrite newer status.
- A spec change invalidates readiness from an older generation.
- Delayed work and expired claims recover after a fresh process opens the store.
- Each tested process stop around an external effect converges without an unobserved retry.
- A changed pull request head prevents the acceptance controller from applying its effect.
- The acceptance controller applies agent output only after deterministic authorization and precondition checks.
- Pi reload and shutdown leave no in-memory state required for later recovery.
- Current workflow and viewer tests keep passing, along with run-bundle tests.

## Verification

Run the focused controller tests during each stage, followed by the full repository checks:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
```

Exercise the Pi extension from source with `pi -e src/extension/index.ts`. Start a controller resource, stop Pi while work is pending, reopen the same store, and confirm that reconciliation continues from current state. Repeat the effect crash matrix with the fake provider and preserve the test output as CI evidence.

## Non-goals

The first implementation will not provide Kubernetes API compatibility, a distributed cluster scheduler, automatic service installation, or generic exactly-once execution. It will not place GitHub credentials or mutation policy in agent prompts. It will not use run bundles, comments, or viewer projections as the controller database.

## Documentation updates

Update [CONTROLLERS.md](../CONTROLLERS.md) whenever the public resource, queue, reconciliation, or effect contracts change. Add the shipped authoring surface to [workflows.md](../workflows.md), the source boundaries to [development.md](../development.md), and user-facing installation and commands to the root README after implementation.

Record any meaningful departure from this plan in this document before the implementation is considered complete.
