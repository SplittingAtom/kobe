# KOBE-721: CI: reuse Turbo build output across jobs, parallel static/unit checks, composite setup actions (review CODE-35-36)

- **Status:** in review (group 62, branch `group-62-ci-build-images`)
- **Depends on:** none (lands after KOBE-723 in the same group)

## Decisions

- **Required checks unchanged.** The `main: merge queue` ruleset requires `checks`, `db`, `images`,
  `k3d` (read with `gh api repos/{owner}/{repo}/rulesets/24417480`). `ci.yml`'s old serial
  `checks` job is now `static` (hygiene, wording, format, build, typecheck, lint, license check)
  and `unit` (build, unit + chart tests, privilege separation, Gate 2 harness) side by side, plus a
  thin `checks` job (`needs: [static, unit]`, `if: always()`) that fails unless both succeeded,
  the same pattern as `db`. `images`/`k3d` (e2e.yml) are untouched.
- **Turbo cache.** `setup-kobe` restores `.turbo/cache` (key `turbo-<os>-<lockfile hash>-<UTC day>`,
  restore keys: same lockfile, then any) in every `ci` job. Only the `static` job on `main` saves (the first
  push of each day per lockfile; later saves find the key taken and only warn), right after
  `pnpm build`, and on `main` it builds without restoring: an entry holds one commit's
  build output (no unbounded growth, no typecheck/lint/test results reused across runs), and PR
  and merge-queue runs read it without spending the cache quota that publish.yml's image layer
  cache shares. `TURBO_CACHE_DIR=.turbo/cache` is set in `ci.yml` (Turbo 2.11 uses the main
  worktree's cache inside git worktrees, so the default is not obvious).
- **Guide output declared.** `@kobe/guide`'s build writes `src/generated/pages.ts` outside `dist/`;
  a cache hit would have restored `dist/` only. `packages/guide/turbo.json` now lists
  `src/generated/**` as an output (checked locally: deleting `dist/` and `src/generated/` and
  rebuilding replays both from the cache).
- **`unit` still runs `pnpm build`** before the tests: `test-identities.sh` and the real-Pi /
  chart render tests read a package's own `dist/`, and `turbo run test` builds only `^build`.
- **Composite actions** (`.github/actions/`): `setup-kobe` (pnpm, Node from `.nvmrc` with the store
  cache, `pnpm install`, Turbo restore; inputs for Node-only, no cache, no install) and
  `pg17-client`. They replace the setup steps in ci.yml (3 jobs), e2e.yml (restore/browser
  shards), sandbox-, orbit-eval-, skill-scan-image and security-audit. Pins stay full SHAs;
  Dependabot's github-actions entry now also scans `/.github/actions/*`; the path-filtered
  workflows also trigger on `.github/actions/setup-kobe/**`.
- Unit concurrency (`--concurrency=2 -- --maxWorkers=3`) unchanged: one change at a time.

## Docs

No `docs/guide/` change: CI is invisible to members, admins and agents. `docs/development.md`
(CI section) describes the new job layout and the cache.

## Evidence

- ac-1: job ids/names `checks` and `db` kept; `actionlint` 1.7.12 clean on all workflows
  (it also checks `with:` keys against the local composite actions). Merge queue: watch the first
  queue run (below).
- ac-3: `grep -rn "pnpm/action-setup\|actions/setup-node\|postgresql-client-17" .github` matches
  only `.github/actions/`.
- ac-2, before (six recent successful `ci` runs, 2026-11-21, hosted runners): `checks` 12.3,
  12.5, 12.7, 12.7, 17.2, 19.4 min (steps: format 0.8, build 1, typecheck 0.8, lint 0.4,
  test 8, identities 0.6 min); `db-core` 4.3-5.1; `db-server` 6.2-9.5 per shard. After: to be
  recorded by the coordinator from the first three runs (expected `checks` wall time about
  `unit` ≈ 9-10 min, `static` ≈ 3-4 min).

## For the coordinator: watch on the first CI runs

1. The branch push: `static`, `unit`, `checks` all appear; `checks` goes green only after both.
2. Restore steps log a cache miss until a run on `main` has saved `turbo-Linux-…`; after the
   merge, the `main` run's `static` job must show the cache saved. Then a PR run's `pnpm build`
   should report `cached` tasks (`Cached: N cached`).
3. The first merge-queue run reports `checks` and `db` (ruleset still satisfied).
4. e2e `restore` shard (CLI + PG 17 client via composite actions) and `gate3`/`gate5`/`gate7`/
   `gate-apps` (Node only) still pass.
5. Later `main` runs the same day: the save step warns that the key exists (expected, not a
   failure). Cache usage (Settings → Actions → Caches): about one `turbo-*` entry a day; unused
   entries expire after 7 days. Confirm they don't crowd out the `type=gha` image layer cache.
