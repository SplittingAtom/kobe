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
- Skills: agent skills, plus user skills unless the agent is exclusive; minus team-disabled personal
  skills (by name, user skills only) and blocklisted hashes (both). A user skill with an agent skill's
  name is dropped (`shadowed_by_agent`; agent wins).
- Connectors: (agent list + user-connected) filtered by team-enabled; user-connected is empty until
  KOBE-61 (user decision 2026-10-04).
- Omission reasons: agent_exclusive, team_disabled, blocklisted, shadowed_by_agent, not_team_enabled,
  no_team_default. Mode tightening is not an omission.

## Open questions (for Chris or the coordinator)

- Error text: reused the existing KOBE-41 message ("... Ask your team admin to enable it.") rather
  than the brief's shorter wording, so run-start errors stay consistent.
- Skill identity for team-disabled is by name; KOBE-76 may prefer ids.

## Evidence (acceptance criteria -> test or command output)

- ac-1: `resolve.test.ts` model, skills and connectors tables.
- ac-2: approval-mode test over 4 x 4 x 3 combinations.
- ac-3: omission assertions in every skills/connectors/model case.
