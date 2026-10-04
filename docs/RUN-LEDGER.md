# Run ledger

Working state for agents building Kobe. Update before clearing context; read on resume (then run
Hadron ignite and re-read the current ticket).

## Current

Index only: the coordinator edits this file; each ticket keeps notes in `docs/ledger/KOBE-<N>.md`.
Parallel-work rules: [parallel-work.md](parallel-work.md); handoff: [agent-prompt.md](agent-prompt.md);
Hadron via `scripts/hadron.sh`.

- **Run (2026-10-04):** Chris: finish open work (wave A), then Agents, Skills, Gallery & Orbit
  (wave B), small tickets and small contexts to save tokens.
- **Wave A, done:** #64 (token workflow), #30/#31 (deps), KOBE-43 (#56), KOBE-71 (#62), KOBE-42
  (#61), KOBE-39 (#60), web restyle on assistant-ui (#65). Test install upgraded to `main` a63e726.
- **Wave B:** KOBE-47..52 split into KOBE-75..94 (label `wave-b`; `migration` label = one at a
  time; parents close when children are done). Batch 1 in progress: KOBE-75, 79, 90. Then
  78 (+76, 84) → 86 (+77, 83) → 80 (+91, 92) → 81 → 85 (+82) → 87 (+88) → 93 (+89) → 94.
- **Decisions (2026-10-04):** resolver's user-connected connectors are empty until KOBE-61;
  KOBE-89 ships the Document Drafter without artifact output until KOBE-55.
- **Follow-ups filed:** KOBE-95 (budget reservations across gateway replicas), KOBE-96 (flaky
  chart `models.test.ts`). Accepted LOWs on KOBE-39: echoing upstreams can reveal injected headers
  (documented); egress token visible in `env` output.

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
  `DOCKER_HOST` pointing at the remote Docker host (see `CLAUDE.local.md`).
- TypeScript pinned to 6.0 because typescript-eslint does not yet support TS 7.
- License exception: `caniuse-lite` (CC-BY-4.0, data) — **needs Chris's sign-off**. `sharp` excluded
  (LGPL libvips).
- Deferred from review: pin base images by digest (do with Renovate/Dependabot, before images ship).
- Branching: tickets build on stacked branches until PR #1 merges to main (PR #2 → retarget to
  main after #1 merges).
- Dev Postgres: a test-only container on the remote Docker host (URL in `CLAUDE.local.md`).
- Ask Chris: make CI `checks`, `db`, `images` required status checks on `main`.
- Tools: helm/kubectl/k3d binaries live in the session scratchpad `bin/` (not installed globally);
  CI installs helm via azure/setup-helm. k3d test cluster `kobe` runs on the remote Docker host;
  CI runs on self-hosted runners (`ci/runners/`).
- Pending Chris sign-off: license exceptions caniuse-lite (CC-BY-4.0) and argparse (Python-2.0).
