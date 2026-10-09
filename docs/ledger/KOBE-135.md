# KOBE-135: Flaky egress-proxy upgrade test (hang expects 504, gets 502)

- **Status:** in review
- **Branch / worktree:** `kobe-135-egress-upgrade-504-flake` in `../Kobe-wt135`
- **Depends on:** none

## Decisions

- Root cause: `exchange()` in `services/egress-proxy/src/upgrade.ts` armed two timers for the same
  instant: its own `overall` (-> `upstream_timeout`, 504) and the `TunnelRegistry` entry registered
  with `Math.min(identity.expiresAt, deadline)` (-> `close()` -> `fail("not_enabled")`, 502).
  Node orders same-ms timers by duration list/insertion, so under load the registry timer could win.
- Fix: register the tunnel with `identity.expiresAt` only; the request deadline belongs to `overall`.

## Evidence

- ac-1: new test "leaves the request deadline to the upgrade timer, not the tunnel registry"
  (fake registry whose timer wins) fails 502 before the fix, passes after. 20 consecutive runs of upgrade.test.ts under 4 CPU hogs: 20/20 passed.
