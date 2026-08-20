# Workflow composition

pi-workflows can include one workflow inside another without copying nodes, prompts, or routing logic. The included workflow still runs on its own. The parent supplies input and connects the included workflow's named exits to later parent steps.

Composition keeps one run, trace, pause state, cancellation state, and final presentation. Controllers remain the correct tool for independent or indefinitely reconciled child runs.

Work is tracked in the [workflow composition plan](plans/2026-08-19-workflow-composition-plan.md).

## TypeScript API

A TypeScript workflow definition is both executable code and a typed contract. Its input parser and exit parsers provide runtime validation and TypeScript inference from one declaration.

```typescript
import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

type RepairInput = { task: string };
type Fixed = { summary: string };
type Blocked = { reason: string };

export default defineWorkflow({
  source: import.meta.url,
  name: "repair",
  input: (value): RepairInput => {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as RepairInput).task !== "string"
    ) {
      throw new Error("repair input requires task");
    }
    return value as RepairInput;
  },
  startAt: "implement",
  exits: {
    fixed: {
      from: "finish",
      validate: (value): Fixed => value as Fixed,
    },
    blocked: {
      from: "blocked",
      validate: (value): Blocked => value as Blocked,
    },
  },
  nodes: {
    implement: agent({
      prompt: ({ input }) => `Implement ${input.task}`,
      expectedOutput: `{ "route": "fixed" | "blocked", "summary": "result" }`,
    }),
    finish: compute({ run: ({ outputs }) => outputs.implement }),
    blocked: compute({ run: () => ({ reason: "repair could not continue" }) }),
  },
  edges: [
    {
      from: "implement",
      switch: {
        on: "$.route",
        cases: { fixed: "finish", blocked: "blocked" },
      },
    },
  ],
});
```

### Direct imports

Direct imports are the normal TypeScript interface. `includeWorkflow()` checks the mapped input and makes the child exit names available to the parent definition.

```typescript
import { agent, compute, defineWorkflow, includeWorkflow } from "@osolmaz/pi-workflows";
import repair from "./repair.workflow.js";

export default defineWorkflow({
  source: import.meta.url,
  name: "monitor-with-repair",
  startAt: "check",
  includes: {
    repair: includeWorkflow(repair, {
      input: ({ outputs }) => ({
        task: (outputs.check as { issue: string }).issue,
      }),
    }),
  },
  nodes: {
    check: agent({ prompt: () => "Check the target." }),
    wait: compute({ run: () => ({}) }),
    finish: compute({ run: ({ outputs }) => outputs.check }),
  },
  edges: [
    {
      from: "check",
      switch: {
        on: "$.route",
        cases: { continue: "wait", repair: "repair", stop: "finish" },
      },
    },
    { from: "wait", to: "check" },
    { from: "repair.fixed", to: "check" },
    { from: "repair.blocked", to: "finish" },
  ],
});
```

`repair` is the only parent-visible entry. `repair.fixed` and `repair.blocked` are its exits. The parent cannot connect to an internal child node.

### Dynamic references

Names and paths remain available for project overrides and configuration-driven loading:

```typescript
includeWorkflow({ workflow: "repair", input: mapRepair });
includeWorkflow({ workflow: "builtin:repair", input: mapRepair });
includeWorkflow({ workflow: "./repair.workflow.ts", input: mapRepair });
```

A dynamic reference is resolved before the run starts. Runtime input and exit validation still applies. A direct import gives better TypeScript inference and is preferred when the parent and child ship together.

Relative references resolve from the including workflow file. Absolute paths keep their normal meaning. Project and global lookup remain available, as do built-ins. Built-ins cannot use relative paths unless their definitions use direct imports.

## Definition rules

- A workflow has one entry through `startAt`.
- A workflow can declare several named exits.
- Each exit points to one successful terminal node.
- One terminal node can define at most one exit.
- Exit and mount names use the normal node-name rules.
- A parent edge enters a child through the mount name.
- A parent edge leaves a child through `<mount>.<exit>`.
- Parent edges cannot name child nodes.
- The same child source can be mounted several times under different names.
- Re-entering a mount creates a fresh invocation.

A standalone workflow ignores its exit names for routing. Its terminal node completes the run as before.

## Typed contracts

`WorkflowDefinition` carries generic input and exit types. `includeWorkflow()` uses them to check the parent input mapper and expose a discriminated child result:

```typescript
type RepairResult = { exit: "fixed"; output: Fixed } | { exit: "blocked"; output: Blocked };
```

The parent reads the latest result from `outputs.repair`. `includedResult(repairWorkflow, outputs.repair)` returns the discriminated result type without a cast. Unknown exit names and incompatible direct-import input mappers are TypeScript errors. Dynamic references use runtime checks and can supply an explicit contract when compile-time checking is required.

`defineWorkflowRegistry()` creates a typed set of shipped workflows. Shipped contracts use a stable `contractId`. A project or global override must match that identity and keep the registered input and exit shape. The selected source remains subject to the normal project, global, and built-in precedence rules.

## Resolution

Composition is resolved before `run_started`.

1. Resolve the root source.
2. Resolve every direct or dynamic child reference.
3. Repeat for nested includes.
4. Validate each standalone graph and its input and exit declarations.
5. Reject source cycles and report the full mount chain.
6. Build one executable graph with qualified node names.
7. Freeze the source set and resolved definition digest.

Resolution is eager. An unused include must still exist. A workflow reference cannot change after the run starts.

Direct and indirect source cycles are invalid:

```text
A -> A
A -> B -> A
A -> B -> C -> A
```

Using one source at independent mount paths is valid:

```text
monitor/initialDesign
monitor/implementation/redesign
```

## Runtime behavior

### Local child context

A child callback receives:

- its mapped and validated input;
- outputs and results from its current invocation under local node names;
- local steps for its current invocation;
- the local current node name;
- the root run ID and active abort signal.

A child cannot read parent state except through mapped input. A parent sees only the declared child result.

### Re-entry

Each mount entry starts with empty local outputs and results. Earlier invocation data stays in the trace but cannot satisfy callbacks in a later invocation. The latest named exit replaces the parent-visible mount output.

### Limits and progress

The root `maxSteps` limits all real node attempts in the run. Each child `maxSteps` limits one invocation. Include entry and exit transitions are recorded but do not count as user-authored node attempts.

A repair loop must also check useful progress. A repeated issue stops as blocked when the issue, plan, implementation revision, supporting evidence, and target state have not changed. `maxSteps` remains the final safety bound.

### Failures, pauses, and cancellation

Child nodes keep their normal timeouts. Unhandled failures, timeouts, cancellations, and routing errors keep their existing run outcome. A parent cannot turn an unhandled failure into success through a named exit.

A checkpoint inside a child uses the normal continuation behavior and resumes at the qualified child location. Pause and cancellation apply to the complete run.

### Reports and presentation

Notify nodes and updates keep qualified node identities. Only the root workflow produces final presentation. A child's `presentationPrompt` applies when the child runs alone and is ignored when included.

## Persistence

Composition extends the existing run bundle.

The manifest and state record:

```json
{
  "workflowSource": {
    "kind": "file",
    "path": "/path/to/monitor.workflow.ts",
    "hash": "1111111111111111111111111111111111111111111111111111111111111111"
  },
  "workflowSources": [
    {
      "mountPath": ["repair"],
      "workflowName": "repair",
      "source": {
        "kind": "file",
        "path": "/path/to/repair.workflow.ts",
        "hash": "2222222222222222222222222222222222222222222222222222222222222222"
      }
    }
  ],
  "definitionDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

`workflowSources` is sorted by mount path. The definition snapshot records the resolved mounts and qualified graph. The trace adds `include_entered` and `include_exited` events with mount path, invocation number, and named exit. It does not copy source text or credentials.

Resume resolves and verifies the complete source set and definition digest. Any missing or changed child source refuses normal resume. Old runs without composition metadata remain readable.

## Viewer behavior

Existing readers can render qualified nodes as a flat graph. Updated viewers group nodes under their mount path while keeping the exact qualified name available in details and replay.

```text
monitor
  initialDesign
    frame
    choose
    plan
  implementation
    implement
    verify
    redesign
      frame
      choose
      plan
```

## Autoplan, autodoc, and autoimplement

`autoplan` accepts the problem, scope, constraints, an optional previous plan, and new evidence. It automatically selects the best practical in-scope solution. The ideal end state can win when it is feasible, but an unavailable upstream change cannot block a valid practical solution. It exits through `ready` or `blocked` and returns a plan digest and change status.

`autodoc` accepts an already selected plan or finds it in the active conversation and referenced canonical documents. It adopts current documentation or updates the canonical specification and implementation plan, runs documentation checks, and returns a documented-plan record. It never selects a solution or implements one.

`autoimplement` requires a clear existing plan, but the structured `plan` input is optional because the plan can already be in conversation context or canonical documentation. It blocks when it cannot find a clear plan. It skips autodoc when documentation is current and includes autodoc when documentation is missing or stale. The absence of `input.plan` never routes to initial autoplan.

Autoimplement includes `autoplan` only as evidence-driven `redesign`. When implementation, verification, review, comments, or CI proves that the approach is wrong, the revised plan passes through autodoc before implementation resumes. Local bugs go to a fix step instead.

Review rounds record findings at every severity from P0 through P2. P0 or P1 findings require another implementation and review round. A P2-only round can be addressed, but the workflow does not run the reviewer again solely because P2 work changed files.

Reviewer and CI commands record the executable, arguments, working directory, and timeout as structured fields. A failed reviewer invocation returns to a model step that corrects the command. The executable remains `pi-reviewer`; no hidden reviewer substitution is allowed.

A CI wait is bounded to five minutes. If CI remains pending, the workflow asks the model to run additional useful local tests. It does not spend another model turn waiting and checks CI again after the tests.

Autoimplement prepares a ready PR by default. It merges only when its input explicitly sets `merge: true`. Monitor repair passes that permission only when `repair.merge` is explicitly true. Required CI still gates merge unless repository policy permits a documented unrelated failure.

## Monitor repair

Monitor remains observation-only unless its input explicitly authorizes mutation. An authorized repair path is:

```text
check
  -> initialDesign: autoplan
  -> documentation: autodoc
  -> approval: plan-approval when requested
       -> replan: initialDesign
  -> implementation: autoimplement
       -> redesign: autoplan -> autodoc when needed
  -> check
```

The outer `autoplan` creates the first plan. Autodoc records it before implementation. An optional plan approval gate can continue, stop, or return exact replan instructions to autoplan. The inner redesign mount revises a plan only when new evidence invalidates it and records the revision through autodoc. The monitor checks the target again after implementation and does not trust a repair claim by itself.

A protected change to model choice, benchmark method, credentials, hardware, spending authority, or another user decision exits as blocked. The workflow never changes the protected part of the task silently.

## Compatibility and release

Workflows without inputs, exits, or includes run unchanged. Existing controller child workflows remain unchanged. Existing terminal run bundles remain readable.

This is a compatible public API addition under the project's pre-1.0 policy. It targets `0.10.0` if no earlier release changes the next version.

## Contract impact

- **Session state:** normal workflow messages and tool results only.
- **Other persistent data:** additive source and mount data, definition digests, and include events in existing run bundles.
- **Pi internals:** none.
- **Public Pi API:** existing extension APIs only.
- **Public pi-workflows API:** typed workflow inputs and exits, `includeWorkflow()`, direct imports, dynamic references, and `defineWorkflowRegistry()`.

## Required tests

The implementation must cover:

- standalone workflows with exits;
- direct typed imports and dynamic references;
- compile-time invalid input and exit examples;
- runtime input and exit validation;
- one and several named exits;
- nested and repeated mounts;
- re-entry without stale data;
- source-cycle rejection;
- root and per-invocation step limits;
- failures and timeouts plus cancellation, checkpoint resume, and pause behavior;
- changed child sources and changed definition digests;
- include trace events and definition snapshots;
- flat and grouped rendering;
- reviewer command correction;
- P0 through P2 plus clean review routes;
- five-minute CI wait and opportunistic testing routes;
- monitor observation-only and authorized repair modes;
- repeated repair with no progress;
- real-Pi execution of nested monitor repair.
