# KOBE-96: Flaky chart test: charts/kobe tests/models.test.ts

- **Status:** in review
- **Branch / worktree:** `kobe-96-chart-models-flake` in `../Kobe-wt96`
- **Depends on:** none

## Plan

Find why `models.test.ts` failed once with `TypeError: Cannot convert undefined or null to object`.

## Decisions

- Root cause: the stack (run 37204790183, attempt 1) is `z.enum(undefined)` inside `@kobe/db`'s `dist`
  (`audit/events`). `@kobe/chart` declared no workspace dependencies, yet its tests import
  `services/*/src/config.ts`, which resolve `@kobe/db` and others to `dist`. Turbo's `^build` therefore
  never built them first: the chart test raced the `tsc` emit of `@kobe/db` (and read a half-written or
  stale `dist`). Local clean checkout shows the same gap: "Failed to resolve entry for package @kobe/db".
- Fix: `@kobe/chart` devDepends on `@kobe/{egress-proxy,mcp-proxy,model-gateway,server}` (workspace),
  so `^build` builds them and their dependencies before `vitest run`.

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: after `git clean` of dist, `turbo test --filter=@kobe/chart` builds 10 deps then passes (121 tests);
  20 consecutive `vitest run` in `charts/kobe` all passed.
