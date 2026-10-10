# KOBE-112: 62b: Connector changes apply on next run; Orbit export lists MCP tools

- **Status:** in review
- **Branch / worktree:** `kobe-112-connector-changes-next-run` in `../Kobe-wt112`
- **Depends on:** KOBE-111 (per-run `run.start.mcp`), KOBE-106 (proxy enforcement)

## Plan

1. Prove (tests first) that a connector change reaches the next run of the same thread.
2. Prove mid-run changes are enforced per call by the server decision (no enforcement change).
3. Replace `TODO(KOBE-62)` in the Orbit export (and the eval gate) with the effective MCP tool names.

## Decisions

- **No production change was needed for ac-1.** The server resolves connectors on every run start
  (`runs/agents.ts`: no cache between runs; `loadTeamConnectorRows` + grant facts + `buildRunMcp`).
  In the sandbox, `ThreadManager` compares the launch key (which holds the full `mcp` block:
  servers, connector ids, tools) with the live Pi's key on every `run.start`. A different key on an
  idle Pi stops it (its private agent dir, with `mcp.json` and `mcp-token`, is removed on exit) and
  spawns a new one, which writes a fresh `mcp.json` and opens fresh MCP connections. An identical
  key reuses Pi (the same connections and files are still correct). An `mcp` with no servers also
  restarts, now without `builtin:mcp`.
- **What each change does:** team exposure, a grant added/removed, connector disabled/removed,
  tool re-pinned or drifted, agent `tools.allow/deny` all change `run.start.mcp` -> restart.
  A connector **URL** change does not change the frame (Pi only knows the proxy URL by connector
  id), so Pi is reused and the proxy/server decision hands out the current URL on the next call
  (`decideMcpCall` reads the connector row per call; nothing cached, tested).
- **Mid-run changes** stay enforced by the per-call decision (KOBE-106): exposure narrowed, connector
  disabled or removed give deny/404 on the next call of the *running* Pi. Test only, no code change.
  Not tested here: mid-run grant removal, enforced at the proxy credential fetch (KOBE-108/109).
- **Orbit export (ac-2):** `agents/orbit/mcp-tools.ts` `orbitMcpToolNames` reuses `buildRunMcp`
  (the same function that builds `run.start.mcp`), so the eval sees exactly the tools a run would
  offer: the version's frozen connectors, team-enabled and active, exposed pinned undrifted tools,
  narrowed by the agent's tool globs. Grants are not applied (an export describes the agent, not one
  user). Names only (`mcp__<server>__<tool>`): no URL, id or credential is read into the export.
  Wired into the export route, the draft eval gate (`gate.ts`) and the gallery eval
  (`gallery-start.ts`). The "MCP tools are not included" note is gone; a connector the team has not
  enabled just contributes no tools.
- **orbit-eval image:** names go through Orbit's `ORBIT_TOOL_NAME` (`[A-Za-z0-9_-]{1,64}`); the
  mapper already drops longer names with a warning. The image binds a simulated tool per name and
  prefixes `sim_` only on a collision with Orbit's reserved/builtin names, which `mcp__*` cannot
  hit. The CI fixtures `full.yaml` and `agent-bash.yaml` already carry `mcp__github__list_issues`
  and are loaded by Orbit's real loader / `test-image.sh`.

## Open questions (for Chris or the coordinator)

- No real-Pi test of the next-run reload: Pi is not installed locally and there is no real-Pi MCP
  harness (see KOBE-111 ledger). The reload is covered with the scripted Pi that records launches
  and agent dirs, which exercises the same `ThreadManager` path.
- Export tool surface is the team's *current* exposure, not a snapshot at publish time (the
  manifest only freezes connector names). That matches what a run would get now.

## Evidence (acceptance criteria -> test or command output)

- ac-1, sandbox: `services/sandbox-agent/src/agent.mcp.test.ts` ("connector changes on the next
  run": changed set restarts Pi with fresh `mcp.json` and old dir gone; changed tools restart,
  identical reuses; no connectors drops the extension).
- ac-1, server: `runs-resolver.db.test.ts` ("every change shows in the next resolve");
  mid-run: `mcp.db.test.ts` ("connector changes mid-run are enforced at the next call").
- ac-2: `orbit-export.db.test.ts` ("MCP tools in the export"), `orbit-eval.db.test.ts` (ConfigMap
  `agent.yaml` carries the names, no URL), `agents/orbit/orbit-export.test.ts` (mapper).
