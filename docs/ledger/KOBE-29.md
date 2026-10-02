# KOBE-29: Schema: threads, entries, runs, run_events, events

- **Status:** in review (PR #11)
- **Branch / worktree:** `kobe-29-conversation-schema` in `../Kobe-wt29`
- **Depends on:** KOBE-8 (merged)

## Acceptance criteria (derived from spec D5, D15–D18, §5.4, §6.2; Hadron not reachable)

1. ac-1 `threads`, `thread_entries`, `runs`, `run_events`, `events` exist with the §5.4 columns and enums
   (`thread_status` idle|running|interrupted; `run_trigger` user|schedule; `run_status`
   queued|running|waiting_approval|completed|failed|interrupted|cancelled|budget_stopped;
   `event_status` pending|processed|failed|scheduled).
2. ac-2 Every table is a team table: `team_id uuid NOT NULL`, team_id-leading index, ENABLE + FORCE RLS
   with the canonical policy, probe fixture; catalog check and cross-team probe suite green.
3. ac-3 Pi session tree mirrored one-to-one (D15): `entry_id`/`parent_id` per thread, parent must be in
   the same thread, `threads.leaf_entry_id` must be an entry of that thread.
4. ac-4 `run_events.seq` is monotonic and gapless per run under concurrent appends, and commit order
   equals seq order, so a reader resuming with `starting_after` never skips an event (D16, U4).
5. ac-5 One active run per thread is also enforced by the database (D17), in addition to the
   orchestrator's advisory lock.
6. ac-6 No row can reference another team's thread/run/entry (foreign keys include `team_id`), so FK
   checks and cascades, which bypass RLS, cannot cross teams.
7. ac-7 Indexes serve the access paths the spec implies: thread list per owner/project by activity,
   Trash/purge by `deleted_at`, runs per thread, run_events by (run, seq), run_events compaction by
   `ended_at` (D18), due events.

## Plan

- Schema files `schema/threads.ts`, `schema/runs.ts`, `schema/events.ts`; generated migration + one custom
  migration (RLS + seq triggers).
- Tests first: `src/conversations.db.test.ts` (integrity, seq, active-run) and unit test for enum values.

## Decisions

1. **Composite keys with team_id.** `threads`, `runs`, `events` have PK `(team_id, id)`;
   `thread_entries` PK `(team_id, thread_id, entry_id)`; `run_events` PK `(team_id, run_id, seq)`. Every
   intra-area foreign key includes `team_id` (FK checks and cascades bypass RLS, so a single-column FK
   would let team A reference, or cascade into, team B's rows). **Convention for other areas:**
   reference a thread/run as `(team_id, thread_id) → threads (team_id, id)` /
   `(team_id, run_id) → runs (team_id, id)`.
2. **Gapless seq by trigger, not a sequence.** A `BEFORE INSERT` trigger (SECURITY INVOKER, so under the
   caller's RLS) increments `runs.last_seq` and assigns it; the run's row lock serializes appends until
   commit, so commit order = seq order and a reader that sees seq n has seen all of 1..n. A
   rolled-back append rolls back its increment. Callers omit `seq` (a non-zero value is rejected);
   `seq` is immutable after insert. Same mechanism for `thread_entries.seq` via
   `threads.last_entry_seq`. A Postgres sequence would leave gaps and could commit out of order.
   Appends must run in READ COMMITTED; **lock order: thread row before run row** in a transaction
   that writes both.
3. **`thread_entries.seq` added** (not in §5.4): per-thread append order, needed to rebuild Pi JSONL
   (D13, U15) and export it (D18) in original order; `created_at` ties within a transaction.
4. **`run_events.type`, `thread_entries.type`, `events.kind` are text**, not enums. The event
   vocabulary is owned by `@kobe/protocol` (validated at write time); entry types are Pi's; event
   kinds are owned by producing areas. DB checks the format only, so adding a type needs no
   migration. State machines (`thread_status`, `run_trigger`, `run_status`, `event_status`) are
   enums, exactly as §5.4.
5. **One active run per thread in the database too:** partial unique index on `runs (team_id,
thread_id) WHERE status IN ('running','waiting_approval')`, backing the D17 advisory lock. Queued
   runs are unlimited.
6. **Run invariants as checks:** `ended_at` set iff status is terminal (completed, failed,
   interrupted, cancelled, budget_stopped); active runs have `started_at`; `queue_pos` only on queued
   runs. `ACTIVE_RUN_STATUSES` / `TERMINAL_RUN_STATUSES` are exported for the orchestrator.
7. **Deferred to their owners:** `threads.agent_id`/`agent_version` are nullable (both or neither)
   with no FK until agents exist (KOBE-45/46; null = install default agent);
   `threads.project_id` FK arrives with projects (KOBE-57); `threads.tsv` and its index are left to
   thread search (KOBE-33), which decides what is indexed. Run input/queued-message content and
   NOTIFY fan-out are KOBE-30/31.
8. **`threads.owner_user_id → users` is NO ACTION** (users are deactivated, never deleted; a stray
   delete must not erase history). Team FKs cascade, as in `team_members`.
9. **`leaf_entry_id` FK is NO ACTION:** retention purges whole threads (cascade works, tested);
   deleting a single leaf entry is refused.

## Open questions (for Chris or the coordinator)

- Spec §6.2 has no `run.cancelled` event although `run_status` has `cancelled`; flagged for the
  contracts (protocol) owner. No schema impact (event type is text).
- `run_events` write rate: each event updates its `runs` row (HOT update; `last_seq` is not indexed).
  If text deltas are not batched by the server this is a hot row per run; KOBE-31 should batch
  deltas per insert (multi-row inserts are supported).

## Evidence (acceptance criteria → test or command output)

- ac-1: `src/schema/conversations.test.ts` (enum values = §5.4); migration `0004_conversations.sql`.
- ac-2: `catalog.db.test.ts` (RLS, FORCE, canonical policy, team_id NOT NULL, team_id-leading index for
  all five tables) and `probe.db.test.ts` (6 probes × 5 tables) green; fixtures in
  `testing/probe-fixtures/conversations.ts`.
- ac-3: `conversations.db.test.ts` › "thread_entries mirror the Pi session tree" (branches, parent in
  same thread, duplicate id, leaf in same thread, hard delete cascade).
- ac-4: `conversations.db.test.ts` › "run_events.seq" (per-run 1..n, 25 concurrent writers → 1..100,
  rollback leaves no gap, reader never sees n+1 before n, caller seq rejected, renumber rejected).
- ac-5: › "runs" (second running/waiting_approval run → 23505; queued allowed; ended_at/queue_pos checks).
- ac-6: › "team-scoped foreign keys" (entry/run/run_event in team A pointing at team B → rejected).
- ac-7: indexes in `0004_conversations.sql` (threads owner/project activity, Trash, runs per thread,
  one-active, ended for compaction, events queue; FK-supporting PK prefixes).
- `pnpm build test typecheck format:check` green; `lint` green except pre-existing `@kobe/chart`
  (Helm 4 `license` field); `pnpm --filter @kobe/db test:db` 99/99; `db:check` clean.
