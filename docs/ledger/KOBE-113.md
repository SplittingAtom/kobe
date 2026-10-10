# KOBE-113: Web search provider setting (63a)

- **Status:** in review (two PRs)
- **Branch / worktree:** `kobe-113-web-search-setting` in `../Kobe-wt113`; migration PR from `kobe-113-web-search-setting-migration`
- **Depends on:** KOBE-107 (envelope). Feeds KOBE-114 (`web_search` tool).

## Plan

Two PRs: (1) migration only (#186); (2) install admin API and UI, team opt-in, audit.

## Decisions

- **Storage.** `web_search_settings` (install-wide singleton: `id` pinned to 1; provider in
  brave/tavily/exa; `enabled`; `sealed` KOBE-107 envelope text, `key_id`, `hint`; a check requires
  `e1.` text, so plaintext cannot be stored). `team_web_search` (team table, a row = team opted in;
  `team_isolation` RLS, ENABLE + FORCE, migration 0081). No break-glass policy: no team content.
- **Envelope binding:** nil team id, kind `web_search`, record `install`.
- **API.** `/v1/install/web-search` GET/PUT/DELETE (`install.settings.manage`); PUT takes
  `provider`, `api_key` (required for a first or different provider), `enabled`. Responses carry a
  masked hint only, `Cache-Control: no-store`. 503 when the install has no envelope key.
  `/v1/team/web-search` GET (`team.read`) / PUT (`team.connectors.manage`); enabling needs the
  install to offer a provider (409 otherwise).
- **Egress ceiling.** Saving an enabled provider adds its API domain (brave `api.search.brave.com`,
  tavily `api.tavily.com`, exa `api.exa.ai`) to the ceiling via the existing store (idempotent).
  Disabling or removing leaves the domain; the ceiling stays the admin's to edit.
- **Removal** deletes the key but leaves team opt-ins dormant (RLS stops a bulk delete from the
  install context); `available` gates them, and they apply again if a provider returns.
- **Audit:** `mcp.web_search.configured` / `.removed` / `mcp.web_search.team_changed`; provider and
  switches only, never the key or hint.
- **UI:** install Settings page "Web search" form (password field, masked hint, remove). Team opt-in
  has API only; a team console toggle is not in this ticket.

## Open questions

1. Team console toggle for the opt-in (API ready) - separate small ticket?
2. Provider list (brave, tavily, exa) is my pick; adjust in `web-search/providers.ts` + schema check.

## Evidence

| Criterion                                  | Evidence                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| ac-1 provider and key set by install admin | `services/server/src/web-search.db.test.ts`; UI `install-pages.test.tsx` "Web search setting" |
| ac-2 key never returned                    | same db test (responses, GET, Postgres rows, audit); UI test                                  |
| Storage, RLS, sealed-only                  | `packages/db/src/web-search.db.test.ts`, probe suite                                          |
