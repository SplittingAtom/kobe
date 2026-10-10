# KOBE-106: mcp-proxy enforces team exposure

- **Status:** in review
- **Branch / worktree:** `kobe-106-proxy-team-exposure` in `../Kobe-wt106`
- **Depends on:** KOBE-104 (team_connectors), KOBE-101/102 (pins, drift)

## Decisions

- **No migration.** Enforcement already ran through the engine's gate and `exposedTools` (KOBE-58); this ticket
  makes it explicit and audited, and tests it.
- **Where:** the proxy has no DB and trusts nothing from the sandbox, so enforcement is the server's internal
  listener: `mcp/decide.ts` (`tools/call`) and `mcp/service.ts` (`tools/list`, which filters with `exposedTools`).
  The proxy forwards the server's refusal reason to the sandbox and runs nothing upstream.
- **New gate in `decideMcpCall`** right after the pin lookup, before any run is loaded and independent of the
  engine: drifted -> `tool_drifted`; outside exposure -> `connector_exposure` (`read_only` = `readOnlyHint: true`
  only, so unannotated tools are excluded; `custom` = ticked tools). Previously a bad or missing thread
  answered `run_not_active` first.
- **Disabled connector:** `connector_not_enabled` is now audited as a denied `mcp.tool_call` (tool name
  `mcp__unknown__<tool>`: the name of an unenabled connector is not read). A refused `tools/list` is audited as
  the new `mcp.list_refused` (documented in `docs/audit-log.md`). Both use the existing per-sandbox denied-audit throttle.
- **Cache TTL: none (0 s).** Connector state is read from Postgres on every list and call (the proxy caches
  nothing), so an exposure change or disable applies to the next request without restarting anything.

## Evidence

- `services/server/src/mcp-exposure.db.test.ts`: disabled (list + call + audit), read_only refuses write and
  unannotated tools, custom refuses unticked, drifted refused, enabled + exposed passes, change applies at once.
- `services/mcp-proxy/src/mcp.test.ts`: proxy runs nothing upstream and relays the reason.
- ac-1: first test. ac-2: second and third tests.

## Open questions

- None.
