# KOBE-496: "File changed" badge with Reload when someone else changes an open file

- **Status:** committed locally (not pushed; the coordinator opens the PR)
- **Branch / worktree:** `kobe-496-shared-file-badge` in `../Kobe-wt496` (on KOBE-491's branch, PR #383;
  `origin/main` merged in for `docs/file-editing.md`)
- **Depends on:** KOBE-491 (outside-change tabs), KOBE-488 (live write signal)

## Who can have the same file open (from the code)

File tabs read only `GET /v1/workspace/file`, which serves the **caller's own** (team, user)
manifest: the owner comes from the session, never from the request (`routes/workspace-files.ts`).
So every viewer of a manifest row is its owner.

| Case                                           | Today                                                                                                                               | Badge source                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Same member, two browser tabs or devices       | same (team, user) workspace                                                                                                         | `user` (their own save, upload, move, Edit as file) |
| Same member, another thread or a scheduled run | one sandbox per (team, user); its push lands in the same manifest                                                                   | `agent` (origin `sandbox`)                          |
| Own agent in the thread on screen              | KOBE-491 hints (live write, run end)                                                                                                | `agent`, silent reload kept                         |
| Project files (`projects/<slug>/…`)            | each member has their **own** server-written copy (`projects/mounts.ts` reconcile)                                                  | `sync`, named after the file's `added_by`           |
| Thread uploads (`uploads/…`)                   | the uploader's own rows                                                                                                             | `user`                                              |
| Shared-thread reader (project or team share)   | **cannot** open the owner's files: the tab reads the reader's own workspace (`open-file-card.tsx` hides Open again; `file-tab.tsx`) | none; probe asserts nothing reaches them            |
| Same member in two teams                       | two separate workspaces                                                                                                             | team-scoped; probe asserts no cross-team event      |
| Shared files (`share_file`, `/v1/files/:id`)   | immutable snapshots, not editor tabs                                                                                                | out of scope                                        |

## Design

- **Hint:** `saveState` (the one place every manifest change commits its `head_rev`, `workspace-sync/store.ts`)
  queues `pg_notify('kobe_run_events', 'ws:<user id>')` in the same transaction: delivered on commit,
  never for a rollback; ids only, like the other hints. Same LISTEN connection as the run event hub
  (`event-stream/hub.ts` gains `subscribeWorkspace`), so no new connection per process.
- **Stream:** `GET /v1/workspace/changes?team=<id>&path=…` (SSE, EventSource-friendly like the frame
  route's `team`), one per page for the open tab set (≤ 32 paths). On connect it sends one
  `file.state` per path (current sha, rev, actor, time): the catch-up by SHA after any reconnect. Then
  on each hint (debounced 250 ms) it re-reads rows with `rev > last` among those paths and sends
  `file.changed`. Reads run in `withTeam(session team)` with explicit `team_id`/`user_id` = the session's,
  so a row of another member or team can never be read. Revalidates every 30 s (session live,
  `team.chat` role) and on `user` access hints; uses the hub's per-user stream slot cap.
- **No migration:** the actor is derived from `origin` + area (`sandbox` → agent; `server` under
  `projects/` → sync with the project file's `added_by` name; other `server` → user = the owner).
- **Web:** one `useWorkspaceChanges` per artifact panel; `useOutsideChange` gets the remote change.
  Clean tab: badge (role=status) "<who> changed this file <when>" + Reload (no silent replace),
  except own agent in this thread (write/run-end hint in the last 90 s): KOBE-491 silent reload.
  Draft: KOBE-491's Compare / Keep mine / Take theirs with who. Read-only paths: Reload only.
  Focus checks now raise the badge instead of reloading silently.

## Decisions

- **No migration.** Actor from `origin` + area; time from `updated_at`; revision from `rev`.
- **Protocol contract in its own commit** (`feat(protocol)`, additive file `workspace-changes.ts`):
  the coordinator can land it as its own PR per parallel-work.md.
- **Hub reuse:** `ws:` hints ride `kobe_run_events` and the run event hub's LISTEN connection and
  per-user slot cap; `saveState` notifies only when `head_rev` moved (no hint for an empty push).
- **Focus now badges** instead of reloading silently (KOBE-491 behaviour change: a focus check
  cannot tell who changed the file). Run-end / live-write checks stay silent unless the stream
  names a non-agent actor for that version.
- `VersionWatch.settle()`: a stream change stops a pending hint schedule (it already named the
  newest version), so a later focus check is not skipped.
- Typing under the badge turns it into KOBE-491's banner (`own: false`, so once the draft goes the
  badge comes back instead of a silent read).
- FakeKobe gains `workspaceChanges` (`lib/chat/testing/fake-workspace-changes.ts`); change streams
  are not recorded in `fake.requests` (tests count run streams there).

## Open questions (for Chris or the coordinator)

- Two people never share one editable file today (workspaces are per member; shared readers read
  their own workspace). If shared readers should see the owner's files, that is a new read path
  (and its own authorization) — not built here.
- Project files cannot be replaced in place, so a project change reaches members as delete + add:
  a clean tab **closes** (as before) rather than badging. Want a "removed by X" badge instead?
- The badge's "when" is computed at render (no ticking clock).
- Browser spec written, not run (coordinator runs it on gate1 with KOBE_USER2/KOBE_PW2).

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/files/file-tab-shared-change.test.tsx` "shows who and when with Reload…"
  (same editor, cursor line kept, nothing replaced first); db `workspace-changes.db.test.ts`
  "catches up by version, then tells the member's other tab…" (real PUT → NOTIFY → stream).
- ac-2: web "keeps the draft and offers Compare, Keep mine and Take theirs, naming who", "typing
  under the badge…"; KOBE-491's `file-tab-outside.test.tsx` still green.
- ac-3: web "the agent of another thread or a schedule gets the badge too", "still reloads silently
  after its own write"; db agent push → actor agent.
- ac-4: db "never reaches a teammate, even one reading the owner's shared thread", "never crosses
  teams for the same member", "ends the stream once the member leaves the team", "refuses
  malformed requests" (no `user`/`thread` parameter, internal paths, > 32 paths, non-member).
- ac-5: web "a project file gets the badge with Reload only"; db sync actor named after `added_by`.
- ac-6: web "catches up by version on reconnect"; `lib/files/remote-changes.test.ts` (backoff,
  never steps back); server `change-stream.test.ts` (state first, one read per burst).
- ac-7: browser spec `e2e/browser/tests/shared-file-badge.spec.ts` (written, typechecked, not run);
  docs/file-editing.md section 4 "Live changes to an open file" + updated sequences.
