# KOBE-420: Chat: "v<N> available" with a one-click switch on threads pinned to an older agent version (U8)

- **Status:** in progress (group G5, branch `group-5-gates`; not pushed)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** KOBE-46 (pinning and the switch API, merged); found by KOBE-231

## Plan

Keep `agent_current_version` in the thread controller, render the offer in the thread header,
switch through `POST /v1/threads/:id/agent-version`, and mark the switch in the thread like a
project move (KOBE-220). Then flip gate3's two U8 browser checks from expected-fail.

## Decisions

- **Where:** the thread header, after the title and the state badge (the bar's row two is gone
  since KOBE-418). A `group` named "<agent> v3 available. This thread uses v1." holds the pill
  "v3 available" and an outline `Switch` button named "Switch this thread to v3".
- **Switch targets the shown version** (`{ version: <current> }`), not "whatever is current
  now", so a publish in between never moves the thread further than the button said.
- **Not offered** on the current version, without an agent, in Trash; a reader of a shared
  thread sees the pill without Switch; a suspended or archived agent shows the pill without Switch
  too (the server would refuse). While a run is active, Switch is disabled with the title "Switch
  when the run ends" (the server answers `thread_busy`). Refusals use the thread's action error.
- **The marker** comes from the server (`GET /v1/threads/:id/markers` gains `agents`): the
  `thread.agent_switched` audit events the switch already writes, each placed on the first message
  run that started after it (`services/server/src/threads/agent-switches.ts`); switches between two
  runs collapse to one (first from, last to), a round trip shows none. No migration: the audit
  event is the record. Shown above that run's prompt: "Switched to v3 · from v1".
- The fake server (`fake-kobe.ts`) answers the switch like the server (owner only, idle threads).

## Open questions (for Chris or the coordinator)

- Light, dark and phone screenshots (ac-1) are not taken here (no browser run against a site from
  this Mac); the pill uses the theme's border and muted-foreground tokens and wraps with the header.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-3: `apps/web/components/chat/agent-version.test.tsx` (header group and accessible name;
  not on the current version or without an agent; reader sees no Switch).
- ac-2: same file (one click sends `{version: 3}`, the badge goes, announcement; a refusal is shown
  and the offer stays; disabled while a run is active; the marker above the next prompt);
  `services/server/src/agent-versions.db.test.ts` "marks the switch on the first run that started
  after it" (round trip, no run yet, then the run's marker; another member gets 404);
  `services/server/src/threads/agent-switches.test.ts` (grouping).
- ac-4: `e2e/gate3.sh` U8 browser checks are ordinary `contains` now; pending the group CI run.
- Local: `@kobe/web` tests 1864/1864, typecheck, eslint; `@kobe/server` tests 1411 (+3 skipped),
  typecheck, lint; server db suites agent-versions, thread-markers, thread-organize 45/45.
