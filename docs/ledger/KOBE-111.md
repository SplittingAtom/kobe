# KOBE-111: 62a: Per-session MCP config for Pi

- **Status:** in progress
- **Branch / worktree:** `kobe-111-pi-mcp-session-config` in `../Kobe-wt111`
- **Depends on:** KOBE-106 (proxy enforces exposure), KOBE-108/109 (API-key and OAuth grants)

## Plan

1. Replace the resolver's `TODO(KOBE-61)` stub (`runs/resolver-input.ts`) with real grants.
2. Send the effective connectors to the sandbox as an additive `run.start.mcp` field behind hello
   capability `mcp`.
3. The sandbox writes Pi's `mcp.json` into the thread's private config dir and loads `builtin:mcp`.

## Decisions

- **Effective connector** (`services/server/src/runs/run-mcp.ts`): in the agent's `connectors`
  list, team-enabled and active (resolver), and the run's user holds a grant of the connector's
  `auth_kind` that is usable now: API key, or OAuth with `expires_at` null or in the future (no
  refresh here: KOBE-110). `auth_kind = none` needs no grant. Only grant metadata is read; no
  sealed bytes are loaded at run start. Other users' grants never count (query is by user).
- **Tools** per connector = `exposedTools` (team exposure, pinned, not drifted: same function the
  proxy's `tools/list` uses) narrowed by the agent's `tools.allow`/`tools.deny` globs matched on the
  Pi name `mcp__<server>__<tool>`. A connector left with no tool is not offered. Team deny/ask
  rules and the engine are NOT evaluated at run start; the proxy and kobe-policy still enforce them
  per call (second enforcement point).
- **Wire** (`packages/protocol/src/sandbox-wire/mcp-config.ts`): `run.start.mcp =
{servers:[{name, connector_id, tools:[{name, pi_name}]}]}`, strict, no URL or credential field.
  Capability `mcp` (`CAPABILITY_MCP`). The server sends it always (an empty list tells a live Pi to
  restart without MCP); delivery strips it for agents without the capability, like `project`.
  `config.mcp_servers` (older, names only) is kept and now holds the same effective set.
- **Sandbox**: the agent advertises `mcp` only with `KOBE_MCP_PROXY_URL` (already in the pod spec)
  and a bootstrap session. A new `ModelTokenKeeper` trades the `kobe.mcp-proxy` token.
  `buildPiMcpConfig` (`services/sandbox-agent/src/mcp/pi-mcp-config.ts`) emits Pi's `mcpServers`
  shape: per connector `url = <proxy>/v1/mcp/<connector_id>`, `headers.Authorization = Bearer
<session token>`, `exposure: hidden` plus `toolExposure: {<mcp tool>: direct}` so Pi registers
  exactly the listed tools. Nothing else (no upstream URL, key, OAuth block, stdio command).
- **Where it lands**: `<runtime dir>/agent/mcp.json`, i.e. Pi's `PI_CODING_AGENT_DIR` (private,
  fresh per Pi process, removed on exit; KOBE-41/196/228). Mode 0400 (0440 under a Pi identity).
  Never the workspace or the shared HOME. Pi loads it only with `builtin:mcp`, which
  `buildPiLaunch` adds (first, before kobe-policy) only when servers exist; `mcp` is part of the
  launch key, so a changed set restarts an idle Pi (`ThreadManager` also treats a frame with `mcp`
  but no `config` as a change).
- **Tripwire**: `mcp.json` is allowed in `agent/` only when the thread wrote one, and its content
  is verified (last two texts written) in `verifyRuntime`, like the model file.
- **Token rotation**: the keeper's new token rewrites `mcp.json` atomically (temp + rename).

## Open questions (for Chris or the coordinator)

- Pi resolves header values when it opens a server connection, not per request. A Pi connected
  before a rotation keeps the 15-minute token until it reconnects, so a run longer than the token
  TTL may see 401s from the proxy. Options: a `!command` header that cats a rotated file (shell
  from Pi's uid), a longer mcp-proxy token TTL, or restarting idle Pi on rotation. Not done here.
- Under a Pi identity the tool uid equals Pi's, so tools can read `mcp.json` (same as the model
  file today); the paired tool uid (KOBE-167) separates them. The token is audience-scoped to the
  proxy and the user's own grants only.
- `pi_name` collision suffixes (KOBE-59) are used as stored; Pi derives its own names from the
  server key and tool name, which is what the pin recorded.

## Evidence (acceptance criteria -> test or command output)

- ac-1 (agent sees exactly the effective connector tools): `runs-resolver.db.test.ts` ("effective
  connectors from grants"), `runs/run-mcp.test.ts`, `mcp/pi-mcp-config.test.ts` (toolExposure),
  `agent.mcp.test.ts` (extension only with connectors).
- ac-2 (sandbox config has no upstream credentials): `pi-mcp-config.test.ts` (only the session
  token; no other secret-like string, only proxy URLs), `runs-resolver.db.test.ts` (wire field has no
  URL/credential), `mcp-config.test.ts` (strict schema).
