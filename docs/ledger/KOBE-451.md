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
