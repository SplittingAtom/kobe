# KOBE-155: 56c: Memory service, panel API, Undo and governance

- **Status:** in review
- **Branch / worktree:** `kobe-155-memory-service` in `../Kobe-wt155`
- **Depends on:** [KOBE-153](KOBE-153.md) (contract), [KOBE-154](KOBE-154.md) (tables). No migration.

## Plan

Server only: `memory/` (keys, switches, access seam, store, export), `routes/memory.ts`,
`routes/memory-settings.ts`, audit events, permission `team.memory.manage`. The sandbox handler
(`memory.put`/`memory.read` frames, `memory.updated` append, approvals) is KOBE-156.

## Decisions

- **Routes** (`team.chat` for all; every query under `withTeam`): `GET /v1/memory?scope=[&project_id=]`,
  `GET /v1/memory/:id`, `PUT /v1/memory[?project_id=]` (body = `memoryPutRequestSchema`; 409
  `version_conflict` with `current_version`; 422 `index_full`), `DELETE /v1/memory/:id` (soft, 204),
  `POST /v1/memory/:id/restore {version}`. Settings: `GET/PUT /v1/memory/settings?level=team|install`
  and `GET ?level=effective` (any member; the AND). Team level: read `team.read`, write new
  `team.memory.manage` (team_admin); install level: `install.settings.manage`.
- **Authz:** personal docs only for `owner_user_id = caller`; anyone else (admins too) gets 404.
  Project docs need `canAccessProject` (`memory/access.ts`, built on the `viewerProjectIds` seam;
  empty until KOBE-57/160, so project docs are unreachable through the API until then; the service
  itself works for project targets, tested directly).
- **Switches** (`memory/switches.ts`, one helper `scopeEnabled`): effective user = install AND team
  `memory_enabled`; project = that AND both `project_memory_enabled`. Install level = two
  `install_settings` keys (`memory.enabled` from KOBE-154, new `memory.project_enabled`). Disabled
  scope: 403 `memory_disabled` on every route (after the not-found check).
- **Write path** (`memory/store.ts`): lock doc (`FOR UPDATE`), upload object (`memoryBlobKey`), insert
  version row, move `current_version`. `append` supported for KOBE-156 (cap checked on the result).
  `MEMORY.md` capped at 200 lines, files at 64 KiB. Storage failure throws `MemoryStorageError`
  (rolls back, 503). An object orphaned by a later rollback is overwritten by the next write of that
  version (deterministic key).
- **Undo = restore**: new version via server-side object copy (own object per version, sha256
  equal); also revives a soft-deleted doc (Undo of delete). Undo of a created doc = `DELETE`.
  Restore does not check that the doc is still at the event's version (contract has no field).
- **Version `source`** has no column: restore marks `tool_call_id = "restore:<n>"`; agent writes are
  `source=agent`. KOBE-156 should pass `toolCallId`; an approval-applied write reads as `agent`.
- **Audit** (ids/versions/sizes, never path or content): `memory.written` (`actorKind` user|agent),
  `memory.restored`, `memory.deleted`, `memory.settings_changed`, `memory.install_settings_changed`.
  Documented in `docs/audit-log.md`. Agent-write audit is for KOBE-156 (it calls `writeMemory` and
  `recordAudit` with `actorKind: "agent"`).
- **Governance (ac-3):** legal hold and break-glass are database-level (KOBE-154) and cover the
  tables; the API only soft-deletes, so no guard is hit. **Export:** the user's zip gains
  `memory/<path>` (current version of live personal files, regardless of switches); project memory
  is not in a personal export. **Purge: see retention below.**
- **Retention: implemented nothing** (needs a spec decision). The thread purge and the blob queue
  (`retention_blob_deletions`, `threadKey`) only know thread trees and never touch memory; that
  stays true. Question below.

## Open questions (for Chris or the coordinator)

- Retention for memory (D24 "follows team retention"): purge docs whose newest version is older
  than the team period? Memory is deliberately long-lived (an agent's learned preferences), so
  age-based purge may delete exactly what users want kept; alternatives: purge only soft-deleted
  docs older than the period, or purge all of a user's memory on offboarding/erase only. Needs a
  call before any purge is written (it needs a memory blob queue: `retention_blob_deletions` is
  keyed by thread and `threadKey`).
- Offboarding (KOBE-28) does not touch memory yet; same decision.

## Evidence

- ac-1 "restore makes a new version equal to the prior one" (`memory.db.test.ts`).
- ac-2 "is visible only to its owner" and "delete is soft and audited".
- ac-3 export test; legal hold/break-glass: KOBE-154 `memory.db.test.ts` in `@kobe/db`; purge: question.
