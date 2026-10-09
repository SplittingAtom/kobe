# KOBE-101: probe and pin a connector's tools

- **Status:** in review
- **Branch / worktree:** `kobe-101-connector-probe-pin` in `../Kobe-wt101`
- **Depends on:** KOBE-100 (registry)

## Plan

Pure hashing, a probe through mcp-proxy, pins stored on register (and on URL change).

## Decisions

- **No migration, no new table.** `connectors.tools_snapshot` (jsonb, per-tool `sha256` + `status`)
  and `connectors.tools_hash` already exist (KOBE-58/100) and the proxy and policy read them. A
  separate snapshot table would duplicate them and force a second reader; the ticket's "snapshot
  table" is that column. The registry stays install-wide (no `team_id`, no RLS; the wall is the
  `install.connectors.manage` route), as in KOBE-100. So there is no migration PR from this ticket and
  it does not hold the migration queue.
- **Hash** (`server/src/connectors/pin.ts`): SHA-256 of `canonicalJson({name, description, inputSchema})`
  (RFC 8785, `@kobe/protocol`). Missing description = "". Title, annotations and output schema are
  stored in the snapshot but not pinned (spec: name, description, input schema). `tools_hash` =
  SHA-256 over the sorted `(name, sha256)` pairs.
- **Snapshot is all or nothing:** a tool that fails `pinnedToolSchema`, repeated names, or names
  colliding as Pi names (`get-x`/`get_x`, KOBE-58 L2) pin nothing (`invalid_tool`,
  `ambiguous_tool_names`). Pi's collision hash suffix is not modelled: we refuse instead.
- **Probe through the proxy:** `POST /internal/v1/probe {url}` on mcp-proxy, internal key only,
  uses the same upstream client (address policy, caps) via new `listTools` (initialize, all
  `tools/list` pages, max 20). No credentials are attached, so `api_key`/`oauth` connectors answer
  `auth_required` until KOBE-61/108 provides a grant: they register unpinned and offer no tools
  (fail closed). The server reaches the proxy at `KOBE_MCP_PROXY_URL` (chart sets it; unset = cannot
  pin, `proxy_unavailable`); chart NetworkPolicy admits the server pods on 8080.
- **When pins are written:** on `POST /v1/install/connectors` and on a PATCH that sets `url` (old pins
  were cleared). A failed probe never fails the request: the connector is registered, response has
  `pin: {ok:false, failure, message}`. `POST /:id/pin` retries. The write is conditional
  (`tools_hash IS NULL` and URL unchanged), so a probe never replaces reviewed pins (drift
  re-approval is a later ticket) and a slow probe of an old URL cannot pin the wrong tools.
- **Audit:** `mcp.connector.pinned` (id, name, tool count, hash; never URL), documented in `docs/audit-log.md`.

## Open questions

- Authenticated connectors cannot be pinned at registration (no admin grant yet). KOBE-61/108 should
  call the probe with the admin's grant headers.
- Pi's tool-name collision suffix: if Pi disambiguates, pinning could accept those lists later.

## Evidence

- ac-2: `services/server/src/connectors/pin.test.ts` (key order, whitespace, name/description/schema).
- ac-1: `services/server/src/connectors.db.test.ts` "probe and pin" (every tool pinned on register).
- Proxy: `services/mcp-proxy/src/{probe,upstream}.test.ts`; chart: `charts/kobe/tests/mcp-proxy.test.ts`.
