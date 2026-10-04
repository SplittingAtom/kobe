# KOBE-75: 47a: Resolver: effective model, approval floor, skills, connectors (pure function)

- **Status:** in review
- **Branch / worktree:** `kobe-75-resolver` in `../Kobe-wt75`
- **Depends on:** none (KOBE-76 wires it into run start)

## Plan

`services/server/src/resolver/resolve.ts`: `resolveEffective(input)`, pure, no DB. Table tests first
in `resolve.test.ts`.

## Decisions

- Pinned alias not team-enabled returns `agentModelNotEnabled(alias)` (existing `runs/failure-codes.ts`,
  code `agent_model_not_enabled`), never a fallback. No pin uses the team default; none -> `model`
  undefined plus a `no_team_default` omission.
- Approval mode = strictest of install floor, agent request (default `ask-on-write`) and optional user
  pref, via `strictestApprovalMode`. The floor is install-wide (D6); there is no team floor.
- Skills: agent skills, plus user skills unless the agent is exclusive; minus all personal skills when the
  team switch `personalSkillsDisabled` is set (KOBE-80) and blocklisted hashes (both, by hash). A user skill with an agent skill's
  name is dropped (`shadowed_by_agent`; agent wins).
- Connectors: agent list ∩ team-enabled ∩ user-connected (coordinator, spec); never added from the
  user's or team's lists. Omissions: not_team_enabled, not_user_connected. KOBE-76 chooses the
  user-connected input until KOBE-61.
- Omission reasons: agent_exclusive, team_disabled, blocklisted, shadowed_by_agent, not_team_enabled,
  no_team_default. Mode tightening is not an omission.

## Open questions (for Chris or the coordinator)

- Error text kept as KOBE-41's (coordinator confirmed).

## Evidence (acceptance criteria -> test or command output)

- ac-1: `resolve.test.ts` model, skills and connectors tables.
- ac-2: approval-mode test over 4 x 4 x 3 combinations.
- ac-3: omission assertions in every skills/connectors/model case.
