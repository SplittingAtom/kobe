# Run ledger

Working state for agents building Kobe. Update before clearing context; read on resume (then run
Hadron ignite and re-read the current ticket).

## Current

- **Run:** Chris (2026-10-01): "start KOBE-6 and keep going until all tickets that depend on KOBE-5
  and KOBE-8 are done" → KOBE-6, KOBE-68, KOBE-21, KOBE-7, KOBE-12, KOBE-14, KOBE-29, KOBE-69. Each:
  tests first → CI green → review → merge → complete in Hadron → transition to done.
- **Done in this run:** KOBE-6 (PR #3), KOBE-68 (#4), KOBE-21 (#5), KOBE-7 (#6).
- **In progress:** KOBE-12 (worktree `../Kobe-wt12`, branch kobe-12-better-auth, PR #8, security
  review running). Next: KOBE-14, KOBE-29, KOBE-69.

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
