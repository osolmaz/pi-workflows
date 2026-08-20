---
title: Add always-on workflow execution
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-05
updated: 2026-08-05
status: implemented
---

# Always-on workflows plan

pi-workflows should feel the same whether the user watches a run or walks away from it. In the user's words: "I might start a workflow locally in Pi then I wait for it to complete. All the while I am looking at the screen and I'm not closing the Pi window. When the workflow ends I just want to be able to continue the same Pi session like normal with a session up to date with what happened in the workflow." And: "I just want to interact by starting a workflow, closing it, and then coming back and then still being able to continue it when I open it up. It's syncing continuously or something."

These are not two modes. The user asked for "both in a single unified system." This plan makes the Pi window irrelevant to execution: closing or opening the window is a change in observation, not in the run. The work stays on one machine, uses the merged controller runtime as its foundation, and does not modify Pi core.

This revision incorporates an external design review of the first draft. The review confirmed the three design rules and found five structural gaps in the details. The Decisions section resolves each one before implementation starts.

## Design

Four rules define the system:

1. **Durable state is the only source of truth.** Run bundles, the queue, and the event log live on disk. Nothing important lives in a session's memory.
2. **Runners are interchangeable, but ownership is exclusive.** Any live process running the engine claims work from the durable queue. A run has exactly one owning runner at a time, proven by a claim token, and only that runner may write to the run.
3. **The session is always a view.** It attaches to a run's event stream and renders it. An open window sees a live tail; a reopened window catches up from the same stream. Interaction such as approvals uses durable waiting states, never prompts tied to the window's lifetime.
4. **Claims arbitrate every lifecycle decision.** Only the current claim holder may resume, interrupt, or write a terminal event for a run. Recovery code that finds an abandoned run goes through the queue instead of writing to the bundle directly.

The controller runtime already provides most of the machinery: a deduplicated queue with expiring claims, a structured event table, crash recovery through the trace tail, and guarded effect records. This plan extends that treatment to runs the user starts interactively and adds the view layer.

## Decisions

These points were open in the first draft. External review showed each one is load-bearing, so they are decided here.

1. **Write fencing on bundles.** Every claim records a runner ID, a token, and a lease expiry in the store. Every bundle write verifies the token inside the run lock before appending and fails the runner fast when the token no longer matches. Expiring claims alone do not stop a stalled runner from writing; fencing does.
2. **Explicit resume protocol.** Resume is a named operation, not a restart. It truncates a torn trace tail to the last complete line, rebuilds run state from the trace, seeds the trace sequence from the tail, accounts for already-executed steps against the step limit, and records a resume boundary event before continuing.
3. **Resume scope.** User-started runs get node-level resume. Controller child runs keep their current new-attempt semantics, because attempt immutability and parent-side retry already work and are tested. Both behaviors are explicit; nothing mixes silently.
4. **A dedicated run queue.** Interactive runs do not fit the controller queue, which is keyed to controller resources. A new `workflow_run_queue` table shares the claim, lease, and fencing pattern and adds runner affinity fields. Runs stay out of `/controller list`.
5. **Origin affinity.** An interactively started run is inserted and claimed in one transaction, so the session that started it owns it from birth. The standalone host takes over only when that claim is released or expires. This guarantees a watched run's conversation happens in the watching session.
6. **Close-to-park shutdown.** `session_shutdown` stops writing a terminal cancel event for queued runs. It aborts in-flight work without a terminal event and releases the claim, leaving a resumable bundle. A clean close releases claims explicitly; a crash relies on lease expiry.
7. **Per-attempt capture.** Session capture becomes segmented per attempt, keyed by attempt ID, so a run handed off to the host or a new session starts a fresh capture segment instead of failing integrity checks.
8. **Continuation runs for waiting.** A run that needs human input ends at a checkpoint with status `waiting`, preserving bundle immutability. An answered checkpoint starts a continuation run with a new run ID chained to its parent, carrying forward prior outputs. The parent link makes the chain inspectable.
9. **Source pinning.** The manifest stores a content hash of the workflow source at run start. Resume refuses to continue against changed source unless forced, and a forced resume records the mismatch in the trace.
10. **Snapshot catch-up.** Notifications are idempotent snapshots of run state as of a store sequence number, recomputed from the store, not a stream of one-off messages. The watermark persists per session before sending. A skipped incremental notification is subsumed by the next snapshot.
11. **A run-level event feed.** Run lifecycle transitions write rows into a store table, so one watermark covers both controller and run events. Tailing `trace.ndjson` is reserved for the single actively watched run.
12. **Store-error backoff.** Worker loops treat store errors such as `SQLITE_BUSY` as transient and back off instead of letting a worker die silently. The host's advisory lock guards host-versus-host only; the embedded runner does not take it, and a second host refuses to start.
13. **Orphan reaping.** The host spawns `pi --mode rpc` children in their own process group, records child PIDs in the bundle, and reaps known orphans on startup. Consequential actions stay behind guarded effects regardless.

## Requirements

- Starting `/workflow run` in a Pi session creates a durable queued run claimed by that session, and shows its progress live.
- Closing Pi mid-run never loses the run and never writes a spurious terminal event. With the standalone host alive, the host reclaims and resumes the run. Without a host, the run waits and resumes when a runner returns.
- Reopening a session brings it up to date with an idempotent snapshot: what finished, what failed, what waits for input. No state is duplicated and no information is permanently lost.
- A run that needs human input ends at a checkpoint. The user answers with a command, and a continuation run carries the work forward. The wait survives any process lifetime.
- Killing any process at any point recovers without duplicate trace sequences, duplicate notifications of record, or duplicate external effects. A stalled runner that loses its claim can never write again.
- Everything uses documented Pi public APIs. No Pi core changes.

## Work items

1. **Run queue and fencing.** Add the `workflow_run_queue` table with claim tokens, lease expiry, and runner affinity. Gate every bundle write on the token inside the run lock. Insert-and-claim interactive starts in one transaction.
2. **Node-level resume.** Implement the explicit resume protocol from Decision 2, with source pinning from Decision 9. User-started runs resume at the interrupted node; controller child runs are untouched.
3. **Close-to-park and capture segments.** Change `session_shutdown` to abort-without-terminal plus claim release for queued runs. Split session capture into per-attempt segments the integrity checker understands.
4. **Continuation runs.** Chain an answered checkpoint to a new run ID with a parent link and carried-forward outputs. Render the chain as one logical run in views.
5. **Session sync.** Add the run-level event feed, per-session watermarks, snapshot catch-up on `session_start`, and noteworthy-event messages. Live watching tails `trace.ndjson` from a remembered byte offset with `fs.watch`, reusing the TUI viewer's file-tail path.
6. **Standalone host.** A `pi-workflows` CLI subcommand loads controller definitions, opens the project store, and runs claiming in a loop with store-error backoff. Conversation child nodes run in spawned headless `pi --mode rpc` sessions with orphan reaping. The host takes an advisory lock against other hosts, drains on SIGTERM, and recovers on restart. It is a foreground process the user runs in a terminal; it is not a service.

## Non-goals

- Pi core changes of any kind. Every integration uses public APIs: commands, session events, widgets, `sendUserMessage`, and `pi --mode rpc`.
- Multi-machine execution, a remote store, or leader election. SQLite and one machine are in scope; the store contracts leave room for a remote implementation later.
- Installing or configuring a system or user service. The host is a process the user starts and stops.
- A push channel from an external process into a live session. Polling the shared store is the mechanism, and it is fast enough.
- Exactly-once chat notifications. The guarantee is no duplicated state and no permanently lost information, delivered through idempotent snapshots.
- Exactly-once external side effects beyond the existing guarded effect records.

## Assumptions

- One machine and one user, with the store and run bundles on the local filesystem.
- Spawning `pi --mode rpc` per conversation child run is acceptable at the expected cadence. If startup cost proves too high, the host keeps a small pool of persistent RPC sessions instead. Both options stay outside Pi core.
- A polling interval of a few seconds is responsive enough for the session view. File watching covers the live tail of a watched run.
- The user does not need machine-sleep or power-loss coverage beyond crash recovery. A stopped machine stops work until a runner returns.

## Open questions

- Which events deserve a chat message and which belong only in the widget. The default should be quiet.
- The exact host command shape, for example `pi-workflows run --project <dir>` versus a subcommand under `controllers`.

## Departures from the decisions

The implementation matches the decisions above with these refinements:

- Graph validation now allows outgoing edges from checkpoint nodes. The old
  rejection encoded terminal-forever checkpoints; continuations make those
  edges live. This is a deliberate contract change for workflow authors.
- The host command is `pi-workflows host`, chosen over `run` because the
  viewer CLI's vocabulary already uses runs for bundles.
- The first capture stays flat at `session/`; only binds from the second
  recorder onward write segments under `session/segments/`. This keeps the
  layout of every existing single-session bundle and the viewer unchanged.
- Resume always starts unpaused; the operator can pause again.
- Headless conversation children keep the exact tool contract: a bridge
  extension loaded with `-e` registers the `workflow` tool and reports
  submissions to the host over stderr, so no engine prompt changes were
  needed.
- The host accepts explicit `storeFile` and `runsDir` options. Its defaults
  resolve from the project and environment like every other entry point.

## Acceptance criteria

- Start a run in Pi, then close Pi while a conversation node is mid-response and the host is running. The host reclaims and resumes the run, and reopening Pi shows the catch-up snapshot and allows normal conversation about the result.
- The same flow without the host: the run resumes at the interrupted node when Pi reopens and completes.
- A stalled runner that loses its claim cannot write to the bundle afterward; fencing rejects its writes.
- An open session reflects host-driven progress within a few seconds. Two sessions on one project each get complete catch-up; neither starves the other.
- A waiting-for-input run survives closing and reopening. Answering it starts a continuation run that carries forward prior outputs.
- `kill -9` on the host mid-append, followed by a restart, repairs the torn trace tail and recovers without duplicate trace sequence numbers and without repeating an applied external effect. Orphaned RPC children are reaped.
- No changes to Pi core; the diff touches only this package.

## Verification

- `npm run check` and `npm run test:e2e`, including new real-Pi E2E tests that start a run, kill the host, restart it, and assert continuation.
- A fencing test with both runners alive and a forced lease loss.
- A two-session watermark test on one project.
- A `kill -9` mid-append torn-tail resume test.
- A checkpoint answer-to-continuation round-trip test.
- Extension tests with fake timers for the polling loop, watermark, and snapshot catch-up.
- `npx slophammer-ts@latest dry .` and the dependency-boundary check.
- `npx -y @simpledoc/simpledoc check` for documentation changes.
- Manual pass through both usage patterns from the user's request with the host in a terminal.
