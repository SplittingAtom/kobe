# KOBE-599: Files panel: Refresh syncs the sandbox first, and the panel refreshes itself

- **Status:** in review (branch commits; coordinator pushes/PRs, runs the gate1 spec)
- **Branch / worktree:** `kobe-599-files-refresh` in `../Kobe-wt599` (on `pipeline-b`)
- **Depends on:** KOBE-496 (workspace hint + change stream), KOBE-304 (`mv` bus hint pattern)

## Design

**Refresh = sync now (ac-1).** `POST /v1/workspace/sync` (contract `packages/protocol/src/workspace-events.ts`).
The requesting replica finds the member's live `sandbox_connections` row; none → `asleep`
(the server starts the wake, as opening the panel does; the panel lists at once and once more
after 4 s). Otherwise it sends bus hint `sync:<connection>:<request>` (two random ids, nothing
else); the holder replica sends `workspace.sync_now {request_id}` to an agent that announced
hello capability `workspace_sync_now`; the agent runs one push that starts after the frame
(`WorkspaceSync.syncNow`: requests not yet started share a push, a request during a push waits
for the next) and answers `workspace.synced {request_id, ok}`; the holder passes it back as bus
hint `synced:<request>` / `unsynced:<request>`, which resolves the waiter in the requesting process
(`sandbox-wire/sync-now.ts`). Bounded by `WORKSPACE_SYNC_WAIT_MS` = 10 s → `timeout`. An older
agent (no capability), a connection not ready, or >16 asks in flight → `unsynced` at once, so the
panel never waits for nothing. Answers are only accepted for ids sent on that connection (another
sandbox cannot answer someone's Refresh). Rate limit 30/min/member. No table, no migration.
Web: the first ask of a page wakes (as before); every later ask (Refresh, Show files, Mod+Shift+F,
`/files`, a rail drop) is a sync now; the Refresh icon is `aria-busy`/`aria-disabled` and spins
until the answer, then everything on screen lists again.

**Auto-refresh (ac-2).** `GET /v1/workspace/events?team=` (SSE): `workspace.state` on connect, then
`workspace.changed` with `{files_rev, projects_rev}` when either moves. `files_rev` = the member's
own (team, user) `workspace_sync.head_rev`; `projects_rev` = md5 over the team's projects (head
commit, slug, name, archived, updated_at) and the member's own checkouts. Woken by the existing
per-user `ws:<user>` hint on `kobe_run_events` (LISTEN/NOTIFY, no Redis), which every manifest
commit already sends (sandbox push, upload, save, move, project mount reconcile). New:
`ProjectMounts.reconcileProject`/`reconcileTeam` (commit, revert, project file add/remove, proposal
commit) then send `ws:<user>` for every team member (`notifyTeamWorkspaces`), so unmounted project
heads refresh too. The stream reuses the KOBE-496 pump (now `workspace-files/hint-stream.ts`,
shared with the change stream), debounce 500 ms server side; the web feed
(`lib/files/workspace-events.ts`, one per ChatSession, open while the panel is mounted) debounces
400 ms and the panel re-lists its visible folders (open folders stay open), drops the project head
cache and reloads projects/checkouts when `projects_rev` moved.

**Tenancy.** Hints carry user ids only; each stream re-reads under its own session's team in
`withTeam` and names team and user, so a hint from another team or a forged one sends nothing.
Projects: every workspace member reads every project (RV1), and checkouts in the digest are the
caller's own. Session and `team.chat` rechecked every 30 s and on access hints (as KOBE-496).

## Decisions

- Reused the `mv`-style bus hint instead of a `sandbox_commands` kind: commands need a thread
  (FK, NOT NULL) and a migration; sync is per sandbox, not per thread.
- `maxWorkspaceStreamsPerUser` 8 → 16: a page now holds two workspace streams (tabs + panel).
- A teammate creating a new project does not hint (only reconciles do); the next hint or Refresh
  shows it.

## Open questions

- None blocking. If `files-refresh` ac-1 fails with "periodic push raced", run it again (the
  window is ~3 s of every 60 s).

## Evidence

- sandbox-agent: `workspace/sync.test.ts` (3 new: sync now pushes a just-written file; shared and
  queued pushes; false when stopped or failing), `agent.wire.test.ts` (capability + answer).
- server unit: `sandbox-wire/sync-now.test.ts` (asleep, synced, not_synced, timeout, close, bus
  hint codec), `workspace-files/event-stream.test.ts`; full server unit suite green.
- server db: `workspace-events.db.test.ts` (7: asleep wakes; running sandbox pushes then lists;
  old agent not asked; silent agent times out; another member's sandbox answer dropped; events
  move on own push only, not teammate's or other team's; project change moves every member's
  `projects_rev`; 409/400), plus workspace-changes, workspace-move, project-commits,
  project-mounts, sandbox-wire db tests green.
- web: `lib/files/workspace-events.test.ts` (6), `api.test.ts`, `rail-files.test.tsx` (busy
  Refresh lists only after the push; asleep Refresh shows "last synced"; panel re-lists by itself
  with open folders kept), rail-tabs / rail-drop-zone updated for the sync ask.
- Browser (coordinator, gate1): `cd e2e/browser && KOBE_BASE_URL=<gate1 URL> KOBE_USER=<owner>
KOBE_PW=… npx playwright test files-refresh` (three tests, two short
  model turns, needs the new server **and** sandbox images: the agent must announce
  `workspace_sync_now`).

## What Chris should check

1. Agent writes a file mid-conversation → Refresh: the icon spins briefly, the file is there.
2. Leave the panel open: a file the agent writes appears ~2–3 s after its run ends; an upload in
   another tab and a teammate's commit to a mounted project appear without clicking; open folders
   stay open.
