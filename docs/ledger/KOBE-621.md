# KOBE-621: KA-4 Team console admin tools (server)

- **Status:** committed on `kobe-621-team-tools` (KA-1/KA-2 + main underneath)
- **Branch / worktree:** `kobe-621-team-tools` in `../Kobe-wt621`
- **Depends on:** KOBE-619 (host, delegation, catalog, before-state convention); spec
  `docs/specs/kobe-admin-mcp.md` §5 Team list, §6, §8, KA8

## Tool list (32, scope team, `services/server/src/kobe-mcp/tools/`)

| Tool                               | R/W             | Permission (console page)         | Route (in process)                                                                                    |
| ---------------------------------- | --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `team_members_list`                | R               | team.members.manage               | GET /team/members                                                                                     |
| `team_members_set_role`            | W               | team.members.manage               | PATCH /team/members/:id `{role, expectedRole}`                                                        |
| `team_members_remove`              | W (destructive) | team.members.manage               | DELETE /team/members/:id `?expectedRole=`                                                             |
| `team_invites_list`                | R               | team.members.manage               | GET /team/invites                                                                                     |
| `team_invites_create`              | W               | team.members.manage               | POST /team/invites `{email, role, expectedRole: role\|null}`                                          |
| `team_invites_revoke`              | W               | team.members.manage               | DELETE /team/invites/:id `?expectedRole=`                                                             |
| `team_connectors_list`             | R               | team.connectors.manage            | GET /team/connectors                                                                                  |
| `team_connectors_set_exposure`     | W               | team.connectors.manage            | PUT /team/connectors/:id `{exposure, enabled_tools?, expected_exposure}`                              |
| `team_connectors_disable`          | W               | team.connectors.manage            | DELETE /team/connectors/:id `?expectedExposure=`                                                      |
| `team_skills_installs_list`        | R               | team.skills.publish (Skills page) | GET /team/skills/installs                                                                             |
| `team_skill_reviews_list`          | R               | team.skills.review                | GET /team/skill-review `?status&limit&cursor`                                                         |
| `team_skill_reviews_decide`        | W               | team.skills.review                | POST /team/skill-review/:skill/versions/:v `{decision, expectedStatus, acknowledgedFindings?, note?}` |
| `team_models_list`                 | R               | team.models.manage                | GET /team/models                                                                                      |
| `team_models_set`                  | W               | team.models.manage                | PUT /team/models/:alias `{enabled, is_default?, thinking_max?, expected}`                             |
| `team_budgets_get`                 | R               | team.budgets.manage               | GET /team/budgets                                                                                     |
| `team_budgets_set_team`            | W               | team.budgets.manage               | PUT /team/budgets/team `{…, expected}`                                                                |
| `team_budgets_set_member`          | W               | team.budgets.manage               | PUT or DELETE /team/budgets/members/:id `{…, expected}`                                               |
| `team_memory_get`                  | R               | team.memory.manage                | GET /memory/settings?level=team                                                                       |
| `team_memory_set`                  | W               | team.memory.manage                | PUT /memory/settings?level=team `{…, expected}`                                                       |
| `team_egress_list`                 | R               | team.egress.manage                | GET /team/egress                                                                                      |
| `team_egress_enable`               | W               | team.egress.manage                | PUT /team/egress/domains/:d `?expected=disabled`                                                      |
| `team_egress_disable`              | W               | team.egress.manage                | DELETE /team/egress/domains/:d `?expected=enabled_without_headers`                                    |
| `team_egress_requests_list`        | R               | team.egress.manage                | GET /team/egress/requests `?status`                                                                   |
| `team_egress_requests_decide`      | W               | team.egress.manage                | POST /team/egress/requests/:id (pending only: `already_decided`)                                      |
| `team_agents_list`                 | R               | team.agents.suspend               | GET /agents/roster?tab=team                                                                           |
| `team_agents_suspend` / `_resume`  | W               | team.agents.suspend               | PUT /team/agent-roster/:id `{state}` `?expectedSuspended=`                                            |
| `team_schedules_list`              | R               | team.schedules.pause              | GET /schedules?scope=team (no prompts)                                                                |
| `team_schedules_pause` / `_resume` | W               | team.schedules.pause              | POST /schedules/:id/{pause,resume} `?expectedActive=`                                                 |
| `team_usage_get`                   | R               | team.budgets.manage (Usage page)  | GET /team/usage (top 20 per breakdown)                                                                |
| `team_audit_list`                  | R               | team.audit.read                   | GET /team/audit (seq cursor, no IP/UA/hashes, stops under 64 KiB)                                     |

## Left out (and why)

- **Agent transfer:** an owner's offer of their own agent (`POST /v1/agents/:id/transfer`), API
  only, no Team console action; a team admin cannot transfer another member's agent.
- **Kobe connector level** (`teams.settings.kobe_mcp.admin`): a safety switch (KA5, §8 prompt
  injection); console only, never self-raised from a conversation.
- **Egress injected headers** (set/clear): values are secrets that would pass through the model;
  **disabling a domain that has headers** deletes their sealed values for good, so the tool refuses
  it (`injected_headers`, route-enforced) and points to the console.
- **Skill install changes** (uninstall/reinstall/move pin): not in the §5 list (installs = read).
- KA8 items (break-glass, ownership, site roles, legal hold, retention, deletions): no tools; the
  unit test asserts no tool name matches them.

## Server route changes (each in the route's own path, optional, console unchanged)

Conditional before-state under the change's lock, 409 `changed_since_approval`: member removal
(`removeMemberInTx` expected role), team invites create/revoke (row lock or insert-do-nothing for
"none"), team connectors set/disable, skill review decide (`expectedStatus`), team models
(`expected`), team/member budgets (`budgetMatches`, cents), team memory switches (now serialized
per team by an advisory xact lock), egress enable (`already_enabled` → 409 when expected disabled),
egress disable without headers, agent suspension (`setAgentStatus` expected status;
`setTeamSuspension` insert/delete returning), schedules pause/resume (`expectedActive`; resume
answers 409 before the admin-paused check). Framework: `KobeRoute.query`, `segment()` (domains,
`%2A`), `routeCursorSchema`; catalog schemas typed as `Schema<T>` (inference through `z.ZodType`
blew the server typecheck past the default heap).

## Decisions / deviations

- Results: own paging (≤50) over full route lists; route cursors passed through for skill
  reviews and the roster; skill findings omit excerpts (skill text = injection surface).
- Invites send Kobe's invitation email (data out): accepted, the card shows the exact address.
- The KA-2 contract moved into `kobe-mcp-team.db.test.ts` (covers every team tool); shared setup
  in `testing/kobe-mcp-harness.ts`.

## For KA-7 (guide pages to update for this ticket)

- New `admin/admin-from-a-conversation.md`: the Team tool list above (by console page), before
  states and `changed_since_approval`, what stays console-only (list above + KA8).
- `admin/team-admin.md`: each console section can be done from a conversation (tool names), the
  egress header and Kobe-level exceptions.
- `for-agents/working-in-a-sandbox.md`, `for-agents/concepts.md`: read the list first, pass the
  before-state exactly, paging with `next_cursor`, never retry refused/denied writes.
- `internet-and-approvals/internet-access.md`: team egress decide/enable from a conversation,
  domains with injected headers only in the console.
- `agents/skills.md`: approving a version from a conversation needs the findings digest.
- `memory.md`, `models.md`: switches/models changeable by a team admin through the agent.

## Evidence

- `services/server/src/kobe-mcp-team.db.test.ts` (40 tests: per tool ac-1/ac-2 + route conditional
  - replay; ac-3; ac-4; listing per permission); `kobe-mcp.db.test.ts` (17, KA-2).
- Units: `kobe-mcp/tools/team-tools.test.ts`, `kobe-mcp/session-contract.test.ts` (every tool).
