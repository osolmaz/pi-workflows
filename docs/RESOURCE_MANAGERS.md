# Resource manager specification

pi-workflows runs finite TypeScript graphs. A graph starts with an input, follows explicit edges, and ends with a result or checkpoint. This works well for one bounded task.

Long-running automation has a different job. It must keep comparing a requested state with the current state of another system. Events can arrive more than once, processes can stop between an external request and its local receipt, and the external state can change while work is running.

This specification adds Kubernetes-style resource management to pi-workflows. The resource manager runtime sits beside the graph engine. Resource managers manage durable resources, while workflows remain finite jobs that a resource manager can start and observe.

The design follows the Kubernetes [controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/), its [`spec` and `status` split](https://kubernetes.io/docs/concepts/overview/working-with-objects/), and the [idempotent reconciliation guidance](https://book.kubebuilder.io/reference/good-practices).

## Scope

The resource manager runtime provides:

- Durable desired and observed state.
- Level-based reconciliation from current facts.
- A deduplicated work queue with delayed retries.
- Compare-and-swap writes for concurrent resource runners.
- Recoverable records for external effects.
- Child workflow runs with stable request keys.
- Conditions and generations, with cleanup and structured events.
- Local resource control through the Pi extension and reconciliation through the global server.

The first production use case is pull request automation. A resource manager can observe a pull request, start a review or repair workflow, wait for checks, validate the current head, and apply an approved change through deterministic code.

## Boundaries

The graph engine remains the execution layer for finite work. A finite workflow can include another finite workflow in the same run through `includeWorkflow()`. Use a resource manager child run when work needs an independent retry history, stable request key, parallel lifecycle, or indefinite reconciliation. The graph engine does not import the resource manager runtime. The resource manager runtime may start workflows through a narrow scheduler interface.

The Pi extension is a thin client. It resolves resource manager initialization in a dedicated child process and sends declarative resource commands to the one global server. The server schedules reconciliation but does not load resource manager definitions in its event loop. A supervised resource runner loads one definition and proposes bounded state changes through the server.

External events are wake-up hints. An event enqueues a resource key and carries no transition command. The reconciler reloads the resource and the external system before deciding what to do.

## Resource model

A managed resource is the durable record of one requested outcome. The resource manager owns `status`; callers own `spec`.

```ts
export type ManagedResource<TSpec, TStatus> = {
  metadata: {
    uid: string;
    resourceManager: string;
    key: string;
    resourceVersion: number;
    generation: number;
    deletionTimestamp?: string;
    finalizers: string[];
  };
  spec: TSpec;
  status: {
    observedGeneration: number;
    conditions: ManagedResourceCondition[];
    workflowRun?: {
      requestId: string;
      runId?: string;
      state: "pending" | "running" | "waiting" | "succeeded" | "failed" | "interrupted";
      attempt: number;
    };
    resourceManagerStatus: TStatus;
  };
};

export type ManagedResourceCondition = {
  type: string;
  status: true | false | "unknown";
  reason: string;
  message?: string;
  observedGeneration: number;
  lastTransitionTime: string;
};
```

`uid` stays stable for the life of the resource and is never reused. `resourceVersion` changes after every write and acts as the compare-and-swap token. `generation` changes only when `spec` changes. A condition describes the latest known state for one stable condition type.

`observedGeneration` shows which desired state produced the current status. A resource manager must not report a resource as ready when its conditions came from an older generation.

## Resource manager contract

A resource manager receives the latest resource, a cancellation signal, and runtime services. It returns after one bounded reconciliation pass.

```ts
import {
  conditionFalse,
  conditionTrue,
  defineResourceManager,
} from "@osolmaz/pi-workflows/resource-managers";

export default defineResourceManager<PullRequestSpec, PullRequestStatus>({
  name: "pull-request",
  initialStatus: () => ({ phase: "observing" }),

  async reconcile(ctx, resource) {
    const pullRequest = await github.getPullRequest(resource.spec, ctx.signal);

    if (pullRequest.merged) {
      return ctx.settled({
        resourceManagerStatus: { phase: "merged" },
        conditions: [conditionTrue("Ready", "Merged")],
      });
    }
    if (pullRequest.headSha !== resource.spec.expectedHeadSha) {
      return ctx.settled({
        resourceManagerStatus: { phase: "blocked" },
        conditions: [conditionFalse("Ready", "HeadChanged")],
      });
    }

    const run = await ctx.workflows.ensure({
      requestKey: `repair:${resource.metadata.generation}:${pullRequest.headSha}`,
      workflow: "repair-pull-request",
      input: { repository: resource.spec.repository, number: pullRequest.number },
    });
    if (run.state !== "succeeded") {
      return ctx.requeueAfter(30_000);
    }

    await ctx.effects.ensure({
      key: `merge:${resource.metadata.generation}:${pullRequest.headSha}`,
      kind: "github-merge",
      request: { number: pullRequest.number, expectedHeadSha: pullRequest.headSha },
      observe: (signal) => github.observeMerge(resource.spec, signal),
      apply: (signal) => github.merge(resource.spec, pullRequest.headSha, signal),
    });
    return ctx.requeue();
  },
});
```

The runtime supports three normal results. `settled` removes the key from the queue until another event arrives. `requeue` asks for another pass as soon as capacity is available. `requeueAfter` schedules a later pass.

A returned error receives exponential backoff with jitter. A resource manager records a durable condition and returns `settled` for a problem that requires new input. Reconciliation retries do not depend on the event that caused the first attempt.

## Work queue

The queue contains one row for each resource manager and resource key. Repeated enqueue calls update that row instead of adding copies. A resource runner claims a key with an opaque claim token and an expiry time. The runtime prevents concurrent reconciliation of the same key.

A claim that expires returns to the queue. A successful settled result removes the queue row. A requested delay updates its available time. Consecutive errors increase an internal retry counter used for backoff.

The local implementation uses `better-sqlite3` in WAL mode. Transactions cover resource compare-and-swap writes, queue claims, and effect claims. `ResourceManagerStore` remains an interface so another server can supply a remote implementation. Pi servers use a store scoped to the canonical project directory, which prevents a same-named resource manager in another project from claiming its resources. The store limits each resource spec and status value to 1 MiB. Event payloads are limited to 64 KiB.

The resource store is the source of truth. Queue rows only describe delivery. A repair can rebuild the queue by enqueuing every resource; each reconciler then computes any needed delay again.

## External effects

An external effect can succeed while the local process is unable to save the response. The runtime records each effect before calling the provider.

```ts
export type EffectRecord = {
  key: string;
  resourceUid: string;
  generation: number;
  requestFingerprint: string;
  state: "pending" | "applied" | "rejected" | "indeterminate";
  externalRef?: string;
  startedAt: string;
  completedAt?: string;
};
```

The key names one intended effect. Reusing the key with another request fingerprint is an error. The next reconciliation observes the external system before retrying an existing pending or indeterminate effect. The effect can be treated as effectively once when the provider offers an idempotency token, a conditional request, or a reliable way to observe the requested result. The runtime does not promise generic exactly-once execution.

Mutation policy stays in deterministic effect drivers. Agent workflows return findings or artifacts for deterministic code to check and apply. Runner processes run as the same operating-system user and are not credential sandboxes. Deployments that require credential isolation should put authenticated effects behind a separate broker.

## Child workflows

`ctx.workflows.ensure()` creates or finds a workflow run by a stable request key and input fingerprint. Repeated reconciliations find the same active or completed request. A changed input must use a new key. An asynchronous child completion validates the reserved request and run IDs through a separate scheduler-completion command; it never reuses the resource manager claim that launched the child. The resource manager transaction reserves and saves each attempt's run ID before the scheduler starts it, so recovery can find the run row.

A child run has one durable execution record. The parent resource points to the current run, and workflow completion enqueues the parent key. The global server runs it through the same queue and supervised runner protocol as other workflows.

A stopped runner does not make the child failed by itself. The server reads the last committed node and effect state. It resumes pure or idempotent work in a new runner epoch. An uncertain manual effect becomes ambiguous and blocks automatic retry. A changed input still requires a new stable request key.

## Deletion and cleanup

Setting `deletionTimestamp` requests deletion. A resource manager with a finalizer first removes external resources it owns, then removes its finalizer. The store deletes the resource after the finalizer list becomes empty.

Resource managers should add finalizers only when they own something that needs cleanup, such as an isolated worktree or a remote action session. Ordinary completed resources can remain as history or be removed by a separate retention policy.

## Sources and runners

A source maps an external event to one or more resource keys. Sources include filesystem watches, webhooks, scheduled polling, and child workflow completion. They share the same enqueue API.

The global server claims resource manager keys and starts a supervised resource runner for each active reconciliation. A reconciliation deadline stops and requeues the child even when resource manager code ignores its abort signal. Reconciler code must still pass the signal to provider calls and keep consequential writes inside guarded effect drivers. One server owns the local database. Distributed leader election remains outside this local runtime.

The extension starts the package server on demand. Reconciliation continues when the Pi session closes. The package installs no operating-system service.

## Observability

Every reconciliation emits structured records with the resource manager name, resource key, generation, reconcile ID, outcome and duration, plus the requeue reason. Effect state changes and child workflow links are also recorded. Logs and viewer projections remain secondary to the resource and effect stores.

`pi-workflows resource-managers` lists resources and their current readiness condition. `pi-workflows resource-manager <resource-manager> <key>` prints one resource together with its effects, child workflows, and recent events. Run views read the same database through query-only connections.

## Safety rules

A production resource manager must follow these rules:

- Read current external state on every reconciliation.
- Check authorization and target boundaries in deterministic code.
- Use provider-side preconditions for consequential writes when available.
- Save status with the resource version that was read.
- Reconcile again after each consequential external effect.
- Keep model output separate from mutation authority.
- Bound runner counts and retry rates. Also bound timeouts and stored payload sizes.
- Redact credentials and private provider responses from logs and SQLite runs.

## Package and Pi integration

The resource manager API is exported from `@osolmaz/pi-workflows/resource-managers`. Resource manager definitions use a `.resource-manager.ts` suffix. Project definitions live under `.pi/resource-managers/`; global definitions live under `~/.pi/agent/resource-managers/`.

The implementation uses documented Pi extension APIs only. `/resource-manager` lists and inspects resources, applies specs, and requests reconciliation or deletion. There are no extension-local runner start or stop controls.

For `apply`, a source resolver child discovers the named resource manager, verifies its exported name, computes `initialStatus(spec)`, and hashes the source. The server accepts the proposal only while the path still follows discovery rules and the exact digest still matches. Reconcile code runs only in a supervised resource runner.

Managed resources use the canonical [SQLite state](SQLITE_STATE.md) database. `projects` separates repository-local resources by canonical project path. ResourceManager claims use the shared lease generation, token, expiry, and expected resource revision. Effects and child workflows use durable request keys and receipts.

One global server owns that database for all Pi sessions and projects. The extension and mutating CLI paths are local protocol clients; viewers remain read-only. A resource manager child without an origin session uses a headless `pi --mode rpc` process for structured agent steps.

Normal workflow prompts, tool calls, and replies remain part of the Pi session. No Pi internal type, private API, or persistent Pi schema changes.

## Exclusions

This specification does not add Kubernetes API compatibility, YAML resources, a cluster scheduler, or a general distributed database. GitHub policy and credentials belong in a provider adapter, leaving the resource manager core independent of GitHub. The first release also excludes automatic service installation and generic exactly-once claims.
