---
title: Route workflow reports to their starting session
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-13
---

# Route workflow reports to their starting session

pi-workflows must not send one workflow's report into an unrelated conversation. A workflow started in one Pi session must report only to that session, even when another session or the standalone host executes part of the run.

## Requirements

- Record the starting Pi session as the origin of each interactive workflow run.
- Keep execution events separate from user-facing notifications.
- Store each notification durably and address it to one Pi session.
- Deliver a notification only when its target session is open.
- Keep undelivered notifications until the target session opens again.
- Prevent unrelated sessions from claiming session-bound runs.
- Permit a detached host to execute a run without changing its report target.
- Give workflow authors a runtime-owned notification node instead of using an agent step to relay text.
- Migrate active path-based runs and existing queue rows without guessing their origin.
- Remove project-wide hidden-message broadcasts and the shared project watermark.

## Data model

Queue records gain an optional `origin_session_id`. Interactive runs set it from `ctx.sessionManager.getSessionId()`. Controller-created detached runs leave it empty. A session runner can claim a record only when the origin is empty or matches its current session. The standalone host can claim either form.

A `workflow_notifications` table is the durable outbox:

| Field                       | Meaning                                             |
| --------------------------- | --------------------------------------------------- |
| `notification_id`           | Stable unique delivery ID                           |
| `run_id`                    | Workflow run that created the notification          |
| `node_id`                   | Node that created it                                |
| `attempt_id`                | Latest node attempt that requested it               |
| `notification_index`        | Stable one-based occurrence of this node in the run |
| `target_session_id`         | Exact Pi session that may receive it                |
| `kind`                      | `progress` or `final`                               |
| `content`                   | Bounded plain-text report                           |
| `created_at`                | Creation time                                       |
| `delivery_claim_token`      | Current delivery owner, or null                     |
| `delivery_claim_expires_at` | Delivery lease deadline, or null                    |
| `delivered_at`              | Delivery time, or null while pending                |

`(run_id, node_id, notification_index)` is unique. A crash retry reuses the same logical index, even though it gets a new attempt ID. A later loop iteration gets the next index. Delivery polling claims pending rows with a short lease before it writes to a session. This prevents two Pi processes that open the same session from sending the same notification concurrently. If a process stops, another process can reclaim the row after the lease expires. A stable notification ID is included in the custom session entry so the same session can detect a delivery completed before a crash.

The existing `run_events` table remains an execution audit feed. It does not inject conversation messages. The obsolete `session_watermarks` table is no longer used.

## Workflow API

Add a `notify(...)` node. Its message callback returns plain text. The engine calls a host-provided notification sink and persists the resulting receipt as the node output. The node does not ask the model to relay a message and does not depend on the runner's active conversation.

The built-in monitor uses `notify` for progress and final reports. Its check agent still decides whether a report is needed, but delivery always targets the origin session.

## Migration

For each active run with a queue row and no origin:

1. Read `session/binding.json` from its run bundle.
2. If the binding exists, set `origin_session_id` to its `piSessionId`.
3. If no binding exists, keep the run detached.
4. Never infer an origin from the working directory.

Existing lifecycle events are not converted into notifications. This prevents old completion events from appearing in unrelated sessions after the update.

## Non-goals

- Do not modify Pi core or Pi session files directly.
- Do not broadcast workflow reports to all sessions in a project.
- Do not keep compatibility aliases for the shared project watermark behavior.
- Do not make closed Pi sessions execute workflow steps.

## Acceptance criteria

- Two open Pi sessions in the same directory cannot receive each other's workflow reports.
- A report executed by the standalone host is delivered after the origin session opens.
- A report remains pending while its origin session is closed.
- A session-bound run is not claimed by a different interactive session.
- Duplicate polling and process restart do not duplicate a delivered notification.
- Monitor progress and final reports use the notification outbox.
- Existing active runs gain their recorded binding as origin when available.
- Pi starts with the released package in OnurPi.

## Verification

- `npm run check`
- `npm run test:e2e`
- `npm run slophammer`
- `git diff --check`
- `npx -y @simpledoc/simpledoc check`
- `cargo fmt --check --manifest-path tui/Cargo.toml`
- `cargo clippy --manifest-path tui/Cargo.toml --all-targets --all-features -- -D warnings`
- `cargo test --manifest-path tui/Cargo.toml`
- `pi-reviewer --base main`
- Start two isolated RPC Pi sessions in one directory and prove that only the matching session receives a targeted notification.
