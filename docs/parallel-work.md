# Parallel work

How several agents build Kobe tickets at the same time without colliding. One coordinator session
picks ready tickets, starts one agent per ticket, reviews and merges; ticket agents follow the rules
below.

## One ticket, one worktree, one branch

```bash
git worktree add ../Kobe-wt<N> -b kobe-<N>-<slug> origin/main
cp ../Kobe/CLAUDE.local.md ../Kobe-wt<N>/   # local infra notes (gitignored)
cd ../Kobe-wt<N> && pnpm install --frozen-lockfile
```

Never work in another ticket's worktree or push to its branch. Remove the worktree after merge.

## Ledger

Each ticket keeps its working notes in `docs/ledger/KOBE-<N>.md` (start from
[`docs/ledger/TEMPLATE.md`](ledger/TEMPLATE.md)): status, decisions, open questions, evidence.
Only the coordinator edits [`docs/RUN-LEDGER.md`](RUN-LEDGER.md), which is a short index.
Keep a ticket ledger under ~150 lines: decisions and links to evidence, not pasted logs.

## Handoff and token budget

The coordinator starts each ticket agent with a generated `BRIEF.md` in the worktree
(`scripts/hadron.sh brief <N>`) and the prompt in [agent-prompt.md](agent-prompt.md), which also
sets the model per job and the review level per diff. Ticket agents read the brief instead of the
whole spec and other ledgers, run `pnpm verify` before pushing (it formats and, with
`KOBE_TEST_DATABASE_URL` set, runs the DB tests), wait for CI with exactly one background
`gh pr checks <n> --watch` (never a loop around `pgrep` or `sleep`), and end with a report of at
most 150 words that states their token use.

## Shared files

| File                                               | Rule                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/tenancy/<area>.ts`                | Add your tables to your spec area's file only. `tenancy.ts` combines the areas; don't edit it to add tables.                                                                          |
| `packages/db/src/testing/probe-fixtures/<area>.ts` | Probe fixtures per area, spread into `index.ts` (one line per area).                                                                                                                  |
| `packages/db/src/schema/`                          | New tables in new files; add one `export *` line to `index.ts`.                                                                                                                       |
| `packages/db/drizzle/`                             | See [Migrations](#migrations).                                                                                                                                                        |
| `services/server/src/routes/`                      | One route module per area, mounted with one line in `app.ts`.                                                                                                                         |
| `packages/protocol`                                | Contracts are agreed before dependants start; change a published contract only in its own PR, never inside a feature PR.                                                              |
| Queries on `threads` / `thread_entries`            | Always state `team_id` explicitly, even inside `withTeam()` (break-glass policy; see `packages/db/README.md`). Enforced by `services/server` tests `team-filter` and `threads-plans`. |
| `charts/kobe/values.yaml`                          | Add values under your component's key; don't reorder or reformat other sections.                                                                                                      |

`schema/index.ts` and `probe-fixtures/index.ts` use git's `union` merge driver
(`.gitattributes`), so two branches that each append a line merge cleanly when merged locally
(GitHub's own conflict check may ignore it: merge `origin/main` locally before merging a PR). Union
never reports a conflict, so keep those files to one entry per line and run `pnpm typecheck` after
every merge: a stale or duplicate line only shows up there.

## Migrations

Drizzle numbers migrations and chains their snapshots, so two branches that both add a migration
always conflict (two `0004_*`, the journal, the snapshot chain). Never resolve those conflicts by
hand. Land a ticket's migration in its own small PR first (schema, migration, RLS policy, probe
fixtures), then the feature PR without a snapshot in its diff. `drizzle/meta/*_snapshot.json` is
marked generated in `.gitattributes`: collapsed on GitHub, skipped in review. When `main` has moved
on and your branch has migrations:

```bash
git fetch origin
pnpm --filter @kobe/db db:rebase            # stash yours, merge origin/main, regenerate
# on other conflicts: resolve, commit the merge, then
pnpm --filter @kobe/db db:rebase --apply
```

The script regenerates all your schema changes as one migration and re-creates each custom
migration (RLS policies, data fixes) after it with its original SQL. It merges rather than rebases,
so expect a merge commit; your original migrations stay in history (`HEAD~1` of the drop commit),
and a dev database that ran them must be reset. Do it just before your PR merges; CI's `db` job
(`drizzle-kit check`, schema-vs-migrations check, journal order test, cross-team probe) must stay
green afterwards.

### Hand-written migrations

A migration whose first line is `-- kobe:hand-written` changes the schema with SQL that drizzle
cannot generate (renames, `IF NOT EXISTS`, `NOT VALID`). `db:rebase` keeps its SQL **and its
snapshot** and only renumbers it, so it refuses (`scripts/migration-plan.mjs`) when:

- the branch also has a generated migration (land them in separate PRs), or
- `main` changed the schema after the branch forked: the kept snapshot would miss main's change.

So a branch with a hand-written migration merges **before** any other schema-changing PR in the
queue (group-1-fixes, KOBE-252's `0098_events_schedule_latest`, is such a branch). If main moved
anyway, rebase it by hand:

1. `git merge origin/main`, taking main's `drizzle/` (journal and snapshots) on conflict.
2. Move the hand-written SQL to the next free number, and add its journal entry (next `idx`, a
   `when` after main's last).
3. Re-derive its snapshot: copy main's newest snapshot, apply the migration's schema change to it
   (the same column, constraint or rename as in the old snapshot's diff against its predecessor),
   set a new `id` and `prevId` = main's newest snapshot `id`.
4. `pnpm --filter @kobe/db db:check` must print no changes; run `pnpm --filter @kobe/db test:db`.

SQL-only objects (indexes, policies, `NOT VALID` checks) are not in the snapshot, so they need no
step 3.

## Shared environments

- **Postgres for tests:** `KOBE_TEST_DATABASE_URL` points at a server, not a database. Each test
  file or suite creates its own throwaway database and roles, so agents can share one server (the
  dev Postgres; URL in `CLAUDE.local.md`). Each worktree is a **test lane** (KOBE-482):
  - **Picking the lane:** `KOBE_TEST_DB_LANE` (1-20 of `[a-z0-9]`; empty means no lane), else the
    worktree directory name lowercased to `[a-z0-9]` without the leading `kobe` (`Kobe-wt482` →
    `wt482`, `Kobe` → `kobe`). CI sets `CI`, so it has no lane unless `KOBE_TEST_DB_LANE` is set:
    one database per job, as before.
  - **What a lane changes:** every DB suite's global setup creates `kobe_lane_<lane>` if missing
    (`prepareTestLane`), tests reach the server through that database instead of `postgres`, and
    every throwaway database and role is named `kobe_<kind>_<hex>_<lane>` (`testNameSuffix()` in
    `@kobe/db/testing`; use it for any database or role a test creates). Roles are cluster-wide but
    random per suite, and setup never drops a role it did not create, so lanes never touch each
    other's objects.
  - **Connections:** lanes share the server's `max_connections` (100 on the dev Postgres) and a
    server DB file peaks at about 12. Two lanes running the full server suite at once with the
    default `KOBE_DB_TEST_WORKERS=4` passed (2026-10-22, 10 min each); with three or more lanes on
    the server suite at once, set `KOBE_DB_TEST_WORKERS=2` per lane.
  - **Cleaning up:** a crashed run leaves its lane's databases behind. With the lane idle,
    `pnpm --filter @kobe/db build` then `pnpm --filter @kobe/db test:lanes` lists lanes with their
    database and role counts and `pnpm --filter @kobe/db test:lanes drop <lane>` drops one (its
    `kobe_lane_<lane>` database, its throwaway databases and roles). Drop a worktree's lane when you
    remove the worktree. Leftovers named without a lane (`kobe_test_<hex>`) predate lanes or come
    from runs with `KOBE_TEST_DB_LANE=""`.
- **Tilt against the real cluster:** each agent uses its own namespace and port-forward:

  ```bash
  KOBE_DEV_NAMESPACE=kobe-dev-<N> KOBE_DEV_WEB_PORT=30<NN> tilt up --port 103<NN> ...
  ```

  The namespace must be `kobe-dev` or start with `kobe-dev-`. k3d dev stays on `kobe-dev`.

- **k3d end-to-end on the remote Docker host:** one cluster at a time (inotify limits). Prefer CI's `e2e` job;
  run `e2e/run.sh` locally only when the coordinator says the cluster is free.

## Merging

The coordinator merges one PR at a time. Before each merge: bring the branch up to date with
`main` (`db:rebase` if it has migrations, otherwise `git merge origin/main`), wait for CI green
(`checks`, `db`, `images`, and `e2e` on PRs), and act on the review.
