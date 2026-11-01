# Run ledger

Working state for agents building Kobe. Update before clearing context; read on resume (then run
Hadron ignite and re-read the current ticket).

## Current

Index only: the coordinator edits this file; each ticket keeps notes in `docs/ledger/KOBE-<N>.md`.
Parallel-work rules: [parallel-work.md](parallel-work.md); handoff: [agent-prompt.md](agent-prompt.md);
Hadron via `scripts/hadron.sh`.

- **Thread lineage and folders lane (2026-11-01, spec by Chris's decisions of 2026-10-31):**
  `docs/specs/thread-lineage-and-folders.md` (Hadron spec 71dcf77b): a lineage strip at the top of the
  conversation column replaces the "Forked from" note (root first, one linked row per generation, dropdowns
  for siblings and forks; `GET /v1/threads/{id}/lineage`, readable threads only), and team-visible thread
  folders (3 levels, 500 per team, `thread_folders` + `threads.folder_id`, filing by owner or D23 reader,
  audited) with a two-rail Threads panel (Current with Archived folded under it, folders, Deleted). Tickets
  KOBE-532 (protocol) → 533/534 → 535/536 → 537 (browser specs); lane brief with the kickoff prompt in
  `docs/ledger/thread-lineage-folders-lane.md`. Nothing started yet.
- **App placement lane (2026-10-31, Chris: a site admin decides where an MCP app opens):** KOBE-531 filed
  and merged as PR #431 (main 114565d7). Per pinned template, `connector_ui_resources.placement` is `chat`
  (the card, default), `artifacts` (the card is the "Opened in the side column" stub and the app opens in the
  artifact column by itself, live and on reopen, newest 3 placed cards) or `rail` (the Pickers section; the
  KOBE-460 "Picker" name rule is gone, picker-named templates were migrated). Set in the site console's
  template review (`PUT /v1/site/connectors/:id/templates/placement`, audited
  `mcp.connector.template_placement_set`); admin-fixed: `ui/request-display-mode` never moves a frame. Spec
  MA3 amended. Deployed to kobe-gate1 as `local-114565d7ceb5` (rollback `local-2e086c5496b2`;
  `local-b06345530688` pruned), reconcile failed:0; gate1 rows read Lakehouse Picker and Workspace Picker
  `rail`, the rest `chat`; `e2e/browser/tests/app-placement.spec.ts` passed against gate1 (Lake Query set to
  `artifacts`, rail launch opened the artifact tab, card showed the stub, placement reset). One merge-queue
  rerun: the e2e suite's Bifrost restart check saw two exits from one upstream pricing outage (HTTP 503);
  PR #432 lets the check tolerate up to three such exits.
- **Hardening lane 4 deployed (2026-10-30):** PR #428 merged (main 2e086c54; one CI rerun: the gate4 U7 scan's
  `sk-…` shape matched a substring of a Kobe session token, fixed in #429 with a boundary and `grep -P`).
  Deployed to kobe-gate1 as `local-2e086c5496b2` (rollback `local-b06345530688`; `local-533a9dfbc944` pruned),
  all deployments on the tag, reconcile failed:0, one expected warning (SMTP security none). Baseline filled from
  gate1: app calls are 0.98 upstream on the proxy and ~130 ms Kobe at p95 (527), probes 0.98 upstream with 26 ms
  Kobe (528), writes 55–75 % object store with Kobe ≤ 100 ms p95 (529), a fresh web pod's first page is 899 ms
  server time of which 467 ms the first branding fetch, then 13–20 ms (530). Verdicts: app calls, probe and
  connector calls leave the 300 ms route budget with their Kobe side held to it; write routes get the proposed
  Kobe-side 300 / whole-request 600 ms budget pending Chris. Open for Chris: the owner's runs in Team1 get no
  Catalyst tools (`enabled_tools: []`), so connector `tools/call` has no post-deploy sample; probe cadence 6/h
  from two replicas is a follow-up candidate.
- **Hardening lane 4 (2026-10-30, Chris: "work all the hardening tickets and add tests for each; deploy to
  production when done"):** group branch `group-hardening-4` (worktree `../Kobe-g-hardening-4`), one PR;
  the five hardening-labelled backlog tickets, three of them in parallel per-ticket worktrees merged into
  the group branch. KOBE-520 (63450b5b): premise false, the MCP proxy never held the approval key (the
  server signs and verifies on the policy re-check); tests pin it, no signing change. KOBE-529 (681fbcda):
  `workspace.*` child spans split S3 from Postgres in the three write routes, query 7/7b, write-route budget
  proposal for Chris. KOBE-527/528 (09c5a07b): `app_call.*` spans on the server, `mcp.upstream` client span
  on the proxy, queries 8/9/9b/9c (renumbered at the merge); probe cadence on gate1 is 6/h because both
  server replicas refresh every connector hourly (left as a follow-up candidate). KOBE-530: see its ledger.
  The ac-2 numbers of 527/528/529 come from ClickHouse after the deploy and are filled into
  docs/perf-baseline-2026-10-30.md. "Production" = kobe-gate1, the only install.
- **Hardening lane 3 deployed (2026-10-30):** PR #425 merged (main b0634553; CI needed two fixture fixes
  for the Pi 1.0 cut, the gate1 e2e shard's scripted agent said 1.0.0 too, and one flaky db-server rerun).
  Deployed to kobe-gate1 as `local-b06345530688` (rollback `local-533a9dfbc944`; `local-a188832871f4`
  pruned), Helm rev 105: gateway and server rolled together, no token refusals, team reconcile failed:0,
  Secret carries `trace-span`; live owner run with a bash tool call completed. Browser specs
  `file-tab-outside-change` (incl. KOBE-516's agent `mv`) pass on gate1 once they open the row by path
  (#426: the owner's workspace root has its own notes.md). KOBE-525 baseline measured
  (docs/perf-baseline-2026-10-30.md: 315 page loads over 81 routes, ClickHouse queries 1–6; attributes
  live in `metadata_names`/`metadata_values`, fixed in the queries) and follow-ups KOBE-527..530 filed.
  compute2 disk hit 86% after the build (kubelet GC threshold): docker build cache (44 GB) pruned → 44%,
  so the next image build is a full rebuild.
- **Hardening lane 3 + gate1 deploy (2026-10-30):** group 2 merged (#408 → main 533a9dfb; the gate2/gate4
  secret scan had to skip the session keys' public halves and PEM armour lines). main 533a9dfb deployed to
  kobe-gate1 as `local-533a9dfbc944` (rollback tag `local-a188832871f4`; `local-87398452b50d` and the orphan
  sandbox tag removed): PDBs on server and model-gateway, both spread over two nodes; Secret holds
  `<aud>.key/.pub`, ConfigMap `kobe-sandbox-session-verify-keys` has the four public keys; warm pools
  recycled onto the Pi 1.4.0 sandbox image; a live owner run in Team1 (bash tool call via the gateway)
  completed with no token refusals and no 1.0.x hello warning. Note: the generated Secret still carries the
  old per-audience HMAC entries (unused). Lane 3 on `group-hardening-3` (Chris: one at a time, then deploy
  for the next gate review): KOBE-522 → 521 → 519 → 518 → 516 → 525 (perf baseline, filed 2026-10-30).
  Also filed: KOBE-526 multi-client readiness (future; no API gateway, Chris 2026-10-30).
  Lane 3 done (all six on `group-hardening-3`, one PR): 522 sandbox agent re-trades its grant on a wire
  401/4001, rate-limited (Opus review: detection is wire-only); 521 run and server-call tokens signed with the
  server's Ed25519 `model-gateway` pair, the gateway holds public keys plus the pseudonymising trace-span key
  only (upgrade: gateway and server roll together; Secrets restored from pre-521 backups need a `trace-span`
  entry); 519 undici 8.12.2 override in the sandbox Pi install; 518 Pi 1.0.x hellos refused
  (`PI_PREVIOUS_MINORS` empty; the fake sandboxes greet with the pinned version now, 15 DB suites had said
  1.0.0); 516 `workspace_files.moved_to` (migration 0183), the agent's `mv` paired inside one sandbox commit,
  open tabs follow a move from the change stream for every mover and the KOBE-506 client tracking is gone;
  525 latency spans (run first token / Pi ready / tool round trip, sandbox wake/claim/hello, gateway and
  egress `http.route`), `POST /v1/telemetry/web-vitals` fed by Next's `useReportWebVitals`, an on-demand
  Playwright measurement run (`e2e/browser` `perf:measure`) and `docs/perf-baseline-2026-10-30.md` whose
  gate1 tables are filled after the deploy (`docs/perf/latency-queries.sql`; query 0 checks the ClickHouse
  column names first).
- **Hardening lane 2 (2026-10-29):** `group-hardening-2`: KOBE-511 Pi 1.0.0 → 1.4.0 (extension-API pin test;
  server admits 1.0.x with a warning until KOBE-518; undici → KOBE-519) and KOBE-513 Ed25519 session tokens
  (per-audience key pairs, public keys in a ConfigMap, kid + rotation window; server reads its bundle from
  the Secret; upgrade with no runs active until KOBE-522 lets the sandbox agent re-trade on a 401). Opus
  security reviews on both. KOBE-520 withdrawn (the MCP proxy never held an approval key); KOBE-521 filed.
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
