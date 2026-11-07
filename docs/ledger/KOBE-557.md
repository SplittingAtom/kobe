# KOBE-557: Usage: reasoning tokens per call (reported or estimated) and thinking budgets per level

- **Status:** PR 1 #469 merged (98561f26); PR 2 #471 in review
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
- Gateway: `UsageReading.reasoning` is optional (absent = unknown → `null` in the row), so the
  other readings (`unanswered`, `NO_TOKENS`) need no change. Thinking text is counted from SSE
  events only (JSON bodies are not estimated); an over-long SSE line with a thinking mark counts whole.
- Review (PR #471): a reported **non-zero** split wins; a reported 0 (proxy placeholder) gives way
  to the estimate when the stream carried thinking text. Counts are clamped to output (again in
  `recordModelUsage`). `reasoning_estimated` is false whenever the count is null.
- Review: the estimate is ceil(**characters** / 4), not UTF-8 bytes as ac-3 says, so it uses the
  same unit as the output estimate (bytes clamped non-ASCII thinking to 100% of output). One field
  per OpenAI-compatible delta (`reasoning_content`, else `reasoning`).
- Per-run `reasoning_tokens` = `sum()` over the run's calls (null when no call had a count);
  `reasoning_estimated` = `bool_or` over counted calls. Team/site/thread totals: `COALESCE(sum, 0)`.
- The ticket's "run.usage event" is `usageSchema` (used by `run.completed.usage`): it gains optional
  `reasoning`. No producer fills it yet (nothing fills `run.completed.usage` today).
- `thinking_in_team.control` added to `ChatThinkingView` (server, OpenAPI, web `thinkingInTeam.control?`).
- Web `RunUsage.reasoningTokens?` / `reasoningEstimated?` and `UsageTotals.reasoningTokens?` are
  optional ("absent on older servers"), like `thinkingLevel`.

## Open questions (for Chris or the coordinator)

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/usage.db.test.ts` "has the reasoning split columns"; probe fixture `run_usage` writes both columns; `pnpm --filter @kobe/db test:db` (100 files green); PR #469.
- ac-2: `services/model-gateway/src/usage/normalize.test.ts` (Chat Completions, Responses, Gemini samples; Anthropic none).
- ac-3: `meter.test.ts` "UsageMeter: reasoning tokens (KOBE-557)" (per stream shape, clamp, reported wins, neither → none); `sink.test.ts`.
- ac-4: `packages/db/src/usage.db.test.ts` "writes the reasoning split"; `services/server/src/usage.db.test.ts` "reasoning tokens (KOBE-557)"; `openapi.json`; `packages/protocol/src/thinking.test.ts` usageSchema.
- ac-5: `packages/protocol/src/thinking.test.ts` "thinking budgets per level"; gateway `thinking.test.ts` unchanged and green; docs/design/thinking-controls.md "Budgets and reasoning spend".
- ac-6: `apps/web/lib/admin/api/usage.ts`, `team/models.ts` types; verify + server test:db.
