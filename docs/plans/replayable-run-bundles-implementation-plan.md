# Replayable run bundles — implementation plan

Goal: make every workflow run bundle self-contained for replay, as specified
in [run-bundles.md](../run-bundles.md). This is a hard cutover: one format,
no readers for the previous layout, no compatibility code.

## Steps

1. **Spec** — rewrite `docs/run-bundles.md`: trace-first write discipline,
   `traceSeq` in `state.json`, content-addressed `artifacts/`, `session/`
   with binding + verbatim Pi entries, explicit `conversation` entry ranges
   on agent steps, event payload catalog. Review the data model with
   Schemator. _(done)_
2. **Types** — `ArtifactRef`/`ArtifactValue`, `ConversationRange`,
   `WorkflowSessionBinding`, `WorkflowSessionEntryRecord`; `schema` +
   `traceSeq` on `WorkflowRunState`; `promptText` renamed to `prompt`;
   optional `session`/`artifacts` manifest paths. _(done)_
3. **Artifacts** — `src/workflows/artifacts.ts`: threshold-based string
   externalization with `$escaped` collision handling, dedupe by content
   hash, resolve/decode helpers. _(done)_
4. **Store** — trace append before projection writes, `traceSeq` stamping,
   value encoding at the documented positions, session writers sharing the
   trace sequence, 0700/0600 modes. _(done)_
5. **Engine** — outputs/receipts/conversation in terminal node events,
   `input` in `run_started`, `finalOutput` in terminal run events, shared
   store option. _(done)_
6. **Recorder** — `src/extension/recorder.ts` copies session entries into
   the bundle via documented read APIs; executor mark/range hooks attach
   `conversation` to accepted submissions; extension wires recording to
   `message_end`/`agent_settled` and flushes before accepting a submission.
   _(done)_
7. **Fixtures** — deterministic layout + render golden files under
   `fixtures/layout/`, generated from the TypeScript reference and pinned by
   a parity test, consumed by the Rust port. _(done)_

## Schemator review adjudication

The data model was challenged field-by-field with Schemator (Codex review
strategy). Outcomes:

- **Accepted** — `WorkflowRunState.currentNodeType` removed: written but
  never read; every consumer derives the type of `currentNode` from the
  definition snapshot.
- **Rejected** — `statusDetail` (live-UX label read by the widget and both
  viewers), `paused` (orthogonal to `status`: a pause request holding at a
  boundary while status stays `running`), `waitingOn` (well-specified:
  checkpoint node id), `updatedAt` (cheap liveness signal for list views that
  read only `state.json`), `durationMs` (engine-measured, not a timestamp
  subtraction), `workflowPath` (provenance with a real re-run use case),
  `piSessionFile` (documented provenance, explicitly never read for replay).
- **Rejected** — renaming trace/session `at` to `occurredAt`: `at` is the
  event-envelope convention used throughout the trace format; the `…At`
  suffix rule applies to document fields, and the deviation is deliberate.
- **Rejected** — `ArtifactRef.bytes` (lets viewers show sizes and verify
  truncation without stat-ing every artifact) and
  `WorkflowSessionBinding.boundAt` (binding.json stays self-describing
  without consulting the trace).

## Non-goals

- Reading bundles written before this change.
- Normalizing Pi session entries (they are recorded verbatim; Pi owns the
  shape).
- Capturing conversations for runs driven by non-conversation executors
  (headless tests); `session/` is simply absent.
