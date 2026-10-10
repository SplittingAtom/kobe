# KOBE-244: MCP connectors unusable by real Pi; real-Pi rotation e2e

- **Status:** PR open
- **Branch / worktree:** `kobe-244-mcp-real-pi-fix` in `../Kobe-wt244`
- **Depends on:** KOBE-111, KOBE-241 (findings in `docs/ledger/KOBE-241.md`; #207 not required)

## Decisions

- **Modes:** `writeAgentFile` opens the temp file with `O_NOFOLLOW`, `fchmod`s it to exactly 0440
  (Pi identity: owner kobe, Pi's group) or 0400 before writing, then renames. The umask (077) no
  longer matters. With the executor, tools run as the partner uid, which is not in Pi's group, so
  they still cannot read the token; without it, tools share Pi's uid (unchanged, tripwire only).
  `identities.real.test.ts` (CI "Sandbox privilege separation") checks owner, group, mode, that the
  Pi identity reads both files and another thread's identity cannot.
- **Headers:** each server in `mcp.json` carries `Kobe-Thread-Id: <Thread.id>` next to the `!cat`
  Authorization. The id is the Pi process's thread (set by the agent when it spawns Pi, validated
  `^[A-Za-z0-9-]{1,64}$`), never from tools. mcp-proxy's other requirements (JSON content type,
  protocol version) are what Pi's Streamable HTTP client sends.
- **Short TTL for the e2e:** `KOBE_SESSION_TOKEN_TTL_SECONDS` (server, 10..900, default 900), chart
  `server.sessionTokenTtlSeconds`. The e2e sets 10 s with one server roll; the KOBE-116 section's
  first upgrade restores 900. mcp-proxy logs the expired-token 404 so the e2e can prove the reconnect.
- **e2e:** `e2e/run.sh` section "real Pi past an MCP token rotation", executor shard only
  (`KOBE_E2E_TOOL_EXECUTOR=1`). Asserts per run: completes, the model saw `fake:get_thing`, the fake
  server's call count rose by exactly one; plus the proxy's 404 log line. Prints its own elapsed time.

## Open questions

- Added e2e time: see the "rotation e2e:" line in the executor job (target under 60 s).
- Expired-token age cap (2x TTL) is KOBE-241 / #207, independent of this.

## Evidence

- ac-1: e2e section above; unit: `pi-mcp-config.test.ts` (modes under umask 077, header),
  `identities.real.test.ts`, `mcp.test.ts` (404 log).
