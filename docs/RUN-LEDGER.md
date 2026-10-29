# Run ledger

Working state for agents building Kobe. Update before clearing context; read on resume (then run
Hadron ignite and re-read the current ticket).

## Current

Index only: the coordinator edits this file; each ticket keeps notes in `docs/ledger/KOBE-<N>.md`.
Parallel-work rules: [parallel-work.md](parallel-work.md); handoff: [agent-prompt.md](agent-prompt.md);
Hadron via `scripts/hadron.sh`.

- **Hardening lane 1 (2026-10-29):** Chris's spare-lane request after the low-priority review. On
  `group-hardening-1` (one worktree, agents sequential or path-disjoint): KOBE-506 file-viewer move race
  (real bug; agent/other-device moves → KOBE-516), KOBE-507 db-core 57P01 (drop waits for sessions; pool
  error logger), KOBE-510 chart eslint, KOBE-512 Trivy gate on service images, KOBE-515 PDB + spread,
  KOBE-517 next 16.4.3 (two RCEs), KOBE-514 slim images (server 1.2 GB → 580 MB). Reviews: Opus on 507 and
  514, code-review medium on 506, coordinator on 510/512/515/517. Next in the lane: KOBE-511 Pi upgrade,
  KOBE-513 Ed25519 tokens (own group, Opus security reviews).
- **Theming deployed for the gate (2026-10-29):** main 5cd8a91e → kobe-gate1 `local-5cd8a91ea59b`, then
  87398452 → `local-87398452b50d` (#403: default sans token back to Tailwind's stack after the console
  screenshots showed a font change in the Linux container). Follow-ups: #404 (Appearance e2e exact
  labels), #405 (server branding read fresh per request: the per-replica 10 s cache served stale values
  after a save). Gate ticket KOBE-508; evidence in docs/gates/gate-theming.md. Rollback tag on the nodes:
  `local-5cd8a91ea59b`. Deploy script: coordinator scratchpad `deploy-gate1.sh` (bash, from the GSD VM).
- **Theming wave 3 (2026-10-29):** KOBE-501 (Appearance page, ../Kobe-wt501) ∥ KOBE-503 (chart-seeded
  defaults, ../Kobe-wt503), then KOBE-502 (docs, ../Kobe-wt502) on Opus, reviewed (code-review medium on
  501: 8 fixed incl. the `POST /api/branding/refresh` route; Opus pass on 503: reset re-seeds in one
  transaction), folded into `group-theming-3`. Flaky tests seen: file-viewer rename (KOBE-506), executor
  e2e shard once. Next: deploy to kobe-gate1 for the gate review; 504/505 optional.
- **Theming wave 2 (2026-10-29):** KOBE-499 (branding API, ../Kobe-wt499) ∥ KOBE-500 (themed first
  paint, ../Kobe-wt500) on Opus, reviewed (Opus security pass on 499: 2 MEDIUM + 3 LOW fixed;
  code-review medium on 500: 7 fixed), folded into `group-theming-2`. Decisions: per-scheme derived
  accent; SVG allows `url(#id)` and only the SVG/xlink namespaces; `branding.show_name` key;
  web `KOBE_SERVER_URL` defaults to the server Service (port 80). Next: 501, then 502 ∥ 503.
- **Theming wave 1 (2026-10-29):** plan docs/specs/theming.md + docs/theming.md (PR #399 merged 2026-10-29, decisions
  TH1–TH12 by Chris 2026-10-28); tickets KOBE-497..505. KOBE-497 (schema+contract,
  ../Kobe-wt497) ∥ KOBE-498 (tokenize UI, ../Kobe-wt498) done on Opus, reviewed (Opus DB pass, code-review medium), folded into
  `group-theming-1`, one PR. Next: 499 ∥ 500, then 501, then 502 ∥ 503.
- **Run (2026-10-11):** one agent session at a time, sequentially (ticket agent, then its review);
  ticket agents on Opus 5.5 from KOBE-180 on. Waves A–E are done.
- **Wave E, done (2026-10-11):** Personal Schedules — KOBE-178 (#226), 180 (#235), 179 (#236),
  181 (#237), on top of 172–177. Next: deploy `main` 7c79940 to kobe-gate1 for performance testing.
- **Open after wave E:** KOBE-193, 229 (claimed, not started); gates G3a/G4a/G4b (KOBE-231..233 →
  KOBE-3/4); v1.1 Conversational Enhancements (KOBE-197..227, 234, none started); parents
  KOBE-53..65 need closing against their children. Follow-ups: KOBE-74, 95, 182, 240, 247, 252, 253.
- **Decisions (2026-10-04):** resolver's user-connected connectors are empty until KOBE-61;
  KOBE-89 shipped the Document Drafter without artifact output; KOBE-131 added its Markdown preview artifact.
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
