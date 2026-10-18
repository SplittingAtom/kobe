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
- **The marker** (after review, coordinator decision): `runs.agent_version` (migration 0141, was 0128 before the Skills Phase A merge,
  nullable), set when a run starts from the pin read under the thread lock (`runs/lifecycle.ts`,
  the one start path for chat, scheduled, retry and resumed runs; compaction runs have no agent).
  0142 (was 0129) backfills it from surviving `run.started` events (FORCE RLS lifted on runs and run_events
  for the backfill only; upgrade test as the non-superuser owner). `GET /v1/threads/:id/markers`
  `agents` compares each message run's version with the previous known one in the thread
  (newest 500 runs, `runs_thread_idx`; no new index); NULL (no agent, compacted before 0142) is
  skipped; a change on a run whose prompt never reached the tree moves to the next run with one.
  The first version (audit events) was dropped: no RLS on audit_log, a cross-team scan, and a
  clock race between `started_at` and the audit `at`. Shown above that run's prompt: "Switched
  to v3 · from v1".
- **"At run creation"** in the decision: the version is set at run **start**, not when a message
  is queued, since a queued run starts on whatever the pin is then (a switch while queued).
- **Review fixes:** focus moves to the composer after a switch; a waiting Switch is
  `aria-disabled` with its reason in `aria-describedby` (still focusable, a click does nothing);
  one request for a double click (controller guard); the thread is re-read after a switch, so a
  version published meanwhile is offered. gate3 clicks Switch (exact name) and checks the next
  run starts on v3 with v3's prompt.
- The fake server (`fake-kobe.ts`) answers the switch like the server (owner only, idle threads).

- **Rolling upgrade (accepted, review nit):** runs that pods of the previous release start after
  0129 ran and before the rollout ends keep `agent_version` NULL (their `run.started` has it).
  They are skipped like compacted runs; a change on one is still marked, on the next run with a
  known version. Not backfilled again: the window is the rollout's minutes, and a lazy write on
  the markers GET would add a `runs` row lock on a read path.

## Open questions (for Chris or the coordinator)

- Light, dark and phone screenshots (ac-1) are not taken here (no browser run against a site from
  this Mac); the pill uses the theme's border and muted-foreground tokens and wraps with the header.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-3: `apps/web/components/chat/agent-version.test.tsx` (header group and accessible name;
  not on the current version or without an agent; reader sees no Switch).
- ac-2: same file (one click sends `{version: 3}`, the badge goes, announcement, focus on the
  composer, one request per double click, v4 offered after; a refusal is shown and the offer
  stays; waits with its reason while a run is active; the marker above the next prompt);
  `agent-versions.db.test.ts` (changes per thread, NULL skipped, carried past a run without a
  prompt; another member gets 404); `runs-resolver.db.test.ts` (real run start);
  `packages/db/src/runs-agent-version-upgrade.db.test.ts`; `threads/agent-switches.test.ts`.
- ac-4: `e2e/gate3.sh` U8 browser checks are ordinary `contains` now; pending the group CI run.
- Local: `@kobe/web` tests 1869/1869, typecheck, eslint; `@kobe/server` tests 1412 (+3 skipped),
  typecheck; server db suites agent-versions, thread-markers, runs-resolver (the real run-start
  path: v1, v1 after publishing v2, switch, v2 with the marker), runs*, schedules; `@kobe/db`
  test:db 1244 + the two suites that timed out under load rerun alone; `db:check` clean.
- Migration time: 0129 does one `run_events` primary-key range per started, uncompacted run
  (runs from the last 7 days plus running ones), holding ACCESS EXCLUSIVE on runs and run_events
  until COMMIT; not measured on a large site.
