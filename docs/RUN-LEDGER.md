# Run ledger

Working state for agents building Kobe. Update before clearing context; read on resume (then run
Hadron ignite and re-read the current ticket).

## Current

Index only: the coordinator edits this file; each ticket keeps notes in `docs/ledger/KOBE-<N>.md`.
Parallel-work rules: [parallel-work.md](parallel-work.md).

- **Run:** Chris (2026-10-02): "do the setup ticket and start wave 0". Parallel agents, one worktree
  per ticket, coordinator merges one PR at a time.
- **Merged this run:** setup (#9), KOBE-9 (#10), KOBE-29 (#11), KOBE-14 (#12), contracts (#13),
  KOBE-11 (#14). Wave 0 complete.
- **Wave 1 in progress:** KOBE-33 (#15, rebasing), KOBE-13, 22, 23, 31, 34, 35, 45 (worktrees
  `../Kobe-wt<N>`).
- **Next:** KOBE-15, 20 as slots free; then KOBE-24 (after 23), 25, 30, 36, 38.
- **Questions for Chris:** text deltas carry `message_id` (not `entry_id`); Stop emits
  `run.interrupted{reason:"cancelled"}`; sandbox-scoped tools skip the risk prompt in
  ask-on-write; queued messages start after Stop.
- **Binding requirements carried forward:** KOBE-22/30/64 take `VerifiedIsolation` from
  `require()` right before creating sandboxes (docs/ledger/KOBE-9.md); KOBE-23/24 add a durable
  per-run sandbox seq cursor; KOBE-26 adds `runs.retry_of_run_id`; KOBE-30/31 follow the
  thread-before-run lock order and batch deltas (docs/ledger/KOBE-29.md).
- **Hadron:** not reachable from the coordinator session (MCP configured elsewhere); sync ticket
  status after merges.
- **Wave 1 (next, as deps merge):** 15, 20, 22, 23, 31, 33, 34, 35, 45.
- **Earlier run:** KOBE-6 (PR #3), KOBE-68 (#4), KOBE-21 (#5), KOBE-7 (#6), KOBE-12 (#8) merged.
  KOBE-69 was listed for that run but is not in the implementation prompt: check Hadron.

## Done

- 2026-10-01: repo `SplittingAtom/kobe` created (private).
- 2026-10-01: Chris's k3s cluster prepared — gVisor on all 4 nodes (RuntimeClass `gvisor`, handler
  `runsc`), agent-sandbox v1.0.4 (API `v1beta1`). Details in Hadron memory.
- KOBE-5: pnpm 12 + turborepo monorepo; TS 6 strict, ESLint 10 flat config, Prettier, Vitest 5;
  Apache-2.0 LICENSE + NOTICE; README quickstart; multi-stage non-root (uid 1000) Dockerfiles for web,
  server, sandbox-agent, mcp-proxy, egress-proxy; license policy check; unit CI workflow.
  Code review: 1 HIGH + 6 MEDIUM fixed. CI green (run 36951986926). Completed in Hadron → in_review.

- KOBE-8: packages/db — withTeam, FORCE RLS on team tables with canonical NULLIF policy, tenancy
  registry + grants matrix, kobe-migrate runner, strict RLS catalog check + cross-team probe suite
  in a CI Postgres 17 job (28 tests). DB review: 1 CRITICAL + 4 HIGH fixed. CI run 36953369115.

- KOBE-6 (PR #3, merged, done): chart + isolation (Helm lookup, hook Job, server/scheduler
  initContainer), CNPG/external Postgres, NetworkPolicies, scripts. Security review: 2 HIGH fixed.
- Decision (Chris): no bundled S3 (MinIO archived/AGPL); external S3 only.

- KOBE-68: migration Job (pre-install/pre-upgrade hook; CNPG first install = ordinary Job), pods
  wait on drizzle.kobe_grants_applied; review: 1 HIGH fixed.
- KOBE-21: sandbox image (digest-pinned, Pi lockfile, hashed pip lock, setuid stripped), license
  audit, Trivy gate; review: 7 MEDIUM fixed.
- KOBE-12 (PR #8, merged): Better Auth accounts, passkeys, TOTP, first-run Owner; security review
  fixes in 68d5997.
- Parallel setup (PR pending): tenancy registry split per spec area, `db:rebase` migration script,
  union merge on barrels, per-ticket ledgers, `KOBE_DEV_NAMESPACE`/`KOBE_DEV_WEB_PORT` for Tilt.
- KOBE-7: Tilt dev loop (kobe-dev namespace, context-pinned), e2e/run.sh (20 checks incl. agent-sandbox
  Sandbox under gVisor), e2e/publish workflows; review: 4 HIGH fixed.

## Next

1. KOBE-68 → KOBE-7 (CI e2e on k3d, ghcr publish) → KOBE-21 → KOBE-12 → KOBE-14 → KOBE-29 → KOBE-69.
2. Install on Chris's k3s needs images on ghcr (KOBE-7) and a `read:packages` pull secret.

## Open problems / decisions

- Dev loop targets Chris's k3s via Tilt; k3d only in GitHub Actions CI (Chris, 2026-10-01).
- No local Docker engine on the dev Mac: build images with
  `DOCKER_HOST=ssh://claude@compute2.atom.splittingatom.io` (amd64, matches the cluster).
- TypeScript pinned to 6.0 because typescript-eslint does not yet support TS 7.
- License exception: `caniuse-lite` (CC-BY-4.0, data) — **needs Chris's sign-off**. `sharp` excluded
  (LGPL libvips).
- Deferred from review: pin base images by digest (do with Renovate/Dependabot, before images ship).
- Branching: tickets build on stacked branches until PR #1 merges to main (PR #2 → retarget to
  main after #1 merges).
- Dev Postgres: container `kobe-dev-pg` on compute2, port 15432 (test-only credentials).
- Ask Chris: make CI `checks`, `db`, `images` required status checks on `main`.
- Tools: helm/kubectl/k3d binaries live in the session scratchpad `bin/` (not installed globally);
  CI installs helm via azure/setup-helm. k3d test cluster `kobe` runs on compute2's Docker
  (`DOCKER_HOST=ssh://claude@compute2...`); compute2 inotify limit 128 → single-node k3d only.
- Pending Chris sign-off: license exceptions caniuse-lite (CC-BY-4.0) and argparse (Python-2.0).
