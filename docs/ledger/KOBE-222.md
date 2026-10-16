# KOBE-222: C4 starters on the welcome screen; follow-ups behind a team switch

- **Status:** done on branch, awaiting review (no PR: group G4)
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-234 (contract, `runEpilogue`, append guard), KOBE-219 (title path),
  KOBE-197 (shell), KOBE-221 (shared threads: readers)
- **Migrations:** none (the switch is a key in the existing `teams.settings` jsonb)

## What it does

1. **Switch** (`threads/followups.ts`, `routes/team-settings.ts`): `teams.settings.followups_enabled`,
   default off. `GET /v1/team/settings` (any member, `team.read`), `PUT` (`team.models.manage`:
   team admins), audited `models.followups.changed` (new audit event, documented in
   `docs/audit-log.md`). `teams` is a site table (no RLS); every query names the team by id.
2. **Announce** (`sandbox-wire/run-state.ts` `epilogueOf` → `followupsDecisionInTx`): in the run-end
   transaction, `followups` joins `run.completed.epilogue` when this server makes server calls, the
   switch is on, the run is a completed `message` run with `trigger = 'user'` (not a schedule), the
   thread is no builder test thread and not in Trash, and no budget line of the run's member (lease
   user; site, team, user-in-team) has reached `SERVER_CALL_LIMITS.followups.skip_at_percent` (80):
   `loadMemberBudgetState` + `thresholdReached` (exact numeric math, as the gateway).
3. **Call** (`server-calls/service.ts`): the same `runEpilogue` as titles; title and follow-ups
   start together, so the window (`SERVER_CALL_EPILOGUE_MAX_MS` = 20 s + 10 s) covers both.
   `loadFollowupsSource` resolves member and model exactly as titles (shared
   `loadServerCallTarget`, extracted from `title-source.ts`), quotes the last user message and the
   last answer after it (2,000 chars each); `models/gateway-client.ts` mints a `followups` token
   (≤ 256, or 768 + `reasoning_effort: low` for a catalog reasoning model), 20 s signal, no retries.
4. **Parse** (`parseFollowups`): per line, bullets / numbering / quotes / Markdown / controls /
   bidi stripped, lines with a link, without a letter or over 120 chars dropped, duplicates
   dropped, at most three, then `threadSuggestionsSchema`; nothing usable → `schema_reject`
   (logged `server call skipped`). Appended as `thread.suggestions`.
5. **Web**: the controller keeps `thread.suggestions` of the run still on screen
   (`state.followups`), dropped on send and when a new run starts; a late epilogue never brings
   old chips back. `FollowupChips` (above the composer box) use assistant-ui's
   `ThreadPrimitive.Suggestion send clearComposer={false}` (a draft in the composer stays).
   Hidden for readers of a shared thread (`summary.readOnly`), in Trash, while sending or running.
6. **Starters**: `GET /v1/agents/runnable` returns each agent's current-version `starters`; the
   welcome screen shows the conversation's agent's starters (draft pick, else the pinned agent) as
   chips that send at once (`ThreadPrimitive.Suggestion send`); without starters the old generic
   suggestions (which only fill the composer) stay.
7. **Team console**: Models and spend → Follow-ups (`/admin/team/follow-ups`), a checkbox + Save.

## Decisions

- **No migration.** `teams.settings` (jsonb) already holds team knobs (`sandbox_idle_minutes`);
  the brief says "Adds migrations: no" and the CE spec rules out new team tables.
- **Permission `team.models.manage`** for the switch: follow-ups are model calls charged to
  members; no new permission.
- **Member = the run's lease user**, as titles and the gateway's `serverCallRunMatches`.
- **Readers** (KOBE-221) can watch the owner's run stream and so receive the event; its text is
  derived from the thread they may read anyway. The web never offers it as sendable chips. Readers
  cannot start runs, so they never trigger follow-ups.
- **Builder test threads** get no follow-ups (as no titles).
- The 402 `budget_soft_limit` backstop is logged (`server call failed`, code only), never shown.

## Open questions

- Gate1 deploy: the switch is off by default; the browser spec needs `KOBE_USER` to be a team
  admin with every budget under 80 %.

## Evidence

- ac-1: `apps/web/components/chat/suggestions.test.tsx` (starters render and send; chips appear
  after the run, a chip sends, chips go on send; none without suggestions);
  `services/server/src/thread-followups.db.test.ts` (switch off: nothing announced or called).
- ac-2, ac-4: `thread-followups.db.test.ts` (usage row `kind = followups`, `sandbox_id` NULL; at
  79.5 % still asked, at exactly 80 % skipped; scheduled run skipped; gateway 402
  `budget_soft_limit` → no event, run completed).
- ac-3: `thread-followups.db.test.ts` (default off, member 403, admin on, audited, other team off);
  `apps/web/components/admin/team-followups-page.test.tsx`; nav registry tests.
- ac-5: `thread-followups.db.test.ts` (epilogue `["followups"]` and `["title","followups"]`,
  token claims and cap, body non-streaming, three of four lines, SSE stays open until
  `thread.suggestions`); `services/server/src/threads/followups.test.ts` (parser, body size).
- ac-6: `suggestions.test.tsx` (chips above the composer box until the next send).
- Starters API: `services/server/src/agents-runnable.db.test.ts`.
- Browser: `e2e/browser/tests/follow-ups.spec.ts` (switch on in the Team console, ask, chips, click
  sends, switch off in `finally`). Runs against gate1 after deploy, not in CI.
- Commands: format, lint, typecheck, `pnpm test`; `@kobe/db` and `@kobe/server` `test:db`.
