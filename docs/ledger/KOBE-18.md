# KOBE-18: Retention, soft delete and export

- **Status:** merged (PR #59); follow-up PR for the re-review LOWs
- **Branch / worktree:** `kobe-18-retention` in `../Kobe-wt18`
- **Depends on:** KOBE-29, KOBE-17 (merged); uses KOBE-11 (blob-ref registry), KOBE-27 (object
  store), KOBE-15 (audit), KOBE-31 (410 `events_compacted`)

## Scope (spec D18, D6, D8)

Keep forever by default; team admins set 30 d / 90 d / 1 y / forever within an install maximum; a
nightly job purges threads past the period (entries, runs, run events, blobs; uploads and
artifacts through the blob registry once KOBE-53/55 register their columns), audited as counts;
users' Trash (30 days) with "Delete forever"; legal hold suspends every purge; ended runs'
`run_events` compacted after 7 days; users export their threads in a team as Pi JSONL + Markdown.

## Design

### Data (`packages/db`, identity area)

- `team_retention` (team table, FORCE RLS): `period` (`30d|90d|1y|forever`), `updated_by/_at`.
  No row = forever.
- Install maximum: `install_settings['retention.maximum']` (absent = forever). Effective period =
  the shorter of the two, so lowering the maximum caps teams without rewriting their choice.
- `retention_blob_deletions` (team table, FORCE RLS): object keys a purge released, with the
  purged thread's owner. Queued **in the purge transaction**, deleted from S3 later.
- `BLOB_REF_COLUMNS` gains `thread: true` for thread-owned columns (`thread_entries.blob_ref`
  today); the registry test now requires team tables with `team_id` (and `thread_id` for
  `thread: true`). New partial index `thread_entries_blob_ref_idx (team_id, blob_ref)`.
- Legal-hold backstop extended (KOBE-17 contract): statement-level `AFTER DELETE` guards on `runs`
  and `run_events` (transition tables, same shape as `thread_entries`) and `BEFORE TRUNCATE`
  guards. Migrations `0041_retention` (generated) and `0042_retention_rls` (custom).

### Server (`services/server/src/retention/`)

- `purge.ts`: one batch = one `withTeam` transaction: `lockLegalHolds` first, `lock_timeout 5s`,
  select candidates `FOR UPDATE OF t SKIP LOCKED` with `NOT legal_hold_covers(...)` and no
  queued/active run, cap by thread count (50) and entry budget (20 000; a big thread goes alone),
  count what goes, queue thread-owned blob keys, `DELETE FROM threads` (cascades: entries, runs,
  run events, approvals, wire rows), audit last. KH001 → "held", stop that selection.
  Selections: `trash` (deleted ≥ 30 d), `retention` (last activity older than the period),
  `user` (offboarding), `thread` (Delete forever).
- `compaction.ts`: ended runs older than 7 d, not held: delete their `run_events`, set
  `events_compacted_at` (one CTE statement per batch of 200), audit counts.
- `blobs.ts`: per batch, under the legal-hold lock: queue rows not held, minus keys any
  `BLOB_REF_COLUMNS` column of the team still references (shared/dedup), minus keys outside the
  owner's key space (`<prefix>teams/<team>/…`, under `users/<u>/` only the owner's, never
  `users/<u>/workspace/`, which KOBE-27 collects) — tightened in review round 1 to the purged
  thread's own tree; S3 delete inside the transaction, then the queue rows go; audit
  `{blobs, kept}`. Failure → `attempts + 1`, retried next pass.
- `job.ts` `RetentionJob`: every replica checks every 15 min; a **session-level advisory lock on
  a dedicated pool connection** (`kobe.retention`) admits one replica; due once a day in
  `KOBE_RETENTION_HOUR_UTC` (default 3) or when the last pass is > 48 h old;
  `install_settings['retention.last_pass_at']`. Per team: Trash purge, retention purge,
  compaction, blob deletion; each step's failure is logged and the others run. 2 h budget.
- `delete-forever.ts`: `POST /v1/threads/{id}/purge` (owner only; lookup by team + id + owner).
  Step 1 moves the Trash date past the 30-day window (gone from Trash, not restorable) and audits
  `thread.purge_requested`; step 2 purges it like the job (`thread.purged`). Under a hold step 2
  skips it and the nightly Trash purge deletes it after release; the user sees the same 204.
- `export.ts`: `GET /v1/threads/export?team=` streams a zip (fflate, MIT): `sessions/<id>.jsonl`
  (Pi session v3 header + every entry in `seq` order), `transcripts/<date>-<title>-<id8>.md`
  (active branch), `threads.json`, `README.md`. Own threads in the active team only (live and
  restorable Trash), every query names team and owner, ownership re-checked on each entry page;
  page-by-page short transactions, pull-driven stream; one export per user per replica (429).
  Offloaded entries are read back only from their thread's own object tree. Audited `thread.exported`.
- Routes: `GET/PUT /v1/team/retention` (read: `team.read`; write: `team.retention.manage`; 409
  `exceeds_maximum`), `GET/PUT /v1/install/retention` (`install.retention.manage`).
- `purgeDepartedMember(db, {teamId, userId}, blobs?)` for KOBE-28 (below).

### Web

- Team console **Retention** (READY): radio of allowed periods, banner when capped by the
  maximum, confirmation before shortening.
- Install console **Retention maximum** (READY), confirmation before lowering.
- Chat sidebar: Trash items get **Delete forever** (confirm; adapter `delete` →
  `POST /purge`); **Export my conversations** download link (`?team=`).

### Audit (all documented in `docs/audit-log.md`; new category `retention`)

`retention.policy.changed` (team; `period`, `previous`), `retention.maximum.changed` (install),
`retention.purged` (team, system; `reason` retention|trash|offboarding, counts, `userId?`),
`retention.compacted`, `retention.blobs_deleted` (`blobs`, `kept`), `thread.purge_requested`,
`thread.purged` (counts), `thread.exported` (`threads`, `entries`).

## For KOBE-28 (offboarding)

Call `purgeDepartedMember(deps.database.db, { teamId, userId }, deps.blobs)` from
`services/server/src/retention/index.ts` once the 30 days after the member left (or was
deactivated) are over. It hard-deletes every thread the user owns in that team (Trash included),
with entries, runs, run events and thread-owned blobs, skips held data (`threads.status` is
`"held"` if a guard refused), batches short transactions, audits `retention.purged` (reason
`offboarding`, `userId`, counts) and `retention.blobs_deleted`, and throws `StillAMemberError`
while the user is an active member of the team. Workspace volumes and the workspace S3 copy
(`workspace_*`, `teams/<t>/users/<u>/workspace/`) stay KOBE-28's own step, behind the same
`lockLegalHolds` / `isUnderLegalHold(tx, teamId, userId)` contract.

## User decision (2026-10-04): 7-day grace for shortenings

When a team's effective period gets **shorter** (a team admin lowers it, or the install maximum is
lowered), it takes effect after **7 days**; lengthening applies at once.

- **Model:** two layers, each with its own grace: `team_retention.period` (in force) +
  `pending_period`/`pending_at`/`pending_by`; `install_settings['retention.maximum']` +
  `['retention.maximum.pending']` (`<period>@<ISO>`). A shortening is recorded as pending, due 7
  days later; reads settle a due pending change (`settle`), so the job never depends on a write on
  time. Effective = shorter of both layers **as of now**; the banner/email use
  `upcomingShortening` (the next instant the effective period shrinks; a team lowering that the
  maximum already covers announces nothing).
- **Banner:** `GET /v1/team/retention` returns `pending` (the team's own, cancellable) and
  `upcoming` (from either layer). The chat shows "Conversations older than X will be deleted from
  <date>. Export your conversations" to every member; the team console shows it plus the pending
  change with **Cancel change**; the install console shows a pending maximum with Cancel.
- **Email:** after commit (background, best effort, logged on failure; the banner is the durable
  signal), team admins get the period, date and a **count** of conversations that would go (no
  titles, no owners). For a lowered maximum, every team whose effective period shrinks is emailed.
  Audited `retention.shortening_notified` (counts).
- **Cancel:** `DELETE /v1/team/retention/pending` (team admins), `DELETE
/v1/install/retention/pending` (install admins); audited `retention.policy.change_cancelled`,
  `retention.maximum.change_cancelled`. `retention.policy.changed` / `.maximum.changed` carry
  `effectiveAt` when scheduled.
- A team can't choose above the maximum **as chosen** (pending included).

## DB review (coordinator's independent review) — resolution

- **H1** Trash purged early / restored threads purged at once: the retention selection now takes
  live threads only (`deleted_at IS NULL`; Trash expiry is the Trash selection's), and restoring
  a thread sets `last_activity_at = now()` (`threads/repository.ts`). Test "keeps Trash its full
  30 days and restarts the period on restore" (fails without the fix, verified).
- **M1** index `threads_retention_idx (team_id, last_activity_at) WHERE deleted_at IS NULL`.
- **M2** the reference check reads only thread-owned columns (`thread: true`, indexed); keys in a
  thread tree can't be workspace keys. The shared-object test now uses a forked thread's entry.
- **M3** the lock client has an `error` listener: the pass stops (`stop()` checked between
  batches and steps), the tick returns `lost`, the connection is destroyed, and the open pass
  resumes on the next check. Test with an injected connection error.
- **M4** drizzle runs migrations in one transaction, so no CONCURRENTLY: both indexes moved to the
  custom migration as SQL-only `CREATE INDEX IF NOT EXISTS`, and `docs/install.md` (Upgrade notes)
  says to pre-build them `CONCURRENTLY` on large installs.
- **L1** compaction already filters held threads in SQL before `LIMIT` (`NOT legal_hold_covers`).
- **L2/L6** pass cursor (`retention.cursor`): a stopped or crashed pass resumes after the last team
  done, at the next check, even the same night. Test "resumes an unfinished pass".
- **L3** export slot claimed before any await.
- **L4** export requires `team.chat` like every thread route: confirmed intended (members only).
- **L5** `lock_timeout` is reset to 0 before the audit write, so the audit's own wait applies.
- **L7** noted.

## Follow-up after the re-review (4 LOW, own PR)

1. The retention selection re-reads the effective period in every batch's transaction (a
   lengthening mid-pass applies to the next batch; test "re-reads the period in every batch").
2. `docs/install.md`: drop an INVALID index left by a failed `CONCURRENTLY` build before
   upgrading (`IF NOT EXISTS` would skip it).
3. `blob-refs.ts` comment: retention checks only `thread: true` columns.
4. The shortening email's count excludes Trash and says so (test).

## Decisions

1. **"Older than the period" = last activity** (`threads.last_activity_at`), not creation: a
   thread in use is never purged mid-conversation. Trash-and-retention both apply (whichever
   first).
2. **Effective period = shorter of team and install maximum**; a team can't choose above the
   maximum (409), and lowering the maximum keeps team choices (raising it restores them).
3. **Compaction covers every ended run** (all terminal statuses, as `runs_compaction_idx` was
   built for), not only `completed`; the conversation is in the mirrored entries, the event
   stream answers 410 `events_compacted`. Held threads are not compacted (hold suspends every
   purge), which made the `run_events` delete guard safe to add.
4. **Delete forever = request + purge** in two transactions so a hold stays confidential: the user
   and the team audit view see `thread.purge_requested` either way; `thread.purged` follows only
   when actually deleted. (A team admin can still infer a hold from a missing `thread.purged`;
   the same is true of nightly counts. Accepted, as KOBE-17 accepted for counts.)
5. **Blob deletion is a second phase** with a queue written in the purge transaction (no S3 call
   while deleting rows, no orphaned bytes on a crash), and re-checks the hold: a hold placed after
   the rows went keeps the bytes.
6. **Nightly = once a day at a configurable UTC hour** (`KOBE_RETENTION_HOUR_UTC`, default 3),
   catching up at once after 48 h without a pass. Session advisory lock, not a transaction lock,
   because a pass is many short transactions; on an unlock failure the connection is closed, never
   returned to the pool still holding the lock.
7. **Export includes restorable Trash**, never expired Trash (awaiting purge), never threads
   shared to the user, never other teams. Thinking blocks are left out of the Markdown (they are in
   the JSONL).
8. **Members can read the team's period** (`team.read`): it tells them how long their threads are
   kept. Only team admins change it.

## Review round 1 (security-review subagent; no CRITICAL)

- **HIGH export memory:** entries are pushed to the zip one at a time (page of 50), offloaded
  bodies are read with an 8 MiB cap counted while reading (stream destroyed past it), the active
  branch is walked in Postgres (recursive CTE, depth cap) instead of a Map of every entry, and at
  most 4 exports stream per replica (plus one per user). Failed reads are logged.
- **MEDIUM crafted `blob_ref`:** thread-owned objects must live in the thread's own tree,
  `<prefix>teams/<team>/threads/<thread>/…` (`threadKey`); the queue stores the purged thread's id
  and deletes only keys in that tree; export reads only keys in the entry's thread's tree. So a
  sandbox-written reference can't make export read, or a purge delete, another thread's, member's,
  team's or workspace's object (tests: crafted keys survive a purge; export marks such an entry
  `kobe_unavailable`). **KOBE-53/55: store uploads and artifacts under the thread tree** (or the
  thread's copy of them) and register the columns with `thread: true`.
- **MEDIUM export CSRF:** the GET refuses `Sec-Fetch-Site` other than `same-origin`/`none` and a
  foreign `Origin` (403 `forbidden_origin`).
- **MEDIUM hold lock duration:** `lock_timeout` is set before `lockLegalHolds` in every purge
  transaction; the S3 delete inside the blob transaction has a 30 s timeout (rollback, retried).
- **MEDIUM team admins can purge by lowering the period:** resolved by the user decision
  (7-day grace, banner, email, cancel; see above).
- **LOW** Delete forever's purge step hitting a lock timeout now answers 204 (the request is
  committed; the nightly Trash purge finishes it). Hold inference from a missing `thread.purged`:
  accepted (decision 4). `retention_blob_deletions.owner_user_id` FK: users are never deleted
  (Kobe deactivates). Reference-check TOCTOU: only within one thread's own tree now. The job's
  session advisory lock needs a direct (or session-mode pooled) connection, as KOBE-40's leader
  lock does.

## Open risks / follow-ups

- **Pi session files in the sandbox volume** (`/workspace/.kobe/sessions/<thread>.jsonl`, not
  synced to S3) survive a thread purge until the volume goes (hibernation keeps it). Deleting them
  needs a new sandbox-wire command (`session.delete`), i.e. a `packages/protocol` change in its own
  PR. Flagged, not built.
- Uploads and artifacts (KOBE-53/55) are purged only once those tickets register their blob
  columns with `thread: true` (and FK their rows to threads with `ON DELETE CASCADE`).
- `searchThreads({ activeSince })` is not wired to the retention period yet: threads past the
  period stay searchable until the next nightly pass (at most a day).
- Purging a thread doesn't notify a sandbox that may still hold it open (its run is never active:
  threads with queued/active runs are skipped).

## Evidence (acceptance criteria → test or command output)

| AC                                                        | Evidence                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purge skips held data                                     | server `retention.db.test.ts` › "legal hold suspends every purge" (user hold: expired, Trash, compaction and blobs kept, others go, release resumes; team-wide hold; hold placed after the rows went keeps the bytes); Delete forever under hold; db `retention.db.test.ts` (runs/run_events guards, TRUNCATE) |
| Purge removes exactly the expired threads and their blobs | server › "purges exactly the expired threads and their blobs; shared objects and other teams survive" (+ busy thread skipped, second pass no-op), "deletes only keys in the team's own key space"; unit `blobs.test.ts`                                                                                        |
| Export contains only the user's threads in that team      | server › "contains only the user's threads in the active team, as Pi JSONL and Markdown" (other member, other team, expired Trash excluded; Pi header + entry order; offloaded body; Markdown), stale-tab `?team=` refused                                                                                     |
| Cross-team probe passes                                   | db `probe.db.test.ts` with fixtures for `team_retention`, `retention_blob_deletions`; db test of their isolation (read and WITH CHECK)                                                                                                                                                                         |
| Settings, compaction, single replica, KOBE-28 API         | server › retention settings (permissions, maximum, 409), compaction (8 d vs 6 d, entries kept, 410), "one replica at a time, once a day", offboarding (refuses active member, purges, skips held)                                                                                                              |
| UI                                                        | web `retention-pages.test.tsx` (team page: capped banner, allowed periods, confirm; install page), `threads.test.tsx` (Delete forever with confirm, export link)                                                                                                                                               |
