# KOBE-375: Third-party license inventory and NOTICE for Apache-2.0 compliance

- **Status:** in progress (group branch `group-2-quality`, no PR yet)
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2`
- **Depends on:** none

## Plan

1. Exceptions record `approvedBy`/`approvedOn`; the checker fails without them (ac-4).
2. `tools/license-check` inventory step: generated tables from pnpm-lock.yaml + `pnpm licenses
list`, the committed image reports and `e2e/browser/package-lock.json`; hand rows from
   `tools/license-check/inventory.yaml`; renders `THIRD_PARTY_LICENSES.md` and `NOTICE` (ac-1..3, 5).
3. Images ship LICENSE, NOTICE, THIRD_PARTY_LICENSES.md under `/usr/share/doc/kobe/` (ac-3).
4. Docs: `docs/licensing.md` (policy), CLAUDE.md, `docs/agent-prompt.md` (ac-6).

## Decisions

- File names per Chris: `THIRD_PARTY_LICENSES.md` at the root; `docs/licensing.md` stays the policy.
- caniuse-lite 1.0.30001814 and argparse 2.0.1: approved by Chris 2026-10-17 (brief).
- Orbit eval exceptions: their reasons already said "Approved by Chris 2026-10-04 (KOBE-92)";
  moved into `approvedBy`/`approvedOn`.
- The whole Markdown file is generated (the hand sections come from inventory.yaml), so the drift
  check is one byte comparison. Generated files are in `.prettierignore`.
- npm package set from the lockfile graph, not node_modules: identical on macOS and Linux.
  Platform builds (esbuild, SWC, rolldown, lightningcss, ...) take their family's license from
  inventory.yaml (checked against the report where installed). Peers are not followed in
  production closures (better-auth's optional `vitest` peer is not shipped). khroma's
  store-dependent license (`Unknown` on a fresh store) is pinned with `licenseOverrides`.
- Image reports need a built image, so they are committed (`images/*/third-party-licenses.json`,
  sorted collect-licenses output, now with ecosystem, locations and NOTICE text); the image
  workflows compare them with the built image and upload the fresh report on a mismatch. The
  `checks` job only renders from them (no Docker).
- Coverage: every Dockerfile FROM and literal image in charts/, dev/, ci/, workflows and scripts
  needs a row (`images:`); every top-level key of charts/kobe/values.yaml needs a `chartValues`
  class (first-party / site-provided / row ids).
- `yaml` (ISC, already in the workspace) added to @kobe/license-check; no new third-party package.

## Open questions (for Chris or the coordinator)

- None open. Chris approved every item outside the family on 2026-10-17 (recorded with approver
  and date). kobe-runas now links musl (MIT) instead of glibc.
- Policy (Chris, 2026-10-17): license decisions never block a push. Rows and exceptions can be
  `pending: gate review` (a warning and the "Pending gate review" list at the top of
  THIRD_PARTY_LICENSES.md); `pnpm license:gate` fails while anything is pending and is run by
  gate tickets.
- For the security review: musl in a static binary does not scrub the environment in
  secure-execution mode the way glibc did (for example TMPDIR, LD_*). kobe-runas has no dynamic
  loader, its only caller is the agent, it drops to a less privileged uid, and the agent passes
  an allow-listed environment and sets TMPDIR itself, so nothing new can reach it. The CI
  real-helper test (`test-identities.sh`) still builds with the host's gcc/glibc.

## Evidence (acceptance criteria → test or command output)

- Pi 1.0.0: MIT (one root LICENSE at tag v1.0.0; npm package MIT). agent-sandbox v1.0.4:
  Apache-2.0 (single LICENSE, no NOTICE).
- Fresh Linux store (node:24-bookworm, `git archive HEAD`, `pnpm install --frozen-lockfile`):
  `inventory-cli.js check` reports no stale file, i.e. the same output as macOS.
- Sandbox and Orbit eval images built from this branch (amd64): test-image.sh green,
  `image-report --check` matches the committed reports, `assert-image-licenses.sh` ok.
- Coverage negative test: a chart `redis` image + key and a distroless FROM each fail the check.
- `pnpm format:check`, `lint`, `typecheck`, `@kobe/license-check test` (77 tests) green;
  `pnpm license:check` and `pnpm license:gate` pass (0 pending). Pending path tested: a row marked
  pending warns (`::warning` annotation with GITHUB_ACTIONS=true) and passes; license:gate fails.
- musl kobe-runas: sandbox image rebuilt; test-image.sh 73/73 ok (all kobe-runas identity
  checks); `file`: static-pie; no glibc strings; the link uses only musl's rcrt1/crti/libc.a/crtn
  (`-Wl,--trace`). Image licence check in gate mode passes, the report matches, and the license
  files match.
