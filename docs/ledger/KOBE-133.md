# KOBE-133: Flaky test: identities.real.test.ts times out at 5 s (owner-only dir reclaim)

- **Status:** in review
- **Branch / worktree:** `kobe-133-identities-test-timeout` in `../Kobe-wt133`

## Decisions

- The test spawns a real Pi, waits for the 200 ms idle reap, then the reclaim walks a 000-mode tree;
  that cost is inherent to the real helper, so no fixture shortcut. Added a 30 s per-test timeout
  (the `until` waits inside allow 15 s; the retire test already uses 60 s).

## Open questions

- Test is Linux/root only (sudo, setcap); not runnable on the dev Mac. The 10-run criterion
  needs CI reruns.

## Evidence

- Acceptance: timeout in `services/sandbox-agent/src/identities.real.test.ts`; CI job "Sandbox privilege separation (real helper)".
