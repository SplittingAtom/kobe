# KOBE-492: Sync conflicts are reported to the agent and the member

- **Status:** committed locally (two commits, not pushed)
- **Branch / worktree:** `kobe-492-sync-conflicts` in `../Kobe-wt492`
- **Depends on:** KOBE-488 (agent-files pairing idea), KOBE-462/463 (file editor review)

## Commits

1. **Migration only** (own PR): `workspace_sync_conflicts` — `0178_workspace_sync_conflicts.sql`
   (schema) + `0179_workspace_sync_conflicts_rls.sql` (custom: ENABLE + FORCE RLS on
   `kobe.team_id`, run key `ON DELETE SET NULL (run_id)`). Numbered 0178/0179 because KOBE-494
   takes 0177 (journal idx stays contiguous: 177/178). Tenancy `sandbox.ts`, probe fixture, db test,
   offboarding delete.
2. **Feature**: frame, server, agent note, web notice, audit, docs/audit-log.md.

## Behaviour (for docs/file-editing.md; the coordinator updates it)

- **Sandbox** (`workspace/sync.ts`): every conflict copy (push conflict, pull before a run,
  restore) is reported with `path`, `conflict_path`, `member_sha256` (the server version that kept
  the path) and `agent_sha256` (hashed before the rename). `ConflictReporter` sends
  `workspace.conflict` at once or queues ≤ 20 until the next `hello.ack`.
- **Capability** `sync_conflicts` (agent with workspace sync and kobe-tools). Frames:
  `workspace.conflict` (sandbox → server, small, never answered), `workspace.conflict_note`
  (server → sandbox) and `run.start.sync_conflicts` (≤ 5). Contract in
  `packages/protocol/src/sync-conflicts.ts` (additive protocol change inside this feature PR — the
  coordinator asked for the frame here).
- **Server** (`sandbox-wire/sync-conflict.ts`): drops (logs, never closes) without capability,
  from an eval sandbox, over 10/min per connection (token bucket, burst 10), hostile names
  (`syncConflictSchema`: workspace path rules, same folder, `<stem>.conflict-<UTC stamp>[-n]<ext>`,
  lowercase hex hashes), agent-internal or read-only paths. Oversize strings fail decode (an
  `error` frame, no close).
- **Recording** (`sync-conflicts/store.ts`): one row per conflict; `thread_id`/`run_id` = the
  member's thread whose run last wrote the path with a successful `write`/`edit` (newest 50 runs of
  the last 30 days; paths matched as `p`, `/workspace/p`, `./p`), else null. Audit
  `workspace.sync_conflict` (system actor; ids and hashes only). Insert trims the member's rows:
  settled rows after 30 days, and the newest 200 per member.
- **Agent**: if that thread's run is active on the connection, the server sends
  `workspace.conflict_note` and marks the row told; kobe-tools adds the note as a hidden Pi custom
  message (`customType: kobe-sync-conflict`, `display: false`) in the `context` hook before every
  later model call of that run. **It reaches the model in user role** (Pi converts custom messages
  to user messages), so the text opens "This is a Kobe notice, not a message from the user". Not
  stored in the session. Otherwise the next `run.start` of that thread carries the untold rows
  (newest 5, all marked told) and the note is part of that run's system prompt (like the viewed
  file; context viewer label "Workspace sync conflicts"). Names sanitised to one line and fenced
  with a per-note nonce; no content.
- **Web**: `SyncConflictNotices` above the composer (`GET /v1/threads/{id}/sync-conflicts`, owner
  only; read on thread open and after a run ends, then at +2.5/5/10 s). "The agent's change to
  notes.md conflicted with your save. Your version was kept; the agent's is in
  notes.conflict-….md". Open both (two tabs), Compare (file editor review: member file as base,
  agent copy as the proposal; Commit all saves onto the member's version), Delete the copy (inline
  confirm, `DELETE /v1/workspace/files`, then `resolved`), Dismiss (`dismissed`). Shared readers
  get 404, so no notice at all.

## Decisions

- Mid-run note via Pi custom message (coordinator, after Pi's forced-prompt projection was found to
  drop mid-run system messages whenever kobe-tools sets the run's prompt).
- Audit actor is `system` (the sandbox reported it; no agent id at hand).
- No legal-hold guard on the table: rows follow their thread; the copy is a workspace file.
- A note for a run no longer active is dropped by the sandbox (already marked told).

## Open questions

- Shared readers see no notice (GET is owner-only per the coordinator); the brief's "readers see
  the notice without actions" would need a reader-visible list.
- Marking told happens before `run.start` is sent; a run.start lost on a dropped connection loses
  the note (the notice stays).
- E2E: not added. Forcing a conflict needs the agent's unsynced write and a member save to race a
  live sandbox sync; the harnesses (browser e2e, gate1) cannot do it cheaply. Covered by the real-Pi
  test plus server db and web tests.

## Evidence

- ac-1: `services/sandbox-agent/src/workspace/sync.test.ts` (reports), `conflict-reporter.test.ts`,
  `services/server/src/sandbox-wire/sync-conflict.test.ts` (hostile paths, internal, read-only,
  oversize, rate), `services/server/src/sync-conflicts.db.test.ts` (last writer, audit by ids,
  routes, notes, cap), `packages/db/src/workspace-sync-conflicts.db.test.ts`, probe suite.
- ac-2: `apps/web/components/files/sync-conflict-notice.test.tsx`.
- ac-3: `services/sandbox-agent/src/kobe-tools.sync-conflicts.real-pi.test.ts` (real Pi 1.0.0:
  run-start note in the system prompt; mid-run note in the next model call; never in the session),
  `kobe-tools/memory-hooks.test.ts`, `memory/conflict-context.test.ts`.
- ac-4: above; `pnpm verify` and `@kobe/server test:db` green (see commit).
