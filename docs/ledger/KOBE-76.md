# KOBE-76: 47b: Run start uses the resolver and passes the result into Pi session config

- **Status:** in review
- **Branch / worktree:** `kobe-76-run-start-resolver` in `../Kobe-wt76`
- **Depends on:** KOBE-75 (merged)

## Plan

`PINNED_AGENTS.resolve` (the run-start seam, inside the run-start `withTeam()` transaction) loads the
team's enabled models and active team-enabled connectors (`runs/resolver-input.ts`), calls
`resolveEffective` and returns approval mode, Pi config and `omissions`. No migration.

## Decisions

- Replaced the ad-hoc mode computation (`effectiveApprovalMode`) in `runs/agents.ts`: the resolver
  input carries the version's frozen `approval_mode.effective` as the agent request, so a lowered
  floor still never loosens a version.
- Pinned alias not team-enabled: the resolver's `agentModelNotEnabled(alias)` error now fails the run
  (`promoteInTx` passes that error through instead of `agent_unavailable`); text identical to KOBE-41.
- `config.model` is set only for an agent's own pin. With no pin the thread's choice or the team
  default is still picked by `requestedModel` + `resolveRunModel`, which also adds the gateway model id
  and API style from the catalog (the resolver knows aliases only). The resolver's default alias
  equals `resolveRunModel`'s, so there is one rule, applied in both places.
- Fixed inputs until the owning tickets land: user-connected connectors = none (KOBE-61, user
  decision), so an agent's team-enabled connectors are omitted as `not_user_connected`; skill lists
  empty and personal-skills switch false (KOBE-78/80); blocklist empty (KOBE-81).
- `mcp_servers` / `skills` reach the Pi config when non-empty (unreachable today, wired for later).
- Omissions: `AgentResolution.omissions` -> `StartPlan.omissions`. No protocol events (KOBE-77).
- Default agent (no pin) is unchanged: install floor only, no resolver.

## Open questions (for Chris or the coordinator)

- Retry/recovery (`restartPlanInTx`) re-resolves; a pinned model disabled since the start returns
  no plan, as before.

## Evidence (acceptance criteria -> test or command output)

- ac-1: `runs-resolver.db.test.ts` "ac-1" (pinned model + `ask-all` in `run.start`, default model and
  `ask-on-write` without pins).
- ac-2: same file "ac-2" (exact KOBE-41 message); `runs-model.db.test.ts` still green.
- Omissions: same file, "returns omissions".
