# KOBE-619: KA-2 Kobe MCP host, delegation and rules (server, mcp-proxy)

- **Status:** committed on `kobe-618-619-admin-host` (after the KOBE-618 migration commit)
- **Branch / worktree:** `kobe-618-619-admin-host` in `../Kobe-wt618`
- **Depends on:** KOBE-618; spec `docs/specs/kobe-admin-mcp.md` §3, §5–§8, §11 KA-2

## What landed

- **Proxy** (`services/mcp-proxy/src/mcp.ts`, `server-client.ts`): `POST /v1/mcp/<KOBE_BUILTIN_CONNECTOR_ID>`
  (`@kobe/protocol` `kobe-mcp.ts`, same fixed id as the db row) goes to the server's internal
  listener `POST /internal/v1/mcp/kobe/{list,calls}`; no upstream, no credential lookup.
- **Server host** (`services/server/src/kobe-mcp/`): `service.ts` decides and executes in one
  request: `decideMcpCall` (now pluggable: `loadConnector`, `refuse`, `guard`) with the catalog as
  the built-in's "pinned" tools (`pinned.ts`, `custom` exposure over what the switches allow), then
  `execute.ts` runs the console route in process (`app.request`) as the person.
- **Delegation** (`delegation.ts`): `{userId, teamId, runId, threadId, toolCallId}` only in the Hono
  `env`, under a module-private `Symbol` (not `Symbol.for`), value frozen and registered in a
  module `WeakSet`. `requireSession` accepts it (re-reads deactivation, site role, 2FA requirement);
  `requireTeam` uses its team (membership re-checked; a different `x-kobe-team` is refused); the
  CSRF origin check skips it; `auditUserContext` records `via`. Unforgeable: over HTTP the Node
  adapter's env is `{incoming, outgoing}`; tests send every header/query/body claim to a real
  listener (401) and an in-process env with look-alike keys/values (401).
- **Rules** (`policy/kobe-admin-guard.ts`), applied after the engine at both enforcement points
  (sandbox `policy.check` and the proxy re-check): writes ask in every mode (allow reasons of
  Dangerous, remembered and team allow rules dropped), denied in `auto`; any admin tool denied in
  scheduled runs and skill evals. Never remembered (`approvals/decide.ts`, `remember-options.ts`),
  never in Approve all (`approve-all.ts`). New reason codes (protocol, append-only):
  `kobe_admin_write`, `kobe_admin_not_allowed`, `kobe_admin_rate_limited`.
- **Person check** (`person-guard.ts`, service `refuse`): permission (team/site role) and switches
  re-read per call; a member is never even asked to approve a change their role cannot make.
- **Before-state**: write inputs name `from_*`; the executor re-reads as the person after the
  approval was consumed and refuses `changed_since_approval`.
- **Limits** (`limits.ts`): 60 admin reads/min, 30 admin writes/h per person (site settings
  `kobe_mcp.reads_per_minute`, `kobe_mcp.writes_per_hour`), counted from the person's allowed
  `mcp.tool_call` rows of the built-in (works across replicas); refusals audited through the
  existing denied-call throttle.
- **Listing**: catalog filtered by site switch, team level (`teams.settings.kobe_mcp.admin`), the
  person's permission, and only for sandboxes with an answerable run (not scheduled/eval).
- **Run wiring** (`kobe-mcp/run.ts`, `runs/agents.ts`): `run.start.mcp` gets the `kobe` server when
  the agent names `kobe` or `all`, the run is user-started (not eval/test chat), the owner did not
  turn it off, and the person has at least one tool; never a "connect it" omission.
- **Registry**: the built-in row is hidden from the site registry (list/get/edit/probe/pin/remove),
  the team connector list/enable and the gallery picker; refresh already skips it (no hash).
- **Sample tools**: `team_members_list` (page permission `team.members.manage`, paged ≤50),
  `team_members_set_role` (`{user_id, from_role, to_role}` → PATCH `/v1/team/members/:id`).
- Seed wired into `seedAtStart` (logs the `kobe-builtin` fallback).

## Decisions / deviations

- Catalog lives in `services/server/src/kobe-mcp/` (not `packages/protocol/src/kobe-mcp/`): it
  binds routes, permissions and before-state readers (server types); moving the declarative half to
  protocol is a contract change for its own PR (KA-6 needs names only). Only the fixed id and the
  reason codes went into protocol.
- Contract test: tools whose console page is stricter than their route (reads: page
  `team.members.manage`, route `team.members.read`) assert the route refuses outsiders and the Kobe
  layer refuses the member; writes assert the route itself answers 403 to a member.
- Summary line for the card is built from the input (ids, role labels); names are KA-6's.
- `openapi.json` regenerated (the three new reason codes appear in the policy enums).

## For KA-7 (guide pages to update for this ticket; `docs/guide` not on this branch)

- `for-agents/working-in-a-sandbox.md`, `concepts.md`: the `kobe` connector, admin tools act as
  the person, writes always ask, never retry a refused/denied admin write, `changed_since_approval`.
- `admin/admin-from-a-conversation.md` (new): switches, card, limits (60/min, 30/h), audit via agent.
- `admin/team-admin.md`, `admin/site-admin.md`, `connectors-and-apps.md`: built-in connector not
  in the registry, its levels; `internet-and-approvals`: admin approvals never remembered or bulk.
- `reference`: `target.viaAgent` on audit events; reason codes `kobe_admin_*`.

## Security review fixes

- M1: a delegation needs its run active, in its thread, owned by the person, and a session of the
  person that was live when the run started still live (`kobe-mcp/delegation-live.ts`). Deviation:
  the starting session id is not recorded on the run (that needs a migration, which lands alone);
  signing out everywhere stops the tools, signing out one device while an older session lives
  does not.
- L2: `kobe-mcp/session-contract.test.ts`: no catalog route module (or its direct imports) reads
  `sessionId`, the active-team pointer or the session tables.
- L3: writes carry the approved before-state as a route condition (`expectedRole` on PATCH
  `/team/members/:id`, 409 `changed_since_approval` under the row lock); the convention is in
  `catalog.ts` `BeforeState` for KA-4/KA-5.
- L4: a target who left is `not_a_member`; policy.check validates admin input against the tool's
  strict schema before any approval card.
- L5: the limit count and the decision's audit row run under a per-person advisory lock
  (`withKobePersonLock`, try-and-retry); `/kobe/list` is rate limited like `/kobe/calls`.

## Open risks

- Agent publish/manifest checks do not know `kobe` yet (an agent naming it may get a warning);
  thread "connectors off" lists no Kobe row yet (KA-6).
- Limits count allowed decisions, including writes that then failed (`changed_since_approval`).

## Evidence

- ac-1..ac-6: `services/server/src/kobe-mcp.db.test.ts` (16 tests, real proxy ↔ internal listener).
- Units: `policy/kobe-admin-guard.test.ts`, `kobe-mcp/{delegation,catalog}.test.ts`; proxy
  `services/mcp-proxy/src/mcp.test.ts` (built-in route, 4 tests).
