# KOBE-216: B12: Fork to a new thread via Pi fork with provenance and back-link

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #281)
- **Branch / worktree:** `kobe-216-fork-thread` in `../Kobe-wt216`
- **Depends on:** KOBE-215 (provenance columns, merged), KOBE-209, KOBE-213, KOBE-214

## Plan

1. Purge safety first (ac-4, review-280 M1): lock a source's forks with `SKIP LOCKED`, skip
   sources whose forks are busy, never fail a step or answer 500 on 55P03/40P01.
2. Extend the existing D23 fork path (`services/server/src/threads/fork.ts`): write the
   provenance at INSERT, map the fork-link 23503 (ac-5).
3. Summary fields resolved for the viewer only (ac-6), then the web: action, dialog, origin
   marker, rail hover text.

## Decisions

1. **No second fork path, no Pi `fork` verb.** `forkThread` already copies the root → entry path
   with entry ids (and offloaded bodies). Pi's `fork` RPC is deliberately not bridged
   (`packages/protocol/src/sandbox-wire/pi-rpc.ts`: it moves Pi to a new session file). The
   fork's Pi session is rebuilt from the copied entries by `session.restore` on its first run
   (`delivery.ts #ensureSession`), so neither sandbox needs to be awake (ac-2). No wire change.
2. **Provenance at INSERT only.** `createThread` takes `forkedFrom: { threadId, entryId }`;
   `forked_at_entry_id` = the last copied entry (an empty thread can't be forked, see 9).
   Nothing ever UPDATEs the link (KOBE-215 trigger).
3. **ac-5:** a 23503 on `threads_forked_from_fk` (on the error or its drizzle `cause`) from either
   fork transaction answers `thread_not_found`; the blob path deletes its copies first.
4. **ac-6, back-link access.** `toSummary` never sends the source id. `summarize(tx, viewer,
rows)` (repository) resolves sources with `findThreads`, the batch form of `findThread` with
   the same `readableBy` predicate, and only then fills `forked_from_thread_id` and the new
   server-only `forked_from_title`. Every viewer-facing summary goes through it (list, Trash,
   detail, PATCH/leaf/agent-version/trash/restore answers, search hits). The site break-glass
   view sends null provenance. `forked_at_entry_id` is always sent: it is an entry of the fork itself,
   and the web resolves it only in the fork's own projection. One hop, no walk, so no depth bound
   is needed (nothing recurses).
5. **Protocol untouched.** The server spreads `threadOrganizationSchema.pick(forked_*)` into its
   own `threadSummarySchema` (pin/archive/title_locked are left to KOBE-219/220), plus
   `forked_from_title`. `POST /fork` still answers `{ thread_id }`. `openapi.json` regenerated.
6. **ac-4, purge.** `purgeBatchInTx` locks the picked sources' forks in one statement
   (`WITH locked AS (... FOR NO KEY UPDATE SKIP LOCKED)`, compare per source with the full count)
   and leaves out sources whose forks it could not all lock. Forks in the same batch are its own
   rows, so a chain H ← T ← G purges in one batch. No new fork can appear meanwhile (its FK check
   needs KEY SHARE on a source held FOR UPDATE). `purgeThreads` passes the skipped ids to later
   batches, so busy sources can't starve the rest. Belt and braces: a 55P03/40P01 from any batch
   now ends the loop as `busy` (logged at warn by the job), and Delete forever maps both to
   "purged later" (204). Contract comment in `purge.ts` updated.
7. **Web.** `fork-thread` command (GitFork icon) on every committed message's action bar (answer:
   its last entry; prompt: its parent, see 9); a Radix dialog asks for the title (prefilled with the
   thread's), forks, refreshes the list and opens the fork. `ForkOriginNote` under the project
   bar: "Forked from <source> at “excerpt”", the source as an `InlineLink` (now with an optional
   `onClick` for in-app navigation), or "a thread you can't open". Rail items carry
   `custom.forkHint` → the trigger's `title` ("hover card"; no hover-card primitive exists yet).
8. **Context gauge on a fresh fork:** the gauge reads the newest model call from the thread's own
   `run_usage`; a fresh fork has no runs, so it shows no gauge (the documented "unknown before
   the first call" state) until its first call, which then counts the copied history Pi
   restored. Sensible; not changed.

9. **Review round (review-281 L1–L5, /code-review 1–8), 2026-10-15.**
   - Titles: `threadTitleSchema` / `THREAD_TITLE_MAX` in `@kobe/protocol` (`common.ts`), used by
     the fork request, the server's create/rename `titleSchema` and the dialog; a NUL or control
     character is a 400 (L1, item 8). Additive tightening of the D23 fork request.
   - Races (L2): single-transaction 23503 tested; a body copy that fails re-checks the source
     with `findThread` and answers `thread_not_found` when it is gone (copies removed). Orphan
     copies after a crash between copy and store are still not swept (pre-existing; a later
     ticket could queue them in `retention_blob_deletions` first).
   - Size (L3): entries inserted in chunks of 1,000 (2,506-entry fork tested); forks are
     rate-limited to 30 per user per 10 minutes (`hitRateLimit`, 429 `rate_limited`). The plan
     still reads the whole tree to walk the path (pre-existing).
   - Uploads (L4): not copied, by design (they keep the source's retention and holds). The dialog
     says so; a copied prompt's attachment chips still render by name (lookups just find nothing).
   - Purge (L5, item 3): `purgeThreads` ends `partial` (with a `skipped` count) when sources were
     left out for busy forks; `busy` and `partial` are logged at warn with team and counts;
     `purgeDepartedMember` documents that only `done` is complete (offboarding test added).
   - Web (items 1, 2, 4): modified/non-primary clicks on the origin link keep the browser's
     behaviour; a fork refusal shows once (dialog, or the read-only banner), not in the thread's
     error banner; Fork on a prompt forks at its parent and puts the prompt in the new thread's
     composer as an unsent draft (no Fork on a prompt with nothing above it).
   - Search (item 5): hits carry `forked_*` resolved with `findThreads`, like the list.
   - Empty forks (item 6): refused with 409 `nothing_to_fork`, so every fork has a fork point and
     keeps its "forked from a thread you can't open" note even after its source is purged.
   - Errors (item 7): `pgErrorOf` / `pgCodeOf` / `isLockTimeout` / `isLockConflict` /
     `isForeignKeyViolation` in `@kobe/db` (`pg-errors.ts`); the repository, approvals broker,
     purge, Delete forever and fork use them.

## Open questions (for Chris or the coordinator)

- The rail "hover card" is a native `title` tooltip. If a richer hover card lands later (CE5/CE19),
  it should read `custom.forkHint` too.
- `session.restore` of an entry without `timestamp` hangs until the 5 s command timeout instead of
  failing fast (seen with a test fixture; real Pi entries always carry one). Not changed here.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/thread-fork.db.test.ts` "copies the entries up to the chosen message
  …" (sibling root, same project, provenance in detail + list + columns) and "forks inside a
  compacted history"; web `apps/web/components/chat/fork-thread.test.tsx` "asks for a title, forks
  at that message and opens the fork", "names the source and the message, and links back".
- ac-2: `thread-fork.db.test.ts` "forks with no sandbox running, then runs on the copied session"
  (session restored to exactly the copied path, run completes on the fork).
- ac-3: `thread-fork.db.test.ts` (summary fields in detail and list); `fork-thread.test.tsx`
  "shows the provenance when hovering the fork in the rail" and the origin-note tests.
- ac-4: `services/server/src/retention-forks.db.test.ts` (fork locked on a second connection:
  skipped without waiting, purged next pass; no starvation; chain in one batch; nightly pass not
  failed; Delete forever 204 under 3 s) and `retention/locks.test.ts` (55P03/40P01 → `busy`).
- ac-5: `thread-fork.db.test.ts` "answers thread_not_found and removes the copied bodies on the
  fork-link 23503" (a test-only BEFORE INSERT trigger deletes the source).
- ac-6: `thread-fork.db.test.ts` "names the source while the viewer can open it, and only the fork
  point once they can't" (unshare; detail, list and PATCH answers) and "shows only the fork point
  once the source is purged"; `fork-thread.test.tsx` neutral-text test; `lib/chat/fork.test.ts`.
- `pnpm verify` and `pnpm --filter @kobe/server test:db`: see PR checks.
