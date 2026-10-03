# KOBE-27: S3 ↔ /workspace sync

- **Status:** in review
- **Branch / worktree:** `kobe-27-workspace-sync` in `../Kobe-wt27`
- **Depends on:** KOBE-23 (agent), KOBE-24 (wire), KOBE-22 (provider), KOBE-25 (hibernate/wake),
  KOBE-38 (egress) — all merged.

## Acceptance criteria

Hadron (KOBE-27, spec D23, D26): ac-1 uploads are present in the sandbox before the run starts;
ac-2 project files are read-only to the agent; ac-3 shared files persist after PVC deletion.
Coordinator brief (D12, D13, D14, D15, D26, Gate 1/3 "sandbox deletion loses nothing"):

1. **ac-4 Durable workspace.** `/workspace` survives volume loss: write a file, hibernate, destroy
   the PVC, wake → the file is back.
2. **ac-5 No credentials in sandboxes.** Sandboxes never hold S3 credentials, URLs or object keys;
   sandbox egress to the object store stays closed.
3. **ac-6 When.** On hibernate, periodically, after runs; restore on wake/rebuild before Pi gets
   a prompt; cold start in mind (measured).
4. **ac-7 Conflict and consistency rules.**
5. **ac-8 Limits and a quota seam** for D26/KOBE-53.
6. **ac-9 Isolation** of object keys and manifest rows per (team, user); cross-team probe green.
7. **ac-10 Audit.**
8. **ac-11 API** for KOBE-53/54/57 documented here.

## Design

**Transport: the server brokers every byte, over the sandbox listener (D13: the agent "syncs S3
↔ /workspace"; §5.3: the server does "S3 sync coordination").** New HTTP endpoints under
`/v1/sandbox/workspace` on the server's sandbox port 8081 — the only server port the team
NetworkPolicy already allows — authenticated with the sandbox's `kobe.sandbox-wire` token and the
same checks as the wire upgrade (signature/audience/expiry, sandbox `sub` live, account active,
member). The server derives (team, user) from the token and every object key from that and a
SHA-256, then streams between the sandbox and S3. Contract:
`packages/protocol/src/sandbox-wire/workspace-sync.ts` (new, additive).

Why not presigned URLs: a presigned URL is a bearer credential to the object store, and using it
needs a network path from sandboxes to S3 (a new NetworkPolicy egress to an arbitrary external
endpoint, or through the egress proxy, which would then have to allow the S3 host for every
team and forward Kobe-internal traffic). Brokering needs **no new egress**, no credential of any
kind in the sandbox, and lets the server verify content hashes and enforce limits before S3
sees a byte. Why not over the existing WebSocket: 4 MiB frame cap and per-connection byte
budgets (KOBE-24) that bulk transfers would compete with, and a `packages/protocol` frame change.
Cost: workspace bytes pass through server replicas (bounded by per-sandbox concurrency and rate).

**Model (Postgres is the record, S3 holds bytes; D15).** Team tables (sandbox area, FORCE RLS,
`withTeam`): `workspace_sync` (per (team, user): `head_rev`, `horizon_rev`, live totals, last
push/restore), `workspace_files` (one row per path: rev, sha256, size, mtime, exec bit, origin
`sandbox|server`, `blob_key`; tombstones keep the deleted version's size/mtime),
`workspace_blobs` (content held in the workspace's own prefix; `deleting` marker for
collection). Content-addressed objects: `teams/<team>/users/<user>/workspace/<sha256>`; shared
copies `…/shared/<uuid>`. `workspace_files.blob_key` is registered in `BLOB_REF_COLUMNS`, so
`kobe backup` cross-checks it.

**Protocol.** `GET manifest?since` (paged, revision order, tombstones; 409 `resync_required`
below the horizon) · `POST blobs/missing` · `PUT blobs/<sha256>` (exact Content-Length; the
server hashes while streaming and withholds the last chunk until the hash matches, so a
mismatch aborts the S3 PUT and nothing is stored — verified against SeaweedFS 4.48 too) ·
`POST commit` (per-path compare-and-set) · `GET file?path` (bytes + entry header) ·
`POST restore-report`.

**Agent (`services/sandbox-agent/src/workspace/`).** Started right after the session trade, in
parallel with the wire and Pi:

- **restore** at start: full manifest vs volume by size + mtime (no reads of unchanged files);
  missing files downloaded (empty volume = full restore), local files newer than their copy kept
  and pushed; server-owned areas mirrored. ThreadManager's `beforeRun` (KOBE-23 seam) waits for
  it, then pulls, then checks the run's attachments exist — so a prompt never reaches Pi before
  the workspace is back (a restore that keeps failing lets runs start after 60 s, logged).
- **pull** before every run and every interval: changes since the last seen revision.
- **push** every `pushIntervalSeconds` (60 s), 2 s after a run ends, and as the final step when
  the agent stops (the `hibernating` close or SIGTERM: after Pi is gone, bounded 15 s inside the
  pod's 30 s grace). Plan under a lock (scan, hash changed files, ask what content is missing),
  upload outside it, commit under it again (dropping changes a pull touched meanwhile).
- Never synced: `.kobe/` (Pi session JSONL is rebuilt from Postgres, KOBE-24), directories named
  `node_modules`, `__pycache__`, `.venv` (rebuildable caches), symlinks, special files. Writes go
  to an exclusive temp file (`O_EXCL|O_NOFOLLOW`) renamed into place, parents checked component
  by component (never through a symlink).

## Decisions

- **Object store = external S3 (D4 says "external endpoint, optional bundled MinIO"; the chart
  already ships no bundled S3 because MinIO is AGPL, D3).** Workspace sync is on when
  `s3.bucket` is set and `sandbox.workspaceSync.enabled` (default true); otherwise the endpoints
  are not mounted, the server logs a warning, and agents switch sync off on the 404.
- **Auth reuses the `kobe.sandbox-wire` audience** (no new audience, so no change to the
  published session-token contract): the audience names the server's sandbox listener, and these
  endpoints live there. Positive principal answers cached 20 s like liveness.
- **Areas.** `uploads/` and `projects/` are server-owned: only server writes create rows there,
  commits to them are refused `read_only`, the agent mirrors them exactly (local edits reverted,
  extra files removed, files 0444 / dirs 0555 as a speed bump — same uid, so the guarantee is
  that nothing the agent does there reaches S3 and it is undone on the next sync). Everything
  else is sandbox-owned: the live volume is authoritative, S3 its durable copy.
- **Consistency.** Per-path compare-and-set on `base_rev`. A newer server-written version keeps
  the path and the sandbox's edit is kept beside it as `<name>.conflict-<UTC time><ext>` (then
  pushed); a deletion never beats a modification (conflicting delete dropped; a modification of a
  path deleted meanwhile applies on top of the tombstone). Restore on a kept volume: a
  sandbox-origin row that differs locally → local wins (newer work); a server-origin row → the
  server's version, with a conflict copy if the local file is newer than the server write.
- **Limits (seam for D26/KOBE-53).** `maxFileSize` 1 GiB (413, file stays local only),
  `maxFiles` 100 000, `maxWorkspaceSize` = the volume size (10 GiB), uncommitted uploads ≤ 2×
  that. `QuotaCheck` is a function of `(tx, {owner, fileBytes, liveFiles, liveBytes})` run inside
  the commit transaction — KOBE-53 passes its per-team quota there. Refusals are audited
  `sandbox.limit_exceeded` (throttled) and not retried until the file changes.
- **Collection** (every replica, hourly, jittered): blobs no live row references, 15 min after
  their upload or their release, whichever is later (an upload waiting for its commit, a reader
  that just resolved the entry), via a `deleting` marker (mark under the workspace lock →
  delete objects → delete rows) so crashes and concurrent uploads never leave a manifest row
  pointing at a deleted object; tombstones after 7 days (horizon moves; older `since` resyncs).
- **Audit:** `workspace.restored` (full restore onto an empty volume; counts reported by the
  sandbox, throttled), `workspace.file_shared`, `workspace.purged` (counts), plus four new
  `sandbox.limit_exceeded` values (`workspace_bytes`, `workspace_files`, `workspace_file_size`)
  and `workspace.integrity_failed` (see the security review below). New audit category `workspace`. Periodic pushes are not audited (one
  per sandbox per minute; content, not a security-relevant state change).
- **Rate and size bounds per sandbox:** 2000-request burst, 500/s; 16 concurrent transfers per
  replica; JSON bodies ≤ 1 MiB; ≤ 1000 entries per call.
- **Test S3:** unit tests use an in-memory store and a tiny in-repo fake S3 HTTP server (no
  dependency). dev/e2e use **SeaweedFS 4.48 (Apache-2.0)** as a test-only fixture in `kobe-deps`
  (`dev/s3.yaml`, also in Tilt) — never in the chart; MinIO (AGPL) is not used anywhere.
- New server dependency: `@aws-sdk/client-s3` (Apache-2.0; already in the lockfile via
  `@kobe/cli`). Client set to `requestChecksumCalculation: WHEN_REQUIRED` (plain PUTs that
  S3-compatible stores accept; integrity is the server's own SHA-256 check).

## API for KOBE-53 (uploads), KOBE-54 (file browser, share_file), KOBE-57 (projects)

Server-side, from `services/server/src/workspace-sync/index.ts`, all inside your own
`withTeam(db, teamId, tx => …)` transaction (record your audit event last in it):

- `workspaceSync.putServerFile(tx, {teamId, userId}, {path, sha256, size, blobKey, mtimeMs?,
executable?}, area)` (and `.deleteServerFile`) — writes a path into a user's workspace with
  origin `server`. `area` names the writer and the only key tree `blobKey` may be in: `uploads` →
  `teams/<team>/uploads/…` (KOBE-53), `projects` → `teams/<team>/projects/…` (KOBE-57), `user` →
  `teams/<team>/users/<user>/…` (KOBE-54 file browser); anything else throws; the sandbox pulls it before its
  next run (and periodically / on wake). You own the object at `blobKey` (e.g. KOBE-53 stores the
  upload at its own key; the manifest just points at it). Workspace collection never deletes
  it (it only deletes content sandboxes uploaded, `workspace_blobs`).
  - **KOBE-53:** S3 first, then `putServerFile(…, {path: "uploads/<thread_id>/<name>", …})`, then
    send `run.start.attachments[].path = /workspace/uploads/<thread_id>/<name>`; the agent's
    `beforeRun` pulls and fails the run if an attachment is missing (ac-1). Quota: pass your
    `QuotaCheck` to `createWorkspaceSync({quota})` (team totals: sum `workspace_sync.live_bytes`
    - volume sizes).
  - **KOBE-57:** project files → one `putServerFile` per member under `projects/<slug>/…`
    (pointing at the project's own object; `deleteServerFile` on removal). The area is
    read-only to the agent (ac-2).
  - **KOBE-54:** file-browser upload into any sandbox-owned path → `putServerFile` (conflict rule
    keeps a concurrent sandbox edit as a conflict copy); delete → `deleteServerFile(tx, owner,
path)` (audit it). Hibernated listing ("last synced listing", D26) →
    `listLive(tx, owner, dirPrefix, limit)` / `manifestPage`, no wake. Download →
    `currentEntry` + `workspaceSync.objects.get(entry.blobKey)`.
  - **KOBE-54 `share_file`:** `workspaceSync.shareFile(tx, owner, path, actor)` copies the current
    content to `teams/<t>/users/<u>/shared/<uuid>` (survives volume loss and workspace collection,
    ac-3) and audits `workspace.file_shared`; store the returned `blobKey` as `files.blob_ref`
    (add `files.blob_ref` to `BLOB_REF_COLUMNS`). The file must have been pushed: call the
    agent's push first (e.g. the tool asks the agent, which pushes then calls a share endpoint
    you add) — not built here.
- Sandbox-side: `WorkspaceSync.push()` / `pull()` (agent), `beforeRun` already wired.

## Open questions / risks

1. **Contract addition (flag):** `packages/protocol/src/sandbox-wire/workspace-sync.ts` is a new,
   additive contract (no existing contract changed). It was added inside this feature PR; split
   it out if the coordinator prefers.
2. **D31 says "sandbox volumes excluded (rebuildable)" from backup.** The durable workspace copy
   is now in S3 and `workspace_files.blob_key` is in the backup's blob-ref check, so a backup
   records it like other objects. Consistent with Gate 3 "sandbox deletion loses nothing".
3. **Offboarding (KOBE-28) and retention (KOBE-18):** a destroyed sandbox's workspace copy must be
   retained/purged with the volume (30 days) and honour legal hold; nothing deletes a
   (team, user) workspace copy yet.
4. **Cold start:** the restore on a kept volume is a scan + one manifest GET (+ one per run before
   its prompt). A very large workspace (≫ 10 000 files) costs a stat walk under gVisor on wake.
   A full restore after volume loss downloads everything before the first prompt (no lazy
   fetch: Pi's tools read the filesystem directly); measured below.
5. Same-uid model code can edit the agent's in-memory view only through the filesystem; at worst
   it corrupts its own workspace copy (its own team/user prefix), never another's.
6. Symlinks, empty directories and file modes other than the exec bit are not preserved.

## Review round (code-reviewer agent, before PR) — resolution

No isolation break found (keys derived server-side, RLS + explicit team/user, blob reuse only
within the caller's own workspace).

- **H1** one failing download (missing object, a directory in the way) made the restore retry
  forever, so the sandbox never pushed again. Downloads now fail per file (`#downloadSafely`):
  logged, kept for retry on later pulls, the local state kept and never turned into a deletion;
  only server/network failures retry the whole step. Test: "never lets one file block the
  restore".
- **H2** the first restore deleted pre-existing files under `uploads/`/`projects/`. Files the
  server never wrote there are now moved to `kobe-moved/<path>` (sandbox-owned, pushed), never
  deleted. Test: "moves files the server never wrote out of read-only areas".
- **M1** a download's transfer slot is released when its S3 stream closes, not when the response
  object is returned (bounded by backpressure for large files).
- **M2** any upload error now fails only that file (a growing log file can no longer block a push
  or the hibernate flush).
- **M3** a conflict against identical content (our own write whose answer was lost) is adopted,
  no conflict copy.
- **M4** the sandbox listener's `requestTimeout` is 1 h (uploads up to 1 GiB).
- **M5** manifest/missing/commit/report get a second, smaller bucket (burst 120, 20/s per
  sandbox); restore reports write at most once a minute per sandbox.
- **M6** tombstone purge is batched oldest-first (≤ 5000 per workspace per run).
- **L** reads, removals and uploads refuse paths with a symlinked parent; a 404 "no workspace
  sync" is re-asked every 5 minutes instead of disabling sync for the process lifetime.
- Not changed (noted): orphaned objects when the server dies between the S3 PUT and recording
  the blob (needs a periodic bucket listing sweep); grace is measured from upload time, so a
  freshly dereferenced blob can be collected at once (self-healing: the agent re-uploads on
  `missing_blob`); tombstone count per workspace is bounded only by the rate limits and the
  7-day purge.

## Security review (coordinator, PR #50, on hold) — resolution

Isolation was confirmed; the findings were availability (one compromised sandbox degrading every
tenant). Tests: `services/server/src/workspace-sync-limits.db.test.ts` (new) unless noted.

1. **HIGH DB pool exhaustion.** Every DB-backed endpoint now goes through one gate: per sandbox
   at most **1 commit** and **2 other short transactions** in flight (beyond: 429 at once, no
   connection taken), per replica at most **4** workspace transactions in total (a request waits
   up to 250 ms for a slot, then 503 + `Retry-After`), so one sandbox can never hold every slot.
   A download's one-row lookup counts only against the replica (its transfer slot bounds it per
   sandbox). Ending an upload (record content + release reservation) is never refused: 2
   dedicated replica slots, same timeouts, retried 3× with backoff on a lock timeout. At most
   4 + 2 of the server's 10 pool connections serve workspace sync. Each
   transaction sets `lock_timeout` 5 s and `statement_timeout` 30 s (`set_config(…, true)`); a
   timeout answers 503 `retry_later`. Restore reports no longer take the workspace row lock.
   Agent: bounded retries (5, honouring `Retry-After`) for busy answers on non-streamed calls;
   download concurrency 4. Tests: "lets one sandbox hold one commit at a time and never wait long
   on its row lock" (a held row lock: one commit times out at 300 ms → 503, five refused → 429),
   "caps database work across sandboxes per replica".
2. **HIGH unbounded uncommitted blobs.** `workspace_sync` keeps `blob_count`/`blob_bytes` and
   upload reservations (`pending_blobs`/`pending_bytes`). An upload reserves before accepting a
   byte, atomically: held + pending bytes ≤ `maxBlobBytes` (2× workspace size) **and** distinct
   blobs ≤ live files + `maxUncommittedBlobs` (10 000). Collection loops in batches until the
   workspace is drained or a 20 s budget per workspace is spent, then recomputes the counters from
   the rows. Tests: "caps the number of uncommitted blobs, and committing them frees room",
   "collection drains a flood of uncommitted blobs in one run".
3. **HIGH unbounded tombstones.** Rows (live + tombstones) are capped per workspace (`maxRows`,
   default 2× `maxFiles`, tracked in `workspace_sync.tombstones`). A new path at the cap first
   compacts the oldest 1000 tombstones in the same transaction (the horizon moves; older pullers
   resync); only an all-live workspace refuses (`too_many_files`). Test: "compacts tombstones at
   the cap instead of growing, and refuses only when all rows are live".
4. **MEDIUM upload quota race.** Bytes are reserved at check time (item 2) and released or moved
   into the totals when the upload ends (also on failure; crashed reservations are cleared by
   collection after 2 h, longer than any upload can run). Test: "never lets concurrent uploads
   overshoot the byte budget" (8 × 1 MiB at once against 3 MiB: exactly 3 stored).
5. **MEDIUM GC grace.** `workspace_blobs.released_at` is set whenever a path stops pointing at
   content; grace runs from `GREATEST(created_at, released_at)`, so a download or `shareFile` that
   resolved an entry just before an overwrite still finds the object. Test: "keeps content that
   just stopped being referenced, even if it was uploaded long ago".
6. **MEDIUM auth cache.** TTL 20 s → 5 s, and the cache is dropped on every replica on the sandbox
   bus's `user:<id>` hint (`SandboxWire.onUserRevalidate`), which deactivation and team removal
   already send. Test: "a removed member's sandbox loses access at once".
7. **MEDIUM putServerFile keys.** `assertOwnedKey`: the object must be under
   `<prefix>teams/<team>/`, and under `teams/<team>/users/` only this user's; no empty, `.` or
   `..` segments. Callers use `workspaceSync.putServerFile` (passes the prefix and row cap). Test
   (`workspace-sync.db.test.ts`): other team, other user, `..`, foreign prefix all refused.
8. **LOW** `lockServerOwned` lstat's the area roots (a symlinked `uploads` is left alone; entries
   never follow links); `renameWithin` (and so conflict copies, evictions) refuses parents that go
   through a link. Tests: `workspace/fs.test.ts`.
9. **LOW** TOCTOU scope of `parentsAreDirs` → open/unlink/rename documented as accepted in
   `fs.ts`: same uid, so a swap gains model code nothing it can't do directly.
10. **LOW** conflict-copy names are truncated (UTF-8 safe) to stay ≤ 255 bytes; one commit
    result that fails locally no longer abandons the rest (`#applyResult` per result, the path's
    known state dropped and recomputed). Test: "keeps conflict-copy names within one path
    segment".
11. **LOW** paths with bidirectional controls (U+202A–202E, U+2066–2069, LRM/RLM/ALM) or a BOM
    are invalid (protocol test). Other format characters (ZWJ/ZWNJ, needed in Persian, Indic and
    emoji names) stay valid: rejecting all of `\p{Cf}` would silently stop syncing such files. Integrity failures have their own action `workspace.integrity_failed`
    with a `failures` count (one row per minute per sandbox; suppressed mismatches are counted into
    the next row, not dropped). The agent ignores server entries with an invalid path or in its
    excluded area (test "ignores server entries in its own area…").
    **For KOBE-28:** `workspace_sync`/`workspace_files`/`workspace_blobs.user_id` reference
    `users` with `ON DELETE no action` (like `sandboxes`): deleting a user requires purging their
    workspace rows (and S3 prefix) first.

- Concurrency: "commits racing collection never leave a manifest row pointing at a deleted
  object" (12 rounds of upload + commit concurrently with collections), and the parallel-uploads
  quota test above.
- Self-review of the hardening (second round): the upload-finish transaction now runs gated
  and with timeouts (test "an upload that ends while a commit holds the workspace lock waits
  briefly and is recorded"); compaction's state is kept even when the cap still isn't cleared
  (otherwise deletions would be lost to pullers: rows gone, horizon not moved); collection
  decrements the blob counters as it deletes and recomputes them in a `finally`; a workspace at
  its upload budget triggers a collection of itself (at most every 5 minutes) and the agent
  retries 507 on its next push instead of giving up on the file; default grace 1 h → 15 min;
  the auth cache keeps a per-user generation so a lookup racing a revocation never re-caches.
  Accepted: a reservation can be released twice if a commit's acknowledgement is lost (counters
  clamp at 0 and collection recomputes them); released content within its grace still counts
  against the upload budget (a workspace churning large files can see 507 for up to the grace
  period, 15 min, before the kicked collection frees it).
- Migrations regenerated with db:rebase after KOBE-37 (#48) and KOBE-17 (#49): 0035_workspace_sync, 0036_workspace_sync_rls: new `workspace_sync` counters, `workspace_blobs.released_at`.

## Re-review (coordinator, a43b472) — resolution

Tests: `workspace-sync-limits.db.test.ts` "one sandbox can't starve another's sync on a replica";
agent `sync.test.ts`.

- **M1 slots held behind the workspace row lock.** Only a commit may wait long for the
  workspace lock (`lockTimeoutMs` 5 s, one commit per sandbox). Every other transaction (upload
  reservation and finish, restore report, manifest, lookups) waits at most `shortLockTimeoutMs`
  **400 ms**, then answers 503 and frees its slot. Test: uploads behind a sandbox's own held lock
  all answer within 3 s while another tenant uploads, commits and reads normally.
- **M2 download lookups uncounted.** They take one of the sandbox's short slots (2). Agent
  download concurrency 2 to match. Test: with one slot, a second concurrent download is 429.
- **M3 finish pool starvation.** One finish per sandbox at a time (its own queue) on top of the
  2-slot replica pool, short lock timeout, and both slots released while backing off. Test: with
  six of a sandbox's finishes stuck behind its lock (2 s waits), another tenant's upload finishes
  in < 1.5 s (fails without the per-sandbox cap).
- **M4 kicked collections.** At most one per replica at a time, with a 5 s budget (a later
  pressure on any workspace is skipped while one runs). Test: a second workspace's pressure
  starts no collection while the first is running; after it, it does.
- **M5 deletions lost after a resync.** `#manifestSince` reports a full listing; after a resync
  (`since` fell behind the horizon) every known path missing from it is handled as a server
  deletion (local file removed if unchanged or read-only; a local modification is kept and
  pushed as a new file). Test: "applies deletions it missed when the server compacted them away".
  Accepted limit: at agent start (restore) there is no known state, so a file deleted on the
  server _and_ compacted away while the sandbox was down is indistinguishable from unpushed local
  work and is pushed back (lossless bias; the hibernate flush makes unpushed work rare).
- **L1** `manifestPage` re-reads the horizon after the rows and answers `resync_required` if a
  compaction moved it past `since` in between.
- **L3** server writes name their area: `workspaceSync.putServerFile(tx, owner, file, area)`
  with `uploads` → `teams/<t>/uploads/…`, `projects` → `teams/<t>/projects/…`, `user` →
  `teams/<t>/users/<u>/…`; anything outside that one tree throws (test covers another team,
  another user, another area, `..`, a foreign prefix).
- **L4** the workspace authenticator's liveness cache is 5 s (the wire keeps its own 20 s); with
  the 5 s principal cache a destroyed or replaced sandbox loses sync access within 5 s.
- **L2 (noted, accepted): reservation leak window.** If a replica dies mid-upload, its reservation
  (`pending_blobs`/`pending_bytes`) stays until a collection run finds `pending_since` older
  than 2 h, so up to **≈ 3 h** (2 h staleness + the hourly collection interval). Meanwhile that
  workspace's upload budget is short by the leaked bytes and one blob. Also, `pending_since` is
  only set when the first reservation is taken and cleared when the last ends: under
  continuously overlapping uploads it does not advance, so after 2 h of uninterrupted overlap a
  collection could clear reservations that are still live (their later `finishUpload` clamps at 0,
  and the next collection recomputes the blob counters). Bounded and self-healing; a
  per-reservation row with its own timestamp would remove both if it ever matters.

## Measurements

- Unit (agent ↔ in-memory fake server over localhost, macOS): full restore of 500 files
  (≈ 2 MB) onto an empty volume: **≈ 145 ms**; kept-volume wake: one manifest GET, no downloads.
- e2e (CI k3d + gVisor + SeaweedFS, run 37140046507): rebuilt sandbox (PVC deleted) — agent
  full restore `durationMs` **75 ms** (1 file); the file was back in the sandbox **9 s after the
  wake** (pod start + session trade + restore). Plain wake on a kept volume (cold-start user):
  incremental restore **43 ms**, no downloads.
- Cold start with sync on (KOBE-25 harness, hibernated → Pi ready, not first token): back-to-back
  20 trials **p50 4039 ms, p95 4376 ms**; spaced 5 trials p50 3765 ms, p95 4478 ms — in line with
  KOBE-25's run 4 (p95 4862 ms), so no measurable cost; p95 ≤ 8 s holds.
- A full restore of a large workspace sits before the first prompt (no lazy fetch). Levers if it
  matters: a batch download endpoint (one tar stream instead of one GET per file), prioritising
  `uploads/` and recently modified files.

## Evidence (acceptance criteria → test or command output)

| AC    | Evidence                                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1  | agent `sync.test.ts` "pulls uploads before a run, read-only, and fails a run whose attachment is missing"; `agent.runs.test.ts` "restores the workspace before the prompt reaches Pi…", "fails the run when the workspace cannot be prepared"; server db "delivers server writes (uploads, project files) to the sandbox's next pull" |
| ac-2  | agent "keeps project files read-only: local edits are reverted and never reach the server"; server db "never accepts sandbox writes to server-owned or agent-internal areas"                                                                                                                                                          |
| ac-3  | server db "shares a file to a durable object that outlives the workspace copy" (workspace copy deleted and collected, share intact)                                                                                                                                                                                                   |
| ac-4  | e2e "workspace sync (KOBE-27)": write → hibernate (final push, manifest row + object under the team/user prefix in SeaweedFS) → PVC deleted → wake → file back; agent "pushes the workspace and restores it onto a new, empty volume"                                                                                                 |
| ac-5  | design (no new egress, server brokers); e2e "the sandbox holds no object-storage credentials or endpoint"; server db: manifest never contains an object key; sandbox pod env unchanged except `KOBE_WORKSPACE_SYNC_INTERVAL_MS` (`manifests.test.ts`)                                                                                 |
| ac-6  | agent "flushes pending changes when stopping (hibernation)", "wakes on a kept volume without downloading anything", periodic + run-end push (`agent.runs.test.ts` hooks)                                                                                                                                                              |
| ac-7  | server db "applies a change only on the revision it was based on"; agent "keeps both versions…", "propagates deletions both ways; a deletion never beats a modification", "keeps local edits made after the last push"                                                                                                                |
| ac-8  | server db "refuses oversized files, too many files and too many bytes, and audits it"; `QuotaCheck` seam                                                                                                                                                                                                                              |
| ac-9  | server db "never serves or reuses another team's or another user's content" (same user other team, other user same team, RLS); `@kobe/db` probe suite with the three new tables                                                                                                                                                       |
| ac-10 | server db audit assertions (`workspace.restored`, `.file_shared`, `.purged`, `sandbox.limit_exceeded` workspace limits); `docs/audit-log.md`; `events.test.ts` documented-actions check                                                                                                                                               |
| ac-11 | "API for KOBE-53/54/57" above                                                                                                                                                                                                                                                                                                         |

Commands (local): `build typecheck lint format:check license:check` green (lint: only the known
Helm 4 chart failure); `test --concurrency=2` 16/16; `@kobe/server test:db` 490/490 (+ the
workspace suite after the review), `@kobe/db test:db` 429/429; `db:check` clean;
`check-public-hygiene.sh` ok. S3 store verified against a real SeaweedFS 4.48 (put/get/copy/delete;
a hash mismatch stores nothing).
