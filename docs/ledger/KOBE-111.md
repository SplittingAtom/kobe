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
- **Where it lands**: `<runtime dir>/agent/mcp.json` and `agent/mcp-token`, i.e. Pi's
  `PI_CODING_AGENT_DIR` (private, fresh per Pi process, removed on exit; KOBE-41/196/228). Both
  mode 0400 (0440 under a Pi identity), written atomically. Never the workspace or the shared
  HOME. Pi loads `mcp.json` only with `builtin:mcp`, which `buildPiLaunch` adds (first, before
  kobe-policy) only when servers exist; `mcp` is part of the launch key, so a changed set restarts
  an idle Pi (`ThreadManager` also treats a frame with `mcp` but no `config` as a change).
- **Token rotation (15 min TTL)**: `mcp.json` holds no token. Each server's header is
  `Authorization: !cat '<agent dir>/mcp-token'` (Pi's `!command` config values); the file holds
  `Bearer <token>` and the keeper's rotation rewrites it atomically. The path is the agent's own
  `mkdtemp` dir, checked against `^/[A-Za-z0-9_./-]+$` before use; no tool or model input reaches
  the command. Verified in Pi source (1.0.3 dist, `extensions/mcp/runtime.js`,
  `core/resolve-config-value.js`): header values are resolved uncached when a transport is
  created (connect), NOT per request, and a 401 does not reconnect (only OAuth servers sign in).
  So the proxy closes the gap: `initialize` now returns a constant `Mcp-Session-Id`; a request
  carrying it with a genuine-but-expired token gets 404 (`isExpiredSandboxToken`: signature and
  audience valid, only `exp` failed). Pi's `withClient` treats 404 on a session as
  `McpSessionExpiredError`: it drops the client, opens a new session (re-running the command, so
  reading the rotated file) and retries once; the call never ran. Forged, wrong-audience or
  session-less expired tokens still get 401.
- **Tripwire**: `mcp.json` and `mcp-token` are allowed in `agent/` only when the thread wrote them;
  content is verified (config; last two token texts) in `verifyRuntime`, like the model file.

## Open questions (for Chris or the coordinator)

- The rotation path is covered by unit tests (the header command re-reads the rotated file; proxy
  404 on an expired session) and the Pi source reading above, not by a real-Pi MCP run (Pi is
  not installed locally; there is no real-Pi MCP test yet). Worth a CI real-Pi test with a fake
  MCP server if the coordinator wants it.
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
  token file; none in mcp.json, only proxy URLs), `mcp-proxy/src/mcp.test.ts` (expired session -> 404), `runs-resolver.db.test.ts` (wire field has no
  URL/credential), `mcp-config.test.ts` (strict schema).
