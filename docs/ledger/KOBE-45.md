# KOBE-45: Agent definitions: markdown schema, scopes, CRUD, import/export

- **Status:** in review (PR #17)
- **Branch / worktree:** `kobe-45-agent-definitions` in `../Kobe-wt45`
- **Depends on:** KOBE-14 (merged)

## Acceptance criteria (derived from spec D6, D8, D9, D19, D22, §5.4, §6.1, §6.3; Hadron unreachable)

- **ac-1 Agent file.** One markdown file per agent: YAML frontmatter (`name`, `role`, `description`,
  `icon`, `model`, `skills[]`, `connectors[]`, `tools.allow/deny`, `approval_mode`, `starters[]`)
  plus body (system prompt), exactly the §6.3 shape. Strict schema (unknown keys rejected), size
  limits, safe YAML (no aliases/anchors/tags, duplicate keys refused). Parsing is pure and shared by
  server and web.
- **ac-2 Round trip.** Import → export → import yields the same definition, and the export is
  canonical (byte-identical on re-export).
- **ac-3 Scopes.** Personal (follow the user install-wide, usable in any of their teams), team
  (Builders/Team admins, behind team RLS), gallery (install-wide, admin-curated, read-only to teams;
  teams fork).
- **ac-4 CRUD + import/export API** (`CRUD /v1/agents`, `/v1/install/gallery`), JSON or file.
- **ac-5 Authorization** per D8: members use team agents and own personal agents; builders create
  team agents; team admins manage/suspend team agents; install admins curate the gallery; install
  roles grant nothing in teams.
- **ac-6 Isolation.** No team's agents are visible or changeable from another team; personal agents
  are private to their owner. New team table follows the RLS pattern; probe suite and catalog
  check green.
- **ac-7 Seams for KOBE-46** (versions, publish, pinning): draft row with `current_version`,
  `status`; thread FK decision recorded.

## Decisions

1. **The spec's `agents(team_id?, …)` is split in two tables**, because a team table's `team_id` is
   NOT NULL (D5) and personal/gallery agents have no team:
   - `team_agents` — team table: PK `(team_id, id)`, `UNIQUE (team_id, slug)`, ENABLE + FORCE RLS
     with the canonical policy (`0008_agents_rls.sql`), probe fixture.
   - `install_agents` — install-wide, `scope personal|gallery`; `owner_user_id` set iff personal
     (check); partial unique slugs per owner (personal) and install-wide (gallery). App role gets
     full DML (no cascades into team data, no team FK). The server pins every query to the scope
     and, for personal agents, to the owner.
     Not three tables: personal and gallery rows are identical apart from the owner, and KOBE-46 then
     needs one install-wide versions table instead of two.
2. **A row is the agent's editable draft** (`frontmatter jsonb` = the file's YAML as JSON, `prompt`
   text). `current_version` (null until first publish) and `status active|suspended` are there for
   KOBE-46/48. `revision` (+1 per edit) is the ETag; `PUT` **requires** `If-Match` (428 without it, 400 if
   malformed, 412 on mismatch; `*` is an explicit overwrite), so concurrent editors can't silently
   lose each other's changes.
3. **Agent-file parsing lives in a new package `@kobe/agent-file`** (pure, browser-safe: no
   node APIs, `types: []`), depending on `yaml` (ISC, already in the lockfile) and `zod`. Not in `@kobe/protocol` (contracts change only in their own PR); it depends on it.
   - YAML 1.2 core schema; anchors, aliases, explicit tags, duplicate and non-string keys, `<<`
     merge (unknown key) and parser warnings are all refused. File ≤ 128 KiB (checked before
     parsing), frontmatter ≤ 16 KiB, prompt ≤ 100 KiB (UTF-8), C0 controls other than tab/newline
     refused anywhere (Postgres text can't store NUL). Per-field limits in `AGENT_FILE_LIMITS`.
   - Canonical export: keys in schema order, block style, no line folding, `---\n<yaml>---\n<prompt>\n`.
     Prompt normalization: CRLF→LF, leading blank lines and trailing whitespace dropped.
   - Field formats reuse the merged contracts (`@kobe/protocol`, PR #13): `connectors` are
     `connectorNameSchema` registry names, `tools.allow/deny` are `globSchema` policy globs (plus
     single-line), `approval_mode` is `approvalModeSchema` (`ask-on-write|ask-all|auto`, no bypass).
     `icon` is an icon name or emoji, never a URL; `model` an alias/id; `skills` are lowercase
     SKILL.md-style slugs (`skillSlugSchema`).
   - **`skills` has three forms (D22):** `[a, b]` (union with the user's enabled skills),
     `{ exclusive: [a, b] }` (only these), and `exclusive` (shorthand for `{ exclusive: [] }`).
     `agentSkills()` gives KOBE-47/49 `{ names, exclusive }`.
   - `name` is the only required key (role/description optional; KOBE-51 maps a missing role).
4. **Endpoints** (all under the session; `/v1/agents` also needs the active team, and
   `X-Kobe-Team` on changes):
   - `GET /v1/agents[?scope=team|personal|gallery]` — summaries (name, description, icon,
     starters, status, owner, revision, `canEdit`).
   - `POST /v1/agents` — JSON `{scope, slug?, frontmatter, prompt}` or **import**: the file as
     `text/markdown` (or `text/plain`) with `?scope=&slug=`. Slug defaults to one derived from the
     name, suffixed `-2`, `-3`… on collision; an explicit taken slug is 409. Slugs are immutable.
   - `GET /v1/agents/{id}`, `PUT /v1/agents/{id}` (JSON or file; `If-Match`), `DELETE`,
     `GET /v1/agents/{id}/export` (`text/markdown`, `attachment; filename="<slug>.md"`),
     `POST /v1/agents/{id}/fork {scope, slug?}`, `PUT /v1/agents/{id}/status {status}`.
   - `/v1/install/gallery/agents` (install.gallery.manage): list, create/import, get, put, delete,
     export, status. No team involved.
   - Bodies capped at 512 KiB (413) before parsing; other content types 415.
5. **Authorization** (`services/server/src/agents/access.ts`, one rulebook):
   - Team agents: every member sees the summary (`team.agents.use`); **only builders+ read the
     prompt and export** (`team.agents.build`); builders create; the creator edits/deletes, team
     admins edit/delete any (`team.agents.manage`, mirroring D23 for projects); team admins suspend
     (`team.agents.suspend`). New permissions: `team.agents.build` (builder), `team.agents.manage`
     (team_admin); `team.agents.publish` stays for KOBE-46.
   - Personal agents: owner only, in whichever team is active; anyone else gets 404 (no oracle).
   - Gallery: every member reads and exports; nobody edits from a team; install admins curate.
   - **Fork:** any agent the caller can read into a scope they can create in, **except team →
     personal**: personal agents follow the user into other teams (D9), so that copy would carry
     team content across the wall. Export stays a deliberate human act.
   - Suspended agents remain listed (with status) and editable; refusing to run them is KOBE-47.
6. **No FK from `threads (agent_id, agent_version)` yet** — deferred to KOBE-46 on purpose. The pin
   targets a _version_, which doesn't exist yet, and an agent id now lives in one of two tables.
   Recommendation for KOBE-46:
   - versions: team table `team_agent_versions (team_id, agent_id, version, …)` FK
     `(team_id, agent_id) → team_agents (team_id, id)`, and install-wide
     `install_agent_versions (agent_id, version, …)` FK → `install_agents`;
   - threads: add `agent_scope` and two generated columns, e.g.
     `team_agent_id = CASE WHEN agent_scope = 'team' THEN agent_id END` (and `install_agent_id`),
     then FKs `(team_id, team_agent_id, agent_version) → team_agent_versions` and
     `(install_agent_id, agent_version) → install_agent_versions` (MATCH SIMPLE skips the other
     one). FKs NO ACTION, so a pinned version can't be deleted; deleting a published agent should
     become archive (status) rather than a hard delete.
   - Until then `DELETE` is a hard delete of a draft-only agent.
7. **Caps instead of pagination:** 500 team agents per team, 100 personal per user, 100 gallery
   (409 `limit_reached`). Creates take a transaction-scoped advisory lock per location (team, owner,
   or gallery), so the cap and the auto-picked slug (`name` → `name-2` …) never race.
8. Shared test helpers: `testing/browser.ts` gained `RawBody` (raw content-type bodies), response
   `headers`/`text`, and a headers argument on `put`; `testing/app-sessions.ts` holds
   `waitForAppSessionsToClose` (teams.db.test keeps its own copy for now).

9. **Security review (subagent), all fixed:** lone UTF-16 surrogates are refused like control
   characters (Postgres jsonb rejects them: was a 500); `If-Match` required on PUT; creates
   serialized per location (caps and auto slugs were racy); malformed `If-Match` is 400. Noted, not
   changed: suspended agents stay listed (KOBE-47 must refuse to start them).

## Seams for downstream tickets

- **KOBE-46:** decision 6 (versions tables, thread FK); publish copies the draft
  (`frontmatter`, `prompt`) into a version with a frozen tool manifest and sets `current_version`;
  use `team.agents.publish`. The `revision` ETag is for drafts only.
- **KOBE-47:** resolve `threads.agent_id` via `findVisibleAgent` semantics (team → own personal →
  gallery); refuse `status = suspended`; `agentSkills()`; model/approval mode intersections.
- **KOBE-48:** `@kobe/agent-file` is browser-safe for the builder (validate before save, show
  `issues[].path`); `canEdit` and `ETag`/`If-Match` for concurrent editors; inventory reads
  `status`, `ownerUserId`, `currentVersion`.
- **KOBE-49:** skill references use `skillSlugSchema` (same format as SKILL.md names).
- **KOBE-50:** gallery agents are created through `/v1/install/gallery/agents` (or seeded rows in
  `install_agents` with `scope = 'gallery'`).
- **KOBE-15 (audit):** agent create/update/delete/status/fork are not audited yet; hook the route
  handlers in `routes/agents.ts` and `routes/install-gallery.ts`.

## Open questions (for Chris or the coordinator)

- **Members can't read team agents' prompts** (summary only; builders+ see definitions). The spec is
  silent; chosen as least privilege. Flip `readDefinition` in `access.ts` if members should see them.
- **Builders edit only their own team agents**; team admins edit all (mirrors projects, D23). The
  spec could also be read as "any builder edits any team agent".
- `skills: exclusive` syntax (D22) is underspecified; the three-form reading above is a choice.
- Should install admins be able to see or suspend personal agents? Not in D8; not done.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2: `packages/agent-file/src/agent-file.test.ts` (57 tests: §6.3 example, 9 round-trip
  cases incl. CRLF/BOM/unicode/delimiters in body, canonical key order, schema rejections, unsafe
  YAML, size limits, JSON validation).
- ac-3, ac-6 (DB): `packages/db/src/agents.db.test.ts` (slug per team, RLS invisibility and
  WITH CHECK, backstop checks, personal/gallery owner rule and slug uniqueness); catalog check and
  probe suite cover `team_agents` (`pnpm --filter @kobe/db test:db` 137/137).
- ac-4, ac-5, ac-6 (HTTP): `services/server/src/agents.db.test.ts` (29 tests: create per role,
  header guard, slugs, invalid definitions, import → export → re-import through the API, PUT from a
  file, unsafe files, 413/415, member summary vs builder definition, creator/admin edit, If-Match,
  suspend, delete, cross-team 404s incl. a member of both teams, stale tab 409, personal privacy
  and following across teams, gallery curation/read-only/fork, no team→personal fork);
  `src/agents/access.test.ts` (rulebook per role and scope); `src/authz/permissions.test.ts`.
- ac-7: decision 6; schema columns `current_version`, `status`, `revision`.
- `pnpm build test typecheck format:check license:check` green; `lint` green except pre-existing
  `@kobe/chart` (Helm 4); `pnpm --filter @kobe/server test:db` 79/79; `db:check` clean.
