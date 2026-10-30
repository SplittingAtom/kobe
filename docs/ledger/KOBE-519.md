# KOBE-519: Override undici to >= 8.12.2 inside the sandbox Pi install

- **Status:** in review (group branch `group-hardening-3`, one PR for the group)
- **Branch / worktree:** `group-hardening-3` in `../Kobe-g-hardening-3`
- **Depends on:** KOBE-511 (Pi 1.4.0, merged in #408)

## Plan

Pi 1.4.0 pins `undici` 8.10.2 (its outbound fetch). npm audit reports undici 8.0.0 - 8.12.1 as
high: GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c, GHSA-4w7w-5xrc-9h26,
GHSA-2m5v-pch6-74hx, GHSA-qrxm-fqhp-jwvm, GHSA-9fm3-97px-rjf6, GHSA-55wc-3pg8-jfw6 (and Pi itself
moderate through it). Add an npm `overrides` entry in `images/sandbox/pi/package.json` and
regenerate the lockfile with npm 12.2.1 (the Dockerfile's `NPM_VERSION`).

## Decisions

- Override pinned exactly to `8.12.2`, the lowest release that clears the advisories (same
  "pin the full tree" rule as the rest of the file); a later undici fix bumps it explicitly.
  Its peers are satisfied (openai's optional `undici >=5 <9`), engines unchanged (node >= 22.19).
- Lockfile diff: only the `node_modules/undici` entry (version, resolved, integrity).
- `test-image.sh` gains a check that Pi's undici is >= 8.12.2, so a Pi bump cannot silently
  bring the old pin back.
- Licence unchanged (MIT); `third-party-licenses.json` and `THIRD_PARTY_LICENSES.md` refreshed
  (one version line each).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1 audit: `npm audit --omit=dev` in `images/sandbox/pi` before: 2 vulnerabilities (1 moderate,
  1 high, undici); after: found 0 vulnerabilities.
- ac-1 real-Pi suites: `pnpm --filter @kobe/sandbox-agent test` with the pinned Pi installed
  (`npm ci --prefix images/sandbox/pi`): 138 files passed, 5 skipped; 1159 tests passed, 56 skipped.
  The skipped ones are the `KOBE_TEST_PI_RUNAS` suites (identities, identities.partner, exec.real,
  exec.load-paths, projects.readonly, redirect "KOBE-167"); they need
  `scripts/test-identities.sh` (sudo, setcap, test groups on the host) and run in CI.
- ac-1 image: built on the remote engine; `test-image.sh`: 78 ok, 0 failed, including
  "pi's undici is >= 8.12.2"; `npm ls undici` in `/opt/pi`: `undici@8.12.2 overridden`.
- `pnpm license:check` and `pnpm verify`: green.
