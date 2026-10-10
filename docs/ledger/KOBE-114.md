# KOBE-114: web_search tool for agents (63b)

- **Status:** in review (PR #194)
- **Branch / worktree:** `kobe-114-web-search-tool` in `../Kobe-wt114`
- **Depends on:** KOBE-113 (provider setting, sealed key, team opt-in), KOBE-107 (envelope), KOBE-128/147 (kobe-tools, wire pattern)

## Plan

A `web_search` kobe-tool, listed to every agent. Path: Pi tool -> kobe-policy `policy.check` (server
decides, read tool) -> kobe-tools fd 4 `{op:"web_search"}` -> agent -> wire frame `web_search.query`
-> **server searches** -> `web_search.result` (citations or "unavailable").

## Decisions

- **The server performs the search; the egress proxy is not used for the key.** The brief offered
  KOBE-39 header injection or a server-side search. Header injection is per team and per domain
  (sealed with the team header secret, `team_egress.headers_sealed`), so using it would mean copying the
  install-wide key into every opted-in team's header rules, re-sealing them on every key change or
  removal, and enabling the provider domain for the whole team's `bash`/`curl` (any member could then
  spend the key at will). The tool path already is "server decides every call": `policy.check` allows
  the call, the server records the input hash, and `web_search.query` is accepted only for that exact
  call (D-3, same as `artifact.put`/`file.share`). The key stays sealed in `web_search_settings`, is
  opened in the server process for one request to the provider's fixed API host, and is never sent on
  any wire: not to the sandbox, the egress proxy or the MCP proxy. The egress-ceiling domain KOBE-113
  adds is therefore not needed for this tool (harmless; left as is).
- **Unavailable is an answer, not an error.** No provider / provider disabled / no envelope key /
  key that no longer opens -> `reason: not_configured`; team has not opted in -> `team_not_enabled`.
  The tool returns the server's message as a normal result, so the model can explain it. Real failures
  (provider HTTP error, timeout, malformed answer, > 1 MiB) are `search_failed`; provider 429 or more
  than 30 searches/min/team -> `rate_limited`. Provider text is never relayed (an error cannot echo the key).
- **Citations.** `{title, url, snippet}` per result, http(s) only, markup stripped, bounded (300/2048/1000).
  The tool text is a numbered list ending each entry with its URL; the Researcher prompt (generation 2)
  says to cite URLs and, on "unavailable", to open with its existing no-search sentence and give the reason.
- **Providers** (KOBE-113 list): brave (GET, `X-Subscription-Token`), tavily (POST, Bearer), exa (POST,
  `x-api-key`); `redirect: "error"`, 10 s timeout. Parsing is in `services/server/src/web-search/search.ts`.
- **Capability, no env flag.** The agent announces `web_search` whenever it has the tools extension; the
  tool is always registered, so "unavailable" is reachable. The server refuses `web_search.query` from a
  connection without the capability (audit `sandbox.web_search_refused`, never the query).
- **Risk.** `BUILTIN_TOOLS.web_search` = kobe source, `read`, scope `external`, open-world: no approval
  in ask-on-write; deny/ask rules and `ask-all` still apply, and agent files can name it.

## Open questions (for Chris or the coordinator)

1. Contract rule: `packages/protocol` normally changes in its own PR. Here the additive contract
   (`web-search.ts`, two frames, one kobe-tools op, one BUILTIN_TOOLS entry) ships in the feature PR to
   keep the ticket to one PR; split it if you prefer.
2. Provider answers are not audited per search (only refusals), to keep queries out of the log. Add a
   count-only audit event if admins want usage visibility.
3. Real-Pi test of the new tool is not added (needs the image); unit + wire DB tests cover it.

## Evidence (acceptance criteria -> test or command output)

| Criterion                                        | Evidence                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| ac-1 configured: searches succeed with citations | `services/server/src/web-search-tool.db.test.ts` "opted in"; `web-search/search.test.ts` (3 providers)                  |
| ac-2 unconfigured: unavailable, explained        | same db test (both reasons, no provider call); `definitions.test.ts` Researcher prompt; `kobe-tools/web-search.test.ts` |
| ac-2 key never visible in the sandbox            | db test asserts no received frame contains the key; key is only opened in `web-search/service.ts`                       |
| Refusals                                         | db test: unchecked call, other input, no capability, audited without the query                                          |
| Sandbox side                                     | `kobe-tools/web-search.test.ts`, `tools/web-search-broker.test.ts`, `protocol/src/web-search.test.ts`                   |
