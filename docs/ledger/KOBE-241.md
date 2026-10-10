# KOBE-241: KOBE-111 follow-ups: token-rotation e2e, cap expired-token age

- **Status:** PR #207 holds only the proxy cap; the real-Pi e2e moved to a follow-up ticket
- **Branch / worktree:** `kobe-241-mcp-token-rotation-e2e` in `../Kobe-wt241`
- **Depends on:** KOBE-111

## Done

- **Cap** (`services/mcp-proxy/src/auth.ts`): `EXPIRED_TOKEN_MAX_AGE_SECONDS` = 2 x
  `SESSION_TOKEN_TTL_SECONDS` (30 min) past `exp`. A genuine token expired within the cap gets the
  404 on a live MCP session; older gets 401. Tests: `auth.test.ts`, `mcp.test.ts`.
- **Item 3 (executor off):** tracking only, no code. Tools sharing Pi's uid can read the proxy token
  or replace `mcp.json`; the tripwire detects it. Resolved by the executor: KOBE-167/168.

## Real-Pi rotation e2e: not landed (what the attempts showed)

Four CI runs of a section in `e2e/run.sh` (suite and executor shards) failed the same four
assertions: "the model saw the fake server's answer" (both runs), "each call ran exactly once on the
fake MCP server" (got 0 calls), "the mcp-proxy answered an expired token ... 404" (got 0). The runs
themselves ended `terminal=run.completed`, which only means the run finished: the model text said
otherwise, so the first assertion (run completed) was a false pass.

Evidence from the job logs (the fake model echoes the tool result as `text=`):

1. Runs 1-3: `text=fake-openai: tool said: Tool mcp__e2e_fake__get_thing not found`. The owner's
   sandbox did get `agent/mcp.json` (correct content: connector URL, `toolExposure`, `!cat` header),
   but as `-r-------- kobe kobe-pi-2` (0400). Pi runs as `kobe-pi-2`, so it could not read it. Cause:
   `writeAgentFile` passes mode 0440 to `writeFile`, and the agent's umask 077 (`index.ts`) strips
   the group bit. Fix tried: `chmod(temp, mode)` before the rename (unit test with `process.umask`).
2. Run 4 (with that fix): the tool registered and the call reached the proxy, answer
   `Kobe denied this call: The call names no thread, so it was denied.` The proxy requires a
   `Kobe-Thread-Id` header (`mcp.ts` `THREAD_HEADER`, "KOBE-62 sets it per session") and
   `buildPiMcpConfig` sends only `Authorization`. Fix tried: a `Kobe-Thread-Id` header from
   `Thread.id` in `mcp.json`. Not run in CI afterwards, so more gaps may follow.

So the zero counts were not a wrong URL or a different server: Pi never got a working MCP tool
(1), then every call was denied before the proxy asked the server or the upstream (2). KOBE-111's
unit tests never exercised either, which is why a real Pi was needed.

For the follow-up: land those two sandbox-agent fixes with tests, then the e2e. Design used: a
personal agent (SQL: copy of gallery `assistant`, `tools` removed, `connectors: ["e2e-fake"]` in
frontmatter and `tool_manifest`), the existing `e2e-fake` connector, `chat_run "tool:
mcp__e2e_fake__get_thing {...}"` twice in one thread, 17 s apart. Needs the server to issue short
tokens (a test-only `KOBE_SESSION_TOKEN_TTL_SECONDS`, 10..900, chart `server.sessionTokenTtlSeconds`,
one server roll) and the owner's sandbox hibernated first so it re-trades; the proxy needs a log
line on the expired-token 404 to prove the reconnect. Cost measured: 52-67 s per shard (setup
25-34 s, first run 8-11 s), so the 60 s budget is tight. Add `Kobe-Thread-Id` to the mcp-proxy
doc comment when fixed.

## Evidence

- ac-1 (partly): an expired token older than the cap gets 401 (`auth.test.ts`, `mcp.test.ts`). The
  real-Pi call after rotation is open (above).
