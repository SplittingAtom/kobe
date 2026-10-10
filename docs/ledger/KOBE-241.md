# KOBE-241: KOBE-111 follow-ups: token-rotation e2e, cap expired-token age

- **Status:** PR open
- **Branch / worktree:** `kobe-241-mcp-token-rotation-e2e` in `../Kobe-wt241`
- **Depends on:** KOBE-111

## Decisions

- **Cap** (`services/mcp-proxy/src/auth.ts`): `EXPIRED_TOKEN_MAX_AGE_SECONDS` = 2 x
  `SESSION_TOKEN_TTL_SECONDS` (30 min) past `exp`. A genuine token expired within the cap gets the
  404 on a live MCP session; older gets 401. The proxy logs the 404 (no token) so the e2e can see it.
- **Short TTL for the e2e:** `KOBE_SESSION_TOKEN_TTL_SECONDS` (server, 10..900, default 900) via chart
  `server.sessionTokenTtlSeconds`. Not a security knob: the proxy cap stays at twice the default.
- **e2e** (`e2e/run.sh`, section "real Pi past an MCP token rotation"): after the MCP proxy and
  executor sections. Hibernates the owner's sandbox, sets TTL 15 s (one server roll), runs a real Pi
  through the fake model (`tool: mcp__e2e_fake__get_thing`) on a personal agent with the `e2e-fake`
  connector, waits TTL + 2 s, calls again in the same thread. Asserts both runs complete, the fake
  MCP server saw exactly two calls, and the proxy logged the expired-token 404 (Pi reconnected). The
  KOBE-116 section's first upgrade restores TTL 900.
- **Item 3 (executor off):** tracking only, no code. Tools sharing Pi's uid can read the proxy token
  or replace `mcp.json`; the tripwire detects it. Resolved by the executor: KOBE-167/168.

## Open questions

- Added e2e time (roll + wake + two runs + 17 s wait) is measured in CI ("rotation e2e:" line).

## Evidence

- ac-1: `auth.test.ts` and `mcp.test.ts` (cap, 401 past it); e2e section above (call after rotation).
