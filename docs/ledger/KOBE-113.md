# KOBE-113: Web search provider setting (63a)

- **Status:** in progress
- **Branch / worktree:** `kobe-113-web-search-setting` in `../Kobe-wt113`; migration PR from `kobe-113-web-search-setting-migration`
- **Depends on:** KOBE-107 (envelope). Feeds KOBE-114 (`web_search` tool).

## Plan

Two PRs: (1) migration only; (2) install admin API and UI, team opt-in, audit.

## Decisions

- **Storage.** `web_search_settings` (install-wide, singleton: `id` pinned to 1; provider in
  brave/tavily/exa; `enabled`; `sealed` KOBE-107 envelope text, `key_id`, `hint`; no plaintext, check
  constraint requires `e1.` text). `team_web_search` (team table, one row per team = opted in;
  `team_isolation` RLS, ENABLE + FORCE, 0081). No break-glass policy: no team content.
- App role gets full DML on `web_search_settings` (tenancy/connectors.ts); probe fixture added for
  `team_web_search`.

## Evidence

| Criterion                 | Evidence                                             |
| ------------------------- | ---------------------------------------------------- |
| Storage, RLS, sealed-only | `packages/db/src/web-search.db.test.ts`, probe suite |
