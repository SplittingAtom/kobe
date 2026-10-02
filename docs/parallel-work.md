# Parallel work

How several agents build Kobe tickets at the same time without colliding. One coordinator session
picks ready tickets, starts one agent per ticket, reviews and merges; ticket agents follow the rules
below.

## One ticket, one worktree, one branch

```bash
git worktree add ../Kobe-wt<N> -b kobe-<N>-<slug> origin/main
cd ../Kobe-wt<N> && pnpm install --frozen-lockfile
```

Never work in another ticket's worktree or push to its branch. Remove the worktree after merge.

## Ledger

Each ticket keeps its working notes in `docs/ledger/KOBE-<N>.md` (start from
[`docs/ledger/TEMPLATE.md`](ledger/TEMPLATE.md)): status, decisions, open questions, evidence.
Only the coordinator edits [`docs/RUN-LEDGER.md`](RUN-LEDGER.md), which is a short index.

## Shared files

| File                                               | Rule                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/src/tenancy/<area>.ts`                | Add your tables to your spec area's file only. `tenancy.ts` combines the areas; don't edit it to add tables.             |
| `packages/db/src/testing/probe-fixtures/<area>.ts` | Probe fixtures per area, spread into `index.ts` (one line per area).                                                     |
| `packages/db/src/schema/`                          | New tables in new files; add one `export *` line to `index.ts`.                                                          |
| `packages/db/drizzle/`                             | See [Migrations](#migrations).                                                                                           |
| `services/server/src/routes/`                      | One route module per area, mounted with one line in `app.ts`.                                                            |
| `packages/protocol`                                | Contracts are agreed before dependants start; change a published contract only in its own PR, never inside a feature PR. |
| `charts/kobe/values.yaml`                          | Add values under your component's key; don't reorder or reformat other sections.                                         |

`schema/index.ts` and `probe-fixtures/index.ts` use git's `union` merge driver
(`.gitattributes`), so two branches that each append a line merge cleanly. Keep those files to
one entry per line.

## Migrations

Drizzle numbers migrations and chains their snapshots, so two branches that both add a migration
always conflict (two `0004_*`, the journal, the snapshot chain). Never resolve those conflicts by
hand. When `main` has moved on and your branch has migrations:

```bash
git fetch origin
pnpm --filter @kobe/db db:rebase            # stash yours, merge origin/main, regenerate
# on other conflicts: resolve, commit the merge, then
pnpm --filter @kobe/db db:rebase --apply
```

The script regenerates all your schema changes as one migration and re-creates each custom
migration (RLS policies, data fixes) after it with its original SQL. It merges rather than rebases,
so expect a merge commit. Do it just before your PR merges; CI's `db` job
(`drizzle-kit check`, schema-vs-migrations check, journal order test, cross-team probe) must stay
green afterwards.

## Shared environments

- **Postgres for tests:** `KOBE_TEST_DATABASE_URL` points at a server, not a database. Each test
  run creates its own throwaway `kobe_test_<random>` database and roles, so agents can share one
  server (the dev Postgres on compute2) safely.
- **Tilt against the real cluster:** each agent uses its own namespace and port-forward:

  ```bash
  KOBE_DEV_NAMESPACE=kobe-dev-<N> KOBE_DEV_WEB_PORT=30<NN> tilt up --port 103<NN> ...
  ```

  The namespace must be `kobe-dev` or start with `kobe-dev-`. k3d dev stays on `kobe-dev`.

- **k3d end-to-end on compute2:** one cluster at a time (inotify limits). Prefer CI's `e2e` job;
  run `e2e/run.sh` locally only when the coordinator says the cluster is free.

## Merging

The coordinator merges one PR at a time. Before each merge: bring the branch up to date with
`main` (`db:rebase` if it has migrations, otherwise `git merge origin/main`), wait for CI green
(`checks`, `db`, `images`, and `e2e` on PRs), and act on the review.
