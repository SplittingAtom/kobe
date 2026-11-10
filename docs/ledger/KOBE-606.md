# KOBE-606: Remove the built-in web search; web search comes through MCP connectors

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (branch committed; no PR yet, the coordinator opens it)
- **Branch / worktree:** `kobe-606-remove-web-search` in `../Kobe-wt606`
- **Depends on:** none. Amends KOBE-63 / KOBE-113 / KOBE-114 (Chris 2026-11-10: remove the whole feature).

## What changed

- **Web (ac-1):** Site settings web-search form, Team console Web search page and route, both nav
  entries, both admin API clients and their tests removed. The site nav's KOBE-63 "on hold"
  placeholder is gone, so `OPEN_PLACEHOLDER_TICKETS` is now empty; the registry guard loops over
  it (no `it.each` over an empty table) and asserts no `web-search` section in either console.
- **Sandbox agent (ac-2):** no `web_search` tool, no `web_search` hello capability, broker deleted.
- **Protocol (ac-2):** `web-search.ts`, `web-search-frames.ts`, `CAPABILITY_WEB_SEARCH`, the
  kobe-tools op and `BUILTIN_TOOLS.web_search` removed. New `sandbox-wire/legacy-web-search-frames.ts`
  keeps `web_search.query` (input not validated) and an unavailable-only `web_search.result` in the
  frame unions, so an agent from before KOBE-606 still gets an answer while a release rolls out.
- **Server (ac-2):** routes `/v1/site/web-search` and `/v1/team/web-search`, `web-search/*`
  (providers, store, service), the sealed-key start-up family for the provider key, the wire
  context's search service and refusal audit removed. A `web_search.query` is answered
  `available: false, reason: not_configured` with `LEGACY_WEB_SEARCH_MESSAGE`; the connection
  stays up. Policy now denies `web_search` as `unknown_tool` (so an old agent never gets that far
  in practice). OpenAPI: no web-search routes were documented, so `openapi.json` is unchanged
  (its only "web-search" text is the threads `q` full-text syntax, which stays).
- **DB (ac-3):** migration **`0204_drop_web_search`** (generated, not hand-written) drops
  `web_search_settings` and `team_web_search` and drops the `web_search` egress preset from the
  `egress_domains_preset` check (no code ever inserted a row with that preset; KOBE-63's "auto"
  provider domain was never built). Tenancy and probe fixtures updated. Audit events
  `mcp.web_search.*` and `sandbox.web_search_*` stay in the registry, marked retired (KOBE-587
  convention), so old rows still read; `docs/audit-log.md` marks them retired.
- **Gallery (ac-4):** Kobe at **generation 3**: the Research paragraph uses connector tools that
  can search or reach the source when the team has one, cites URLs, and otherwise says plainly it
  cannot look things up; `KOBE_NO_SEARCH_NOTICE` removed. The seed republishes on generation 3
  (a site-admin-customized Kobe is not overwritten, as before).
- **e2e / docs:** `e2e/run.sh` Kobe scenario checks the new research guidance reaches Pi's system
  prompt and the published prompt has no `web_search`; orbit fixture drops `web_search`;
  `docs/backup-restore.md` no longer names the web search key. Historical ledgers, the perf
  baseline and the 2026-10-23 review keep their mentions as history.

## Decisions

- Egress preset `web_search` removed with the feature (its only meaning was the provider's domain).
- Old audit event names kept (registry + docs, marked retired); nothing is written to them now.
- `AllowedArtifactCalls.consume()` stays (other tools use it); its test now uses `recall`.

## For Chris / the coordinator

- Record the amended web-search decision in `docs/RUN-LEDGER.md` and the product spec's decision
  note (coordinator-only / outside the repo; not done here).
- An upgraded install loses any configured provider key and team opt-ins (gate1 had none).
- `isActiveMessageRun` (`sandbox-wire/run-state.ts`) is now only used by its own tests.
- Sandbox-agent `src/models/runtime-dir.test.ts` fails locally with TMPDIR under /home (needs a
  sticky dir); unrelated and fails the same on main.

## Evidence

- ac-1: `apps/web` vitest (registry, console-shell, overview, site-pages, egress-pages), typecheck, lint.
- ac-2: `packages/protocol/src/legacy-web-search.test.ts`; `services/server/src/legacy-web-search.db.test.ts`
  (old agent: policy deny, two queries answered unavailable on a live connection); sandbox-agent
  `extension.test.ts`; server unit suite 2546 passed.
- ac-3: `packages/db/src/drop-web-search-upgrade.db.test.ts` (tables gone, audit rows and chain
  intact, preset check); db package `test:db` 107 files / 1734 tests passed (probe suite included).
- ac-4: `gallery/definitions.test.ts` (generation 3, no web_search, connector research guidance).
