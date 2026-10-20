# KOBE-451: Composer + menu: Attach files, Connectors, Memory, Skills, Apps

- **Status:** in review (group G11b, branch `group-11b-composer`, not pushed)
- **Decisions:** Chris 2026-10-20 (ticket note): the connector toggle is for this thread only
  (new threads start with every usable connector on); picking a skill forces it for the run
  (removable chip, server-checked); an Apps item lists the rail's apps and inserts the card
  exactly like a rail launch (KOBE-440 rules).

## Migrations (each alone in its commit)

- `0165_thread_connectors_off` (generated): `(team_id, thread_id, connector_id)` key; a row =
  off in that thread, no row = on. Cascades with the thread (composite FK), connector and team;
  `turned_off_by` set null. No legal-hold guard: a setting, not content (a held thread is never
  purged, so its rows stay).
- `0166_thread_connectors_off_rls` (custom): ENABLE + FORCE RLS, canonical team policy.
- Tenancy: `connectors` area; probe fixture `thread_connectors_off`; upgrade test
  `packages/db/src/thread-connectors-off-upgrade.db.test.ts`.

## Server (for the Opus review)

- `connectors/thread-connectors.ts`, `routes/thread-connectors.ts`:
  - GET `/v1/threads/connectors` (new conversation, all on) and `/v1/threads/{id}/connectors`
    (owner only, 404 otherwise). The list uses the run's own rules (`loadTeamConnectorRows`,
    the grants, `loadUsableSiteKeys` = KOBE-449 `usableSiteKeyIds`). A connector with nothing
    exposed and nothing drifted is not listed.
  - Problems, in fixed words with a fix link where the member can fix it: `no_key`,
    `not_connected`, `grant_expired` (→ /me/connectors), `site_key_unusable`,
    `refresh_auth_required`, `tools_awaiting_approval` (nothing exposed, some drifted).
    "Proxy unreachable" isn't shown: the server has no per-member health probe.
  - PUT `/v1/threads/{id}/connectors/{connector_id}` `{enabled}`: owner's live, non-test thread
    (locked), a connector in the member's list (404), working now (409). Audited
    `thread.connector_toggled` only on a change.
  - Run start (`runs/agents.ts`): off connectors leave `connectedConnectors`, so they never reach
    `run.start.mcp`. Forks start fresh (no rows copied).
- Skills (`runs/effective-skills.ts`, `routes/thread-skills.ts`):
  - GET `/v1/threads/skills[?agent_id=]` and `/v1/threads/{id}/skills`: the run-start resolver's
    own effective set (`deps.runAgents.resolve`, read-only), so list and check agree.
  - Submit: `skill` (protocol field) must be in that set, else 422 `skill_not_available`.
    Otherwise the server writes the fixed line `Use the skill "<name>" for this message: read
its SKILL.md first and follow it.` before the member's text (after any app context).
  - Run start (`resolveForStart`): the set is checked again; a skill gone meanwhile fails the run
    `skill_not_available`, with its own message.
  - Member text imitating the line is refused (`invalid_content`) on send, steer and edit. An
    edit of a queued message keeps its skill. Titles, cards and eval cases drop the line.
  - Why a line and not Pi's `/skill:name`: Pi expands that into the whole SKILL.md as the user's
    message, which would then show in history; the line reads well and the chat shows a chip.
- Protocol (own commit, additive): `submitMessageBodySchema.skill`, `skill-request.ts`.
  OpenAPI regenerated.

## Web

- `components/chat/plus-menu.tsx` (+ `plus-connectors.tsx`, `plus-skills.tsx`): Radix menu
  button, opens upward; replaces the attach icon (drag and drop unchanged). Registry: new
  `plus-menu` command (`commands.ts`, shared file: one entry + `PlusIcon` import).
- Connectors: checkbox items (`menuitemcheckbox`), the menu stays open while toggling; broken
  ones show a red ✕ ("Not working"), the reason and the fix link; no toggle. A new
  conversation lists them all on, disabled, with a note (the toggle needs a thread).
- Memory: disabled, "Coming soon". Skills: list (filter from 7), chip `SkillPickChip`, sent as
  `skill` and cleared on success; history shows `data-kobe-sent-skill`.
- Apps: `useRailApps` (read only) + `components/apps/use-app-launch.ts`, the rail's launch rules
  without its drawer handling. `rail-apps.tsx` (g11a's area) is not touched.

## Review fixes (security and DB review: 1 HIGH, 2 MEDIUM, 5 LOW)

- HIGH-1: migration `0167_runs_mcp_connector_ids` (generated, nullable, own commit, upgrade
  test). Each run records its `run.start.mcp` connector ids at start and on a recovery restart.
  `decideMcpCall` denies and audits `connector_not_in_run` (new protocol reason, own commit) for
  a connector outside the named run's set or off in its thread now (mid-run off applies at
  once); tools/list (`mcp.list_refused`) and the grant reveal (`not_available`) serve only a
  connector of some active run of the sandbox. Covers agent connector lists too.
  Rolling upgrade: a run started by an older replica (or before 0167) has null ids and is
  checked against its thread's off set only. The proxy treats decision codes as opaque, so an
  older proxy passes the new code; the internal API is unchanged. Tests that listed or revealed
  without any run now lease one (`activeSandbox` in `testing/mcp-fixtures.ts`).
- MEDIUM-2: the projection takes the skill line out of a user message (`meta.skill`); regenerate
  sends the same skill, edit keeps it as a removable chip in the edit box; the server re-checks.
- MEDIUM-3: `POST /v1/threads` `connectors_off` (checked like the toggle, 422 otherwise, refused
  for test chats, audited per connector, same transaction). Web: `DraftConnectorStore`, taken by
  the thread's creation (given back if it is refused). App launches don't carry it.
- LOW-4: an off connector is no `not_user_connected` omission. LOW-5 (taken strictly): a launch
  into a thread with the app's connector off is refused (409 `connector_off`), app context from
  it too, and the + menu hides such apps; calls from an already open app frame are team-level
  (no thread) and unchanged. LOW-6: tests for another team's thread, forged `enabled: true`, and
  skills of another team, a teammate and a draft. LOW-7: schedule prompts imitating the skill
  line or app context are refused. LOW-8: follow-up for the coordinator to file: after G11a and
  G11b merge, `rail-apps.tsx` uses `useAppLaunch` (one launch rule).
- 450 LOW: the `/export` fetch reports a body that fails part way.
- Re-review (2026-10-20, all closed; LOW-5 strict confirmed). R-1 accepted as a residual risk
  (coordinator): a run's code naming another of the member's running threads in the sandbox gets
  that run's connectors; recorded in `docs/specs/mcp-apps-host.md` §3, on Chris's gate list.
  R-2: the null-list rollout fallback is to be removed next release (`docs/install.md`).

## Evidence

- ac-1: `components/chat/plus-menu.test.tsx` (items, Memory disabled, Attach opens the picker,
  keyboard open/Escape/focus); composer tests updated for the + button.
- ac-2/ac-3/ac-6: server `thread-connectors.db.test.ts` (exact list and problems, toggle → next
  run's MCP set, this thread only and a new thread on, forged toggles refused, no URL/secret in
  the list); web plus-menu tests (toggle PUT, broken row, draft).
- ac-4: `thread-skills.db.test.ts` (list, submit refusal, line in run.start, run-start recheck
  after a block, imitation refused); protocol `skill-request.test.ts`; web chip/send/history.
- ac-5: `e2e/browser/tests/composer-plus.spec.ts` (not yet run on gate1: needs this branch
  deployed).
- ac-7: plus-menu tests (launch into this thread, new thread from the new-thread view).
- Checks: typecheck, lint, format:check, web 2156, server 2200, protocol 949, `@kobe/db test:db`
  incl. cross-team probes 1549, server DB (10 files, 136): green.
