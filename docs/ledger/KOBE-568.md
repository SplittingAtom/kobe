# KOBE-568: Server: fork lands in Personal with binding; transfer; adopt

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #485; migration PR #487 merged)
- **Branch / worktree:** `kobe-568-fork-transfer-adopt` in `../Kobe-wt568`
- **Depends on:** KOBE-565 (`site_agents.bound_team_id`), KOBE-566 (roster writes, `assignDecision`).
  Spec `docs/specs/agents-roster.md` AR8, AR10, AR16, §5, §6.7-6.9 (AR-4). No migration.

## Plan

Server only. Rules `agents/access.ts` (`canForkAgent(actor, via)`, `forkBinding`); fork source and
copy `agents/fork.ts`; transfers `agents/roster-transfer.ts`; adopt `agents/roster-adopt.ts`; routes
`routes/agent-transfer.ts` (transfers mounted in `agentRoutes` before `/:id`, adopt on the team and
site roster routers); contract `packages/protocol/src/agent-ownership.ts`; OpenAPI in
`openapi/agent-roster.ts` (`agentOwnershipOpenApiPaths`). `store.ts` gained `insertAgent(tx, …)`
(createAgent's body, so adopt is one transaction) and `NewAgent.boundTeamId`; `roster-writes.ts`
exports `lockRoster`, `lockPersonalAgent`, `writeEntry`, `audit` (no behaviour change).

## Decisions

- **Fork source (§5):** the team's own agent (`build`), the caller's own personal agent, a gallery
  agent (`use`), or someone else's personal agent with an assigned (`active|suspended`) entry on the
  site roster (`use`, unbound) or the active team's roster (`build`, bound). Site entry wins when
  both exist (anyone may read it from the site, so the copy is unbound). Anything else 404.
- **What is copied:** the published version; the draft only when nothing is published and the
  caller may read the draft (own, team-owned, gallery). Someone else's never-published entry →
  `422 agent_not_published`. Own published agents now fork from the published version (AR8), not
  the draft as before.
- **Binding:** `forkBinding`: a bound source keeps its team; team-owned or team-entry → active team;
  else null. `agent.created` (source fork) carries `boundTeamId`; it is site-level (`teamId` null)
  like every personal agent's audit. Members (no `build`) can no longer fork team content at all
  (403), as before; gallery forks are now open to members (personal).
- **Body:** `scope` accepted (any short string) and ignored; the response's `warnings` gets
  `{path: "scope", …}` (`AGENT_FORK_SCOPE_IGNORED`). Response adds top-level `boundTeamId`.
- **Transfer storage: team table `agent_transfers`** (review decision; migration PR #487, merged
  before this feature): rows in the team the offer was made in (RLS, FORCE), states
  pending/accepted/declined/cancelled, decided rows kept as history, one pending offer per agent
  site-wide (partial unique index across teams). Every query runs in `withTeam()` with `team_id`
  explicit; finding an agent's offer and the caller's list use `scanTeams` (one query per team, as
  Reach). No `site_settings` storage remains.
- **Transfer shape:** `POST /:id/transfer {toUserId}` (owner → another active member of the active
  team; a new offer in the same team replaces the old one (cancelled); one pending in another team
  → `409 invalid_transition`, cancel it first), `POST /:id/transfer/accept` (recipient),
  `DELETE /:id/transfer` (owner cancels or recipient declines, 204), `GET /v1/agents/transfers`
  (both directions). The owner's `GET /v1/agents/:id` carries `transfer`; the recipient's read of
  that id returns the summary (no definition) + `transfer`. Accept re-checks membership, binding,
  the recipient's slug (`409 slug_taken`) and cap (`409 limit_reached`) under their create lock,
  then moves `owner_user_id` only: entries keep their rows (and `assignedBy`), threads their pins.
  All four writes count against `agent-roster:<userId>`. Audit `agent.transfer.requested`,
  `.cancelled` (`by`), `agent.transferred`, all with the offer's team.
- **Adopt (revised after review):** allowed whether or not the owner is present. Copies the agent's
  **current** published version (not the entry's pin) into the new agent and publishes it as v1 in
  the same transaction (`publishDraftIn`, extracted from `publishAgent`), so the roster never loses
  the running agent (AR10); a failed publish rolls the adopt back. Refused: no entry 404; a proposal
  or a removed entry (adopted already) `409 invalid_transition`; a bound agent into the site or
  another team `422 agent_bound_to_team`. Site copy: `scope = gallery`, no `gallery_key`; the
  `customized_*` columns stay null (their CHECK requires a repository key), which already means
  "the seed never touches it". Audit `agent.roster.removed` + `agent.published` + `agent.adopted`
  (new agent id, `fromAgentId`, `fromVersion`); `agent.created` with `source: adopt`.
- **Transfer of an archived agent:** offer and accept refuse it (`409 agent_archived`).

## Open for 571/572

- **571 (web):** fork dialog posts `{slug?}` only (drop `scope`; `forkGalleryAgent` still sends
  `scope: "team"` and now gets a personal copy plus the warning). Bound note from the response's
  `boundTeamId`. Transfer UI: `GET /v1/agents/transfers` for the inbox, `transfer` on the agent read;
  adopt buttons on Team/Site rows for admins (no `actions.adopt` on rows yet: render for
  `remove`-capable admins on assigned entries). The copy is already published (v1).
- **572 (browser):** "fork bound": fork a team-assigned agent as a builder → Personal, assign to
  site → 422. "owner leaves": adopt into team, publish, run. `site-gallery-edit.spec.ts` forks and
  deletes; its fork is now personal (delete still works).

## Open questions (for Chris or the coordinator)

- None open: the review's two decisions (transfers table-backed, adopt publishes v1) are done.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/agent-ownership.db.test.ts` "fork lands in Personal" (gallery,
  site-assigned, team-assigned, team-owned, own draft/published, 403 for members on team content,
  404 cross-team, bound fork → site 422 and other team 422, own team 201, copy of a copy bound);
  `src/agents/access.test.ts` (`canForkAgent`, `forkBinding`); updated `agents.db.test.ts`,
  `gallery.db.test.ts`, `audit.db.test.ts`.
- ac-2: `agent-ownership.db.test.ts` "transfer" (acceptance required, both reads and lists, entry
  row and thread pin kept, new owner withdraws, decline/cancel with table states, one pending offer
  per agent (replaced in team, 409 from another team), slug clash 409, bound → other team 422, audit
  ids only); `packages/db/src/agent-transfers.db.test.ts` and the probe suite (#487).
- ac-3: `agent-ownership.db.test.ts` "adopt" (team admin only, 403 builder/member/other team;
  published version copied and published as v1, runnable; entry removed; site adopt → gallery
  without key; audit) and "refusals" (other team's admin 404, adopt twice / proposal / removed 409,
  bound into site 422, recipient left the team 422, archived 409, 429 on transfer and adopt).
- Contract/OpenAPI: `packages/protocol/src/agent-ownership.test.ts`, `src/openapi/document.test.ts`.
