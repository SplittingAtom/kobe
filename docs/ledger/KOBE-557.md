# KOBE-557: Usage: reasoning tokens per call (reported or estimated) and thinking budgets per level

- **Status:** in progress (PR 1 migration; PR 2 feature)
- **Branch / worktree:** `kobe-557-reasoning-usage` (PR 1), `kobe-557-reasoning-usage-feature` (PR 2, stacked) in `../Kobe-wt557`
- **Depends on:** none; KOBE-556 consumes `thinkingBudget` and the per-run `reasoning_tokens` / `reasoning_estimated`

## Plan

1. PR 1, migration only: `run_usage.reasoning_tokens integer NULL`, `reasoning_estimated boolean NOT NULL DEFAULT false`
   (`0191_run_usage_reasoning`), probe fixture sets both, RLS unchanged.
2. PR 2, feature: gateway normalisers + estimate, ledger write, server per-run / team / site usage, protocol budgets, web types, design doc.

## Decisions

- No CHECK on `reasoning_tokens` in the migration: adding one validates the whole ledger under the
  table lock (0099 avoided that with NOT VALID); the gateway and `recordModelUsage` clamp to 0..output instead.
- Both ALTERs are metadata-only on Postgres 11+ (nullable column; constant default), so no rewrite.

## Open questions (for Chris or the coordinator)

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/usage.db.test.ts` "has the reasoning split columns"; probe fixture `run_usage` writes both columns; `pnpm --filter @kobe/db test:db`.
