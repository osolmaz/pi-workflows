---
title: wake recovery plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-27
---

# wake recovery plan

## Purpose

After macOS suspend and resume, every open Pi session logs
`Warning: Workflow server is unavailable: Workflow server did not become ready:
A workflow server is already running with PID X`, with a different PID on each
line across wake cycles. The goal is that after any sleep duration and any wake
pattern, the system recovers to one healthy server quickly, with at most one
transient reconnect per session and no `already running` warning bursts. A live
healthy server must never be killed or displaced, and a dead or shutdown-bound
holder must never block takeover for more than about a second.

## Observed failure

The failure is a chain, verified against the 0.17.4 code and reproduced in an
isolated sandbox.

1. The server holds a 30 second lease in the `workflow_server_state` table,
   renewed every 10 seconds. `renewServer()` in `src/server/state.ts` requires
   `expires_at > now`, so after any sleep longer than the lease the first
   heartbeat after thaw throws `Pi Workflows server claim lost`, and the
   heartbeat catch in `src/server/server.ts` calls `stop()`. The server kills
   itself on every wake.
2. During `stop()` the listener closes first, while the server lock file
   `server.lock.json` is released only at the very end. `stop()` awaits runner
   and channel supervisors (SIGTERM plus a 2 second kill grace each). If the
   machine re-sleeps mid-shutdown, the process stays alive but deaf while
   holding the lock for a long time.
3. On connect failure the client's `ensureAvailable()` in
   `src/client/client.ts` spawns exactly one detached replacement and then only
   retries connecting for 10 seconds. The replacement's `acquireServerLock()` in
   `src/server/server.ts` sees a live process whose start identity matches the
   lock record, writes `A workflow server is already running with PID X` to its
   startup pipe, and exits. The client never spawns a second replacement within
   that window, so every session that raced warns after its full 10 second
   timeout. Freezing a live lock holder reproduced the exact warning after
   12.3 seconds.
4. Each wake or DarkWake cycle mints a new server generation, so warnings
   accumulate as a chain of distinct PIDs, and the extension shows one warning
   per session per outage.

## Approach

Implement layered wake recovery as one hard-cutover change with three
independent parts: the authenticated lease owner re-arms its own expired lease,
so a server that slept keeps serving; `acquireServerLock` probes the recorded
holder's socket and only reports `already running` for a provably serving
holder, with the epoch claim row as the fencing authority; and the client
re-spawns a replacement when a spawned child exits without becoming ready,
bounded by the existing 10 second deadline and a three-spawn cap. No schema or
protocol changes; the lock and lease schemas keep their versioned identifiers
and shapes.

## Implementation steps

1. **Suspend-aware lease self-renewal.** In `src/server/state.ts`,
   `renewServer()` currently requires `expires_at > now`. Drop the
   `AND expires_at > ?` predicate from the renewal UPDATE so it matches only on
   `id=1`, `epoch`, `server_id`, `token_hash`, `pid`, and
   `process_start_identity`. The token hash and process start identity remain
   the fence, and a superseded epoch (another server claimed) or a wrong token
   still fails the update and triggers the existing stop path. Update the
   function's doc comment: expiry gates takeover, never kills the authenticated
   owner.
   Verify with unit tests: (a) rewind `expires_at` into the past on a row that
   still matches identity, then renew succeeds and extends `expires_at`; (b)
   after another server claims the epoch, renew throws and the caller stops;
   (c) renew with a wrong token throws; (d) renew after `releaseServer`
   (`server_id` null) throws.
2. **Heartbeat claim-lost semantics.** In `src/server/server.ts`, inside
   `startTimers()`, keep the heartbeat catch semantics but reword the log and
   comment from "lease expired" to "claim superseded": the catch now fires only
   when the epoch row no longer carries this server's exact identity and token.
   No behavioral change beyond step 1.
   Verify with a unit test on the heartbeat path: an expired-but-unsuperseded
   claim renews (no stop); a superseded claim stops the server and logs the
   supersession reason.
3. **Serving-probe lock takeover.** In `src/server/lock.ts`, add a bounded
   serving probe and use it in lock acquisition. New exported helper
   `probeServerServing(socketPath, timeoutMs)`: `net.connect` to the socket
   path; serving means hello data arrives within the timeout (the server writes
   its hello on connection); not serving means a connect error (ENOENT,
   ECONNREFUSED) or timeout; always destroy the probe socket. Extend
   `acquireServerLock(lockPath, record, options)` to take
   `{ socketPath, probeTimeoutMs?, probe? }` where the probe defaults to
   `probeServerServing` and stays injectable for unit tests. New acquisition
   logic: lock file missing or holder identity mismatched, remove and take over
   (unchanged); holder identity matches and the probe says serving, throw the
   existing `A workflow server is already running with PID X`; holder identity
   matches and the probe says not serving, remove the lock and take over. Pass
   `{ socketPath: this.socketPath }` at the `acquireServerLock` call site in
   the server start path. A probe misfire during a holder's startup gap is
   fenced by `acquireServer`'s existing
   `A live Pi Workflows server already owns epoch N` check, so the worst case
   is one wasted spawn, never two serving servers.
   Verify with unit tests using an injected probe: a serving holder keeps the
   `already running` error; a deaf holder is taken over; a dead holder is taken
   over without probing. Verify with an integration test on a real temp unix
   socket: a server that writes hello yields verdict serving; a bound socket
   that accepts but stays silent yields takeover; a missing socket path yields
   immediate takeover with no probe.
4. **Client re-spawn on dead replacements.** In `src/client/client.ts`, rework
   `ensureAvailable()`: keep the overall `START_TIMEOUT_MS` deadline; wrap the
   spawn in an outer loop capped at three spawn attempts; inside each attempt,
   poll `connect()` every 50 ms as today but stop waiting on the current child
   once it has exited (the startup failure resolved) plus a short 250 ms grace
   for a competing holder to become connectable, then loop to spawn again;
   after the cap, keep polling connect until the deadline because another
   session's spawn may win. Preserve the final error contract:
   `Workflow server did not become ready: ` followed by the last spawn's
   diagnostic when any spawn ran, otherwise the last connect error.
   Verify with integration tests using real spawned servers in temp dirs: (a) a
   first spawn that exits with a diagnostic (server entry path pointed at a
   failing stub) and a second real entry that becomes ready, all inside one
   `ensureAvailable` call well under the deadline; (b) every spawn fails and
   the thrown error carries the last diagnostic; (c) a serving holder reachable
   by connect short-circuits without extra spawns.
5. **Extension notification path.** In `src/extension/index.ts` (the outage
   notification path), no code change is expected: the warning text stays
   accurate because `ensureAvailable`'s thrown message contract is preserved.
   Only touch this file if the final error wording changes during
   implementation; otherwise leave it alone.
   Verify by grep: the notify message still composes from `errorMessage(error)`
   with no format change, and the final change set has no diff in this file.
6. **Documentation.** In `docs/WORKFLOWS.md`, add a `Wake recovery` section
   near the server lifecycle documentation covering the three behaviors: the
   server re-arms its own expired lease after suspend and only stops when its
   claim is genuinely superseded; takeover requires the recorded holder to be
   provably not serving (bounded socket probe) with the epoch claim as the
   fence; clients re-spawn failed replacements within a bounded budget. State
   that `expires_at` answers "is the lease currently valid", not "is the owner
   alive".
   Verify that `npm run check` passes and the section reads as plain prose
   consistent with the document's existing structure.
7. **Full repository validation.** From the repository root, `npm run check`
   passes; `npx slophammer-ts@latest dry .` reports zero candidates;
   `npx slophammer-ts@latest check . --only
ts.dependency-boundaries-required` passes; `TMPDIR=/tmp/e2e npm run
test:e2e` passes all files. The default macOS `TMPDIR` is too long for e2e
   unix sockets and is a known environmental failure on this machine.

## Contracts

- `pi-workflows.server-lock.v1` keeps its exact record shape (`schema`, `pid`,
  `startIdentity`, `serverId`); only acquisition semantics change (probe before
  the `already running` verdict), so existing readers stay compatible.
- The `workflow_server_state` table keeps its schema; no migration. The refined
  meaning: `expires_at` answers "is the lease currently valid for takeover
  arbitration", not "is the owner process alive"; `serverStatus().live` keeps
  its `expires_at`-based definition unchanged.
- `renewServer` keeps its signature and throw behavior
  (`Pi Workflows server claim lost`) so the heartbeat catch and all callers
  behave identically on genuine supersession.
- `acquireServerLock` gains an options parameter (`socketPath` required at the
  server call site); it is internal to the server layer, not a published
  interface, and the thrown `already running` message is unchanged for serving
  holders.
- `WorkflowClient.ensureAvailable` keeps its promise contract (resolves with
  hello or throws with the `Workflow server did not become ready: ` prefix);
  internals may spawn up to three servers instead of one.
- The NDJSON client protocol and all message schemas are unchanged; no version
  bumps are needed.
- Compatibility boundary: a 0.17.4 client against the new server, and the new
  client against a 0.17.4 server, continue to work. Old clients may still spawn
  losing replacements, which the new lock probe converts into fast takeovers,
  and old servers keep their self-destruct behavior until adopted.

## Tests

- `renewServer`: an expired-but-identity-matching re-arm succeeds and extends
  the lease; a superseded epoch fails; a wrong token fails; a released row
  (null `server_id`) fails.
- Heartbeat: a superseded claim stops the server; an expired-but-ours claim
  does not stop it.
- `acquireServerLock`: a missing lock takes over without probing; a dead holder
  (identity mismatch) takes over without probing; a live serving holder keeps
  the `already running` error; a live deaf holder is taken over.
- `probeServerServing` integration: a hello-writing server is serving; a silent
  bound socket is not serving; a missing socket path is not serving without
  connecting.
- `ensureAvailable`: a failing first spawn followed by a healthy second spawn
  succeeds inside one call under the deadline; every spawn failing throws with
  the last diagnostic; a serving holder short-circuits without extra spawns.
- Existing fencing and takeover tests pass unchanged in intent, and the e2e
  suite passes with `TMPDIR=/tmp/e2e`.

## Risks

- A serving holder with a temporarily blocked event loop fails the 500 ms hello
  probe and is robbed of the lock. The epoch claim table fences the outcome:
  the robber fails `acquireServer` while the holder's lease is live, and if the
  robber claims first, the holder's next renewal fails and it exits. The worst
  case is one wasted spawn, never two serving servers.
- Dropping `expires_at > now` from renewal weakens assumptions elsewhere that
  an expired lease means a dead owner. `acquireServer`'s takeover predicate is
  unchanged; audit every `expiresAt` reader (`serverStatus`, recovery, views)
  during implementation and keep their `expires_at`-based meanings, and add the
  documentation note that `expires_at` is lease validity, not liveness.
- A handover window can briefly have two listening sockets (the old server
  until its next heartbeat, the new server after takeover). This is a
  pre-existing characteristic of lease-granularity fencing, unchanged by this
  plan; the old server stops at its first failed renewal, and clients reaching
  either server get valid responses until then.
- Incident paths spawn up to three node processes per `ensureAvailable` call
  across several sessions. The three-spawn cap and the shared 10 second deadline
  bound this; spawns are cheap losers that exit in milliseconds under the lock
  and claim fencing.
- The probe adds latency to contended spawns. Only the contended live-holder
  case probes; the common uncontended path (missing lock or dead holder) never
  probes, keeping startup latency unchanged.

## Boundaries

- No changes to the OnurPi adoption or wrapper (`~/repos/onurpi`), including its
  pinned dependency and sync flow; adoption is a separate follow-up.
- No npm publishing, version bumping, or release mechanics.
- No changes to Pi core (`@earendil-works/pi-coding-agent`), including its
  tool-parameter transport.
- No changes to the Herdr plugin or Herdr-specific surfaces.
- No changes to resource-manager or decision-channel subsystems beyond what the
  lease or lock fix directly touches (their leases live in the separate
  `leases` table and are untouched).
- No new runtime dependencies, no new persisted state, no schema or protocol
  version changes, and no work in any repository other than
  `/Users/onur/repos/pi-workflows`.
