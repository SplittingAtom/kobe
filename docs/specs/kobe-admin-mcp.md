# Kobe — Admin and docs from the conversation (Kobe MCP server)

Status: **decisions KA1–KA8 by Chris 2026-11-11 (§10); ready for tickets** (KA-1..KA-7 in §11). Hadron spec `aebf89f6`; tickets KA-1 KOBE-618, KA-2 KOBE-619, KA-3 KOBE-620, KA-4 KOBE-621, KA-5 KOBE-622, KA-6 KOBE-623, KA-7 KOBE-624. Requested by Chris, 2026-11-11. Written against main `435cdb67`, with the
user guide of branch `kobe-docs` (PR #526, KOBE-616/617) assumed merged.

Request (Chris, 2026-11-11): "I want to create an MCP server for Kobe that will allow an agent in a
conversation with a user do administrator actions on the system. I also want a skill that is
available that points the agent at the docs in the llmtxt file that is available for the agent."

## 1. Today

- **Connectors.** Site admins register remote Streamable HTTP servers in `connectors` (site table,
  `packages/db/src/schema/connectors.ts`): `auth_kind` (`none`, `oauth`, `api_key`),
  `credential_source` (`member` or `site`, KOBE-303), a pinned `tools_snapshot` with drift
  detection (KOBE-59, KOBE-431). Team admins enable one per team in `team_connectors` with an
  exposure (`read_only` = tools with `readOnlyHint: true`, `all`, `custom`). Agents name connectors
  (`connectors: all` in the gallery agent Kobe, `services/server/src/gallery/agents/kobe.ts`) and
  a thread can switch connectors off (`run-context.ts`, `connectors_off`).
- **The path of a call.** Pi in the sandbox talks only to `services/mcp-proxy`
  (`POST /v1/mcp/{connector_id}`, stateless, `src/mcp.ts`) with the sandbox's `kobe.mcp-proxy`
  session token. Before every `tools/call` the proxy asks the server
  (`POST /internal/v1/mcp/connectors/:id/calls`, internal key, `routes/internal.ts`). The server
  re-establishes the principal (`mcp/principal.ts`: token, sandbox live for (team, user), account
  active, still a member), checks the run leased to that sandbox and the thread, runs the policy
  engine with `enforcement_point: "mcp_proxy"` and, when the call needs approval, verifies and
  consumes the approval signed over (run_id, tool_call_id, canonical input)
  (`mcp/decide.ts`, `approvals/keys.ts`); it audits `mcp.tool_call`. The proxy then forwards
  exactly the decided bytes upstream and attaches the credential itself (`credentials.ts`): no
  secret ever enters the sandbox. `tools/list` comes from the pinned snapshot, never the live
  upstream; resources and prompts are not offered (method not found).
- **Approvals.** Modes `auto` < `ask-on-write` < `ask-all` with a site floor
  (`policy/approval-floor.ts`); approvals can be remembered (`approvals/remember-options.ts`) or
  approved in bulk (`approve-all.ts`), except where a guard forbids it: the viewed-file guard
  (KOBE-493, `policy/viewed-file-guard.ts`) asks in every mode, Dangerous included, and is never
  remembered or bulk-approved. Scheduled runs execute in `auto`: anything that would ask is denied.
- **Run-less calls.** Member-started model calls without a run (KOBE-564, `skill_manifest`) have no
  tools; every tool call belongs to a run.
- **Consoles.** `/admin/team/*` and `/admin/site/*` call `/v1/team/*` and `/v1/site/*` (mounted in
  `services/server/src/app.ts`). Each route is guarded by `requireSession` (live Better Auth
  session, deactivation and site role re-read per request), `requireTeam` (the session's active
  team, membership re-checked, `x-kobe-team` required on changes) and `requireTeamPermission` /
  `requireSitePermission` over the fixed matrix in `authz/permissions.ts` (`team.members.manage`,
  `team.connectors.manage`, `team.egress.manage`, `team.memory.manage`, `team.audit.read`,
  `site.users.manage`, `site.models.manage`, `site.egress.manage`, `site.settings.manage`, …) plus
  `skillReviewAllows` for the Skill reviewer grant. Some reads filter by permission inside the
  handler (team egress hides header names from non-managers). Site roles grant no team permission:
  site admins reach team content only through break-glass.
- **Audit.** `recordAudit()` writes the hash-chained `audit_log` (actor kind `user|agent|system`,
  allowlisted `target` per action, `packages/db/src/audit/events.ts`), attributed from the request's
  `RequestAuditContext` (`audit/context.ts`).
- **Guide.** PR #526 builds `docs/guide/**` into the web bundle (`apps/web/lib/docs/guide-loader.ts`
  → `guide.generated.ts`) and serves `/llms.txt`, `/llms-full.txt` and `/docs/<slug>.md`
  (`apps/web/lib/docs/llms.ts`). The page "How AI agents should read these docs"
  (`docs/guide/for-agents/reading-the-docs.md`) tells an in-sandbox agent these work only if the
  team allowlisted Kobe's own host in egress.
- **Kobe's own skills** live in `services/server/builtin-skills/<name>/` (`KOBE_SKILL_NAMES` in
  `packages/protocol/src/skill-catalog.ts`); `skills/kobe-seed.ts` publishes them at every start as
  approved catalog versions by `by_kobe`, tags a new one Default and queues a Default sync, so every
  team gets it (On by default).

## 2. Proposal in one paragraph

Kobe ships a **built-in connector `kobe`**, hosted by the server itself and reached like every other
connector through the MCP proxy, so the sandbox gets no new address, secret or egress rule. Its
tools are of two kinds: **docs tools** (the llms.txt index, one page, the full text, a search) open
to everyone, and **admin tools**, one per Team console and Site console action, each gated by the
console page's own permission and executed by dispatching **in process to the console's own route**
with a delegated principal: the person who started the run, in the run's team, with exactly their
role and grants (KA1). Reads run freely; every write asks in the conversation, in every approval
mode, with a card that shows the exact change (before → after) and is signed like every other
approval (KA2). Audit records the person "via agent" with thread, run and tool call. A Kobe skill,
`kobe-guide`, tells agents to start from the docs index via the Kobe connector for any question
about using or administering Kobe (KA4).

## 3. Identity and transport (recommended: server-hosted, no token)

Two designs were considered for carrying "this person in this run" without a secret in the sandbox:

- **(a) Run-scoped token.** The server mints a short-lived token bound to (team, user, run), the
  proxy attaches it to calls to the public `/v1` API. It works, but adds a bearer credential that
  reaches the full API surface, needs its own revocation table and a second authentication path
  exposed on the public listener.
- **(b) Server-hosted endpoint (recommended).** The proxy routes the built-in connector to the
  server's internal listener, `POST /internal/v1/mcp/kobe/{list,calls}` (internal key, the same
  NetworkPolicy path the proxy already uses for decisions). The server **decides and executes in one
  request**: it authenticates the sandbox token (`authenticateSandbox`), resolves the run leased to
  the sandbox for the claimed thread, runs the existing decision (`decideMcpCall`, approval verified
  and consumed), then executes. Nothing is minted, nothing new is exposed, the principal is
  re-derived from server state on every call, and the decision and the execution cannot be split
  apart by a replay.

**Execution through the console's route.** Each admin tool names one console route
(`{method, path, body}`); the executor calls the API router in process (`app.request(...)`) with a
**delegation** in the Hono `env` (never a header, so nothing on the wire can claim it):
`{userId, teamId, runId, threadId, toolCallId}`. `requireSession` accepts a delegation in place of a
session (re-reading deactivation, site role and the 2FA requirement as today); `requireTeam` uses the
delegation's team (membership re-checked, the team header implied); the permission middlewares and
handlers run unchanged. So a tool can do nothing its route would refuse to the person in the browser,
and there is one implementation of each admin action (KA3). Responses are reduced to the tool's
output schema before they reach the model.

**Who the person is.** The run's user: the thread's owner (`threads.owner_user_id`), who is also
the sandbox token's `user_id` (`decideMcpCall` already requires the thread to be the token user's),
never a teammate viewing a shared thread. Delegation exists only while the run is active and leased to the calling sandbox; scheduled runs,
skill-eval sandboxes (`evalThreadId`) and test chats get the docs tools only.

**Listing.** `tools/list` for `kobe` is computed by the server from the tool catalog (code, shipped
with the release, hashed; no pinning or drift: a Kobe upgrade is the review) filtered by the
person's current permissions, the team's setting (§6) and the site switch. Calls re-check all of it.

## 4. Docs tools (KA4)

- `docs_index`: the llms.txt text; `docs_page {slug}`: one page as `/docs/<slug>.md` serves it;
  `docs_full {section?}`: the full text, optionally one section, capped (the model's context);
  `docs_search {query}`: titles, summaries and headings matching, with slugs. All read-only, no team
  or user data, allowed in every mode (including `auto`).
- **Content.** The guide build moves from `apps/web/lib/docs` into a package (`packages/guide`:
  loader, generated pages, `llmsTxt`/`pageMarkdown`), used by the web routes and the server, so both
  serve identical bytes from the same release without a server → web call. Links keep the public
  origin (site URL) so a person can open them.
- **MCP resources** (`kobe://docs/<slug>`) are not offered in v1: the proxy answers resources with
  method not found and Pi uses tools; listed as a follow-up.

## 5. Admin tools (KA3)

- **Catalog** (`packages/protocol/src/kobe-mcp/`): per tool `name`, description, zod input/output
  schema, `read_only`, `scope` (`team` | `site`), the permission (or Skill Registry action) of its
  console page, and the route. A contract test calls each route without the permission and asserts
  403, so tool and route cannot drift. Names are `<area>_<verb>`, e.g. `mcp__kobe__team_members_list`.
- **Team (v1):** members (list, change role, remove), invites (list, create, revoke), connectors
  (list, enable/disable, exposure), skills (installs, review queue, approve/request changes), models
  and budgets (read, set), memory switches, egress (domains, requests, decide), agents roster
  (list, suspend/resume, transfer), schedules (list, pause), usage and audit (read, paged).
- **Site (v1):** users (list, deactivate/reactivate), teams (list, create), site invites, models and
  catalog, connectors (list, enable/disable; registering a URL stays in the console because it needs
  a probe with the admin's key), egress ceiling and requests, skill registry review and blocklist,
  branding and appearance settings, budgets, usage and audit (read, paged), Skill reviewer grants.
- **Writes carry their before-state.** A write's input names the target and both values
  (`{user_id, from_role: "member", to_role: "team_admin"}`). The signed approval covers the
  before-state, and the executor refuses with `changed_since_approval` when the current value
  differs, so what the person approved is exactly what happens.
- **Results** are compact JSON (ids, names, states), paged (`cursor`, max 50 rows), at most 64 KiB;
  audit reads never return IP or user agent.

## 6. Switches, approvals and limits

- **Site switch** (Site console › Settings, `site.settings.manage`): `kobe_mcp.mode` = `off` (no
  `kobe` connector), `docs` (docs tools only; the default after upgrade, KA5), `admin` (docs plus admin
  tools per team). Stored in `site_settings`; the seeded `connectors` row follows it.
- **Team switch** (Team console › Connectors, `team.connectors.manage`): the built-in connector shows
  as **Kobe** with `docs only` (default, KA5), `read` or `read and write`. Its value lives in
  `teams.settings` (`kobe_mcp.admin`), not `team_connectors`, so it needs no enabling admin row.
- **Writes always ask.** A Kobe admin write is decided like the viewed-file guard: ask in every mode
  (Dangerous included); never remembered, never in "Approve all waiting"; denied where nobody can be
  asked (`auto`, scheduled, eval). Only the run's user can approve (as today).
- **The card** shows "Admin change", the scope ("Team Research" or "Whole site"), and a server-built
  summary from the input (`Change Ana Lee's role: Member → Team admin`) above the exact input. The
  summary is rendered from the input, never from model text.
- **Limits.** The proxy's per-sandbox token bucket applies. The server adds per person: 60 admin
  reads per minute and 30 admin writes per hour (site settings), refusals audited through the
  existing throttle (`approvals/throttle.ts`).

## 7. Audit

- Every executed admin write records the console's own event (`identity.member.role_changed`, …)
  with actor kind `user` = the person, plus `via: {kind: "agent", thread_id, run_id, tool_call_id}`
  from the delegation in `RequestAuditContext`; `recordAudit` accepts `via` on every action
  (allowlisted, bounded). The decision itself is `mcp.tool_call` as today.
- Team and Site audit views show "Ana Lee via agent" with a link to the thread (for viewers who may
  read it).
- Admin reads are not audited per row beyond `mcp.tool_call` (as console reads are not).

## 8. Permissions, privacy and threat model

- **Never more than the person.** The route and its middleware decide; a tool hidden from
  `tools/list` is refused on call too. Role changes and removal apply to the very next call.
- **Read results stay inside the person's reach, but the thread may travel.** Results enter the
  thread's entries and the model provider. So: no secrets ever (header values, keys: the routes
  already never return them), no IP/UA, and a thread containing Kobe admin results is shared with
  those results **redacted** for viewers other than the run's user ("Admin result hidden").
  Telemetry keeps `captureContent: false` as configured.
- **Prompt injection.** Untrusted content (files, web pages, connector results, a teammate's message)
  can steer the agent into asking for an admin write. Mitigations: every write asks with the exact
  change and its scope; no remember; no auto or scheduled writes; the site and team switches
  default to docs only (KA5); the site switch can turn admin tools off; per-person write limits; audit "via agent".
  Reads are allowed freely, so injection can make the agent _read_ what the person may read; the
  redaction above keeps it from leaking through sharing, and no admin tool sends data out (no
  email/webhook tools in v1).
- **Cross-team.** Team tools act on the run's team only; the delegation cannot name another team.
  Site tools need the site permission and never open team content (break-glass excluded).
- **No bypass.** Nothing in the delegation path skips the approval check; the executor runs only
  after `decide` returned `allow` for exactly this run, tool call and input.

## 9. Out of scope

Break-glass, ownership transfer, site roles, legal hold, retention and deletion, backups, audit
forwarding, isolation settings and registering new connectors (high-consequence or two-person
actions stay in the consoles); MCP resources and prompts; app cards (MCP Apps) for admin results
(possible later: Kobe-shipped `ui://` templates for tables); admin tools in scheduled runs; an
external MCP endpoint for clients outside Kobe (KOBE-526 territory).

## 10. Decisions (Chris, 2026-11-11) and open questions

- **KA1. Authority = the person.** The agent acts as the person in the conversation with exactly
  their permissions (team role, site role, grants such as Skill reviewer), never more. Audit records
  the person "via agent" with thread, run and tool call.
- **KA2. Reads free, writes approved.** Reads run freely; every write shows an approval card first,
  HMAC-signed over (run_id, tool_call_id, canonical input); no bypass and no "remember" for admin
  writes.
- **KA3. Scope v1 = the consoles.** Team console and Site console actions the person can open, each
  tool gated by its console page's permission and calling the same server code path.
- **KA4. Docs via the Kobe MCP.** The Kobe MCP server exposes the user guide (index, page, full text)
  so no egress change is needed; a Kobe-shipped skill available to every team points agents at the
  llms.txt index via the Kobe MCP for questions about using or administering Kobe.

- **KA5. Off until enabled.** After an upgrade the admin tools are off: the site switch
  (`kobe_mcp.mode`) starts at `docs`; a site admin turns admin tools on for the site, then each team
  admin turns them on for the team. The docs tools are on everywhere.
- **KA6. Shared threads hide admin results.** A teammate viewing a shared thread sees that an admin
  tool ran and its summary line; the tool's output is shown only to viewers holding the same
  permission ("Admin result hidden" otherwise). Sharing such threads stays allowed.
- **KA7. Docs tools for every agent.** The docs tools attach to every run whatever the agent's
  connector list; admin tools follow the connector list (`kobe` or `all`).
- **KA8. Console-only in v1:** break-glass, ownership transfer, site roles, legal hold, retention and
  deletions. The agent may explain them and link to the console page but has no tool for them.

## 11. Tickets

Lane A: KA-1 → KA-2 → KA-4. Lane B (after KA-2): KA-3, KA-5. Then KA-6, KA-7 last.

- **KA-1 (db, migration alone).** `connectors.builtin text NULL` (`'kobe'`; builtin rows:
  `auth_kind none`, skipped by probe, pinning, refresh and drift; a check ties `builtin` to an internal URL),
  the seeded row (name `kobe`, or `kobe-builtin` when the name is taken, logged), site setting
  `kobe_mcp.mode`, audit `via` accepted on every action. AC: (1) migration up/down clean on a copy of
  a gate1-shaped database; (2) the seed is idempotent across replicas; (3) the cross-team probe suite
  stays green; (4) the audit chain verifies with `via` rows.
- **KA-2 (server, mcp-proxy): host, delegation, rules.** Proxy routes the built-in to
  `/internal/v1/mcp/kobe/{list,calls}`; decide-and-execute; delegation through `env` in
  `requireSession`/`requireTeam`; catalog framework and contract test; writes ask in every mode, no
  remember, no bulk, deny in `auto`/scheduled/eval; before-state check; limits; audit `via`; two
  sample tools (`team_members_list`, `team_members_set_role`). Opus. After KA-1. AC: (1) a member's
  sandbox lists no team-admin tool and a forged call is refused 403-equivalent; (2) a write without a
  verified approval is denied, with one runs once, a replay is denied; (3) Dangerous mode still asks;
  (4) a changed before-state returns `changed_since_approval`; (5) audit shows the person with `via`;
  (6) no new header or route on the public listener accepts a delegation (test).
- **KA-3 (packages/guide, server, skill): docs tools and `kobe-guide`.** Move the guide build to
  `packages/guide`; web routes unchanged in output (byte-equal test); `docs_index`, `docs_page`,
  `docs_full`, `docs_search`; `services/server/builtin-skills/kobe-guide/` added to
  `KOBE_SKILL_NAMES` and to the Kobe gallery agent's skills. After KA-2 and PR #526. AC: (1)
  `docs_index` equals `/llms.txt` for the same origin and branding; (2) unknown slugs are a tool
  error, no path traversal; (3) the seed publishes `kobe-guide` Default and it reaches every team;
  (4) docs tools work in `auto` and scheduled runs.
- **KA-4 (server): Team console tools.** The team list of §5, each with its route, permission,
  output schema and before-state. After KA-2. AC: (1) contract test covers every team tool; (2) each
  write's audit event is the console's own; (3) egress header names stay hidden from non-managers;
  (4) results paged and capped.
- **KA-5 (server): Site console tools.** The site list of §5, Skill reviewer grant via
  `skillReviewAllows`, team switch and site switch honoured. After KA-2. AC: (1) a team admin without
  a site role lists no site tool; (2) a Skill reviewer gets only the reviewer actions; (3) audit reads
  never include IP or user agent; (4) `kobe_mcp.mode = docs` hides every admin tool.
- **KA-6 (web).** Approval card "Admin change" with scope and summary, no remember and not in
  Approve all; Team console Connectors row for Kobe with its three levels; Site console Settings
  switch; audit "via agent" with thread link; shared-thread redaction of admin results. After KA-2,
  KA-4. AC: (1) the card shows the server summary and the exact input; (2) remember controls absent;
  (3) a teammate viewing a shared thread sees "Admin result hidden"; (4) switches round-trip.
- **KA-7: browser spec, docs, deploy.** Gate1 spec (team admin asks the agent to promote member2:
  card, approve, role changed, audit "via agent"; member asks the same: no tool, docs answer;
  `docs_index` answers a how-to without egress), guide updates (§12), gate1 deploy. Last.

## 12. Guide updates (CLAUDE.md: every change is evaluated for `docs/guide`)

- `for-agents/reading-the-docs.md`: start with the Kobe connector's `docs_index`/`docs_page`;
  `/llms.txt` over the network only as a fallback (egress no longer needed).
- `for-agents/working-in-a-sandbox.md` and `concepts.md`: the `kobe` connector, admin tools act as
  the person, writes always ask, never retry a refused or denied admin write.
- New `admin/admin-from-a-conversation.md` (audience admin): what can be done, the card, the
  switches, audit "via agent", what stays console-only.
- `admin/team-admin.md`, `admin/site-admin.md`, `connectors-and-apps.md`: the built-in Kobe
  connector and its levels; `internet-and-approvals`: admin approvals are never remembered.
- `reference`: the `via` field in audit events.
