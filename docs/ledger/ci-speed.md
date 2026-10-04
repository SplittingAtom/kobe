# ci-speed: split the k3d e2e check into parallel shards

- **Status:** in review
- **Branch / worktree:** `ci-speed-e2e-split` in `../Kobe-wt-ci-speed`
- **Depends on:** nothing (no Hadron ticket)

## Plan

1. Measure where the `k3d` job's time goes (recent successful runs).
2. Build the six images once (one job each, layers from the GitHub Actions cache) and share them
   as artifacts; run the suite as parallel shards, each on its own k3d cluster.
3. Keep the required check `k3d` as an aggregating job; keep triggers, draft skip, concurrency,
   nightly.
4. Cheap wins: drop the disk clean-up, Docker Hub mirror, retries on downloads.
5. Fix the flaky `console-shell.test.tsx` test ("shows the checking state again…").

## Baseline (before)

Successful e2e runs, step durations from `gh run view --json jobs` and section times from the log
timestamps (run 37173405729, merge queue, 25 min end to end; 37172073813, 37165488192 and
37157177167 alike at 21–25 min):

| Step                                                    | Time      |
| ------------------------------------------------------- | --------- |
| Free runner disk (`rm -rf` toolchains, `docker prune`)  | 67–137 s  |
| Create k3d cluster, gVisor, agent-sandbox               | 57–65 s   |
| Build 6 images sequentially, import, prune              | 261–306 s |
| — of which `docker rmi` + `builder prune` afterwards    | ~80 s     |
| `e2e/run.sh`                                            | 568–712 s |
| — deploy (deps + chart)                                 | 55 s      |
| — checks (incl. agent-sandbox Sandbox)                  | 51 s      |
| — sandbox provider (KOBE-22)                            | 49 s      |
| — sandbox wire (KOBE-24)                                | 28 s      |
| — hibernate and wake (KOBE-25)                          | 298 s     |
| —— of which cold-start trials (20 back-to-back, 5×30 s) | 287 s     |
| — workspace sync … MCP proxy (KOBE-27…58)               | ~230 s    |
| `e2e/gate1.sh`                                          | 276–350 s |
| — fixtures (incl. recreating the fake model provider)   | 57 s      |
| — chat, stream + refresh, probe, kill + Retry           | ~95 s     |
| — cold start, 20 trials                                 | 175–198 s |

The runners are GitHub-hosted (`vars.KOBE_RUNNER` is unset); the root disk is 145 GB with ~70 GB
free before any clean-up, so the clean-up step bought nothing.

## Design

- **`images` (matrix, 6 jobs):** `docker/build-push-action` with `cache-from: type=gha,scope=<name>`
  — the scopes `publish.yml` writes on every push to main (read-only here, so PR runs don't churn
  the 10 GB cache quota) — exported as a docker archive (`outputs: type=docker,dest=…`) and uploaded
  unzipped (`archive: false`, retention 1 day). BuildKit pulls base images through `mirror.gcr.io`.
- **`e2e` (matrix, 3 shards, `fail-fast: false`):** fresh k3d cluster each, images imported straight
  from the archives into the node (`KOBE_IMAGE_ARCHIVES` in `e2e/load-images.sh`; no host `docker
load`, no prune), then:
  - `suite`: `KOBE_E2E_SHARD=suite e2e/run.sh` — every section except the KOBE-25 cold-start trials.
  - `cold-start`: `KOBE_E2E_SHARD=cold-start e2e/run.sh` — sections up to and including KOBE-25,
    with its trials, then exits.
  - `gate1`: `KOBE_E2E_SHARD=gate1-prep e2e/run.sh && e2e/gate1.sh` — install + checks + the KOBE-40
    model setup (fake provider kept running for gate1), then the full Gate 1 suite (all five steps).
- **`k3d`:** `needs: [images, e2e]`, `if: !cancelled()` and not a draft PR; fails unless both
  results are `success`. Same name as the old job, so branch protection and the merge-queue
  ruleset are unchanged.
- **`e2e/run.sh` shards:** `KOBE_E2E_SHARD` (default `all` = previous behaviour). Three guards and
  two early exits; no re-indentation, so other branches' edits to the file still merge.

## Decisions

- The isolation-log check in `e2e/run.sh` became a bounded wait (see Evidence): a harness race,
  not product code; the assertion is unchanged.

- Three shards, not more: each shard repeats ~3 min of fixed cost (cluster, import, deploy, checks),
  and the three are within ~1 min of each other. More shards would multiply Docker Hub pulls and
  cluster set-up flake exposure for little gain.
- No test is weakened: every assertion runs in at least one shard. In `suite`, the KOBE-25 check
  "every hibernation and wake is audited" counts ≥ 1 (no trials ran there); the `cold-start` shard
  runs the same check with ≥ 21, exactly as before. The `cold-start` and `gate1` shards repeat the
  install checks (more coverage, not less). Gate 1 now runs on a fresh install instead of after the
  whole e2e suite; its own fixtures and the model setup are the same.
- The image cache is read-only in e2e: `publish.yml` keeps the main scopes warm; PR runs reading
  main's cache is GitHub's cache-scoping rule, so no PR can poison another's build.
- Docker Hub: GitHub-hosted runners share IPs, so anonymous pulls risk 429s with three clusters per
  run. The host daemon, the k3s nodes (`KOBE_DOCKERHUB_MIRROR=https://mirror.gcr.io`, new https form
  in `scripts/dev-cluster.sh`) and BuildKit try `mirror.gcr.io` first and fall back to Docker Hub.
  Self-hosted runners keep their own cache.
- Retries: the k3d binary, gVisor release and agent-sandbox manifest downloads use
  `curl --retry 5 --retry-all-errors` (checksums still verified).
- `ci` workflow unchanged: its jobs take 2–6 min (the `db` job's 4 min is the DB test suite
  itself), well under the new e2e wall clock, and its `images` check runs on `push`, a different
  cache scope from the PR's e2e run, so sharing builds between them would need cross-workflow
  plumbing for no wall-clock gain.
- Flaky test: the test awaited three `findBy*` queries, each polling the DOM against
  testing-library's 1 s deadline; a loaded runner (1050 ms failure) misses it. Every async source in
  that test is a promise the test controls, so it now flushes them with `act()` and asserts
  synchronously: no deadline is left to miss (rather than raising the timeout). It also asserts the
  shell asked again exactly once (`calls === 2`).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- Dispatch run 37179692107 (first version): 12.4 min end to end (images 1.7 min; shards
  suite 8.5, gate1 9.5, cold-start 10.6 min), against 21–25 min before. suite and gate1 passed;
  cold-start failed one pre-existing race (below), all of its cold-start trials passed (p95
  4969 ms back-to-back, 4234 ms spaced).
- Race found and fixed in `e2e/run.sh` checks: "server and scheduler verified the gVisor
  RuntimeClass in process" read each pod's log once, right after the install; the server's
  isolation check is asynchronous and does not gate readiness, so one replica had not logged it
  yet. It now waits up to 60 s per pod for the line (still fails if it never appears).
- PR runs: see the PR description.
- Local: build, typecheck, lint (all but the Helm 4 chart lint), format:check, license:check,
  `pnpm test --concurrency=2`, server and db `test:db`, `db:check`, public hygiene: all pass.
