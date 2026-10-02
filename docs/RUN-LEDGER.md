# Run ledger

Working state for agents building Kobe. Update before clearing context; read on resume (then run
Hadron ignite and re-read the current ticket).

## Current

- **Ticket:** none claimed. KOBE-5 is `in_review` (PR #1, commit f1e7faf); awaiting Chris.
- **Phase:** 1 (Spine). Phase 1 tickets promoted to `ready` 2026-10-01 with Chris's sign-off.

## Done

- 2026-10-01: repo `SplittingAtom/kobe` created (private).
- 2026-10-01: Chris's k3s cluster prepared — gVisor on all 4 nodes (RuntimeClass `gvisor`, handler
  `runsc`), agent-sandbox v1.0.4 (API `v1beta1`). Details in Hadron memory.
- KOBE-5: pnpm 12 + turborepo monorepo; TS 6 strict, ESLint 10 flat config, Prettier, Vitest 5;
  Apache-2.0 LICENSE + NOTICE; README quickstart; multi-stage non-root (uid 1000) Dockerfiles for web,
  server, sandbox-agent, mcp-proxy, egress-proxy; license policy check; unit CI workflow.
  Code review: 1 HIGH + 6 MEDIUM fixed. CI green (run 36951986926). Completed in Hadron → in_review.

## Next

1. KOBE-6 — Helm umbrella chart with isolation preflight (needs local `kubectl`/`helm`, or run via
   ssh on compute1; needs a ghcr.io pull secret on the cluster).
2. KOBE-8 — Database layer (can start in parallel with KOBE-6; depends only on KOBE-5).

## Open problems / decisions

- Dev loop targets Chris's k3s via Tilt; k3d only in GitHub Actions CI (Chris, 2026-10-01).
- No local Docker engine on the dev Mac: build images with
  `DOCKER_HOST=ssh://claude@compute2.atom.splittingatom.io` (amd64, matches the cluster).
- TypeScript pinned to 6.0 because typescript-eslint does not yet support TS 7.
- License exception: `caniuse-lite` (CC-BY-4.0, data) — **needs Chris's sign-off**. `sharp` excluded
  (LGPL libvips).
- Deferred from review: pin base images by digest (do with Renovate/Dependabot, before images ship).
- Branching: tickets build on stacked branches until PR #1 merges to main.
