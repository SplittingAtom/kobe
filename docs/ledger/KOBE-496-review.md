# KOBE-496 review (live "file changed" badge)

Scope: commits after `origin/kobe-491-tab-notices-changes`: e686f328 (protocol), 89e3674c (server),
27349513 (web), f6947d7d / 984a1aa2 (docs, spec, ledger). Review only; no code changed.

## Verdict

**Ship.** No BLOCKER or HIGH. Authorization is sound. Every read names the session's own
`team_id` and `user_id` inside `withTeam`. The route sits behind `requireTeam` and `team.chat`,
refuses unknown parameters (`strictObject`), and checks `team` against the active team. The
NOTIFY carries only the user id and fires on commit. The MEDIUMs below are worth a quick fix
before merge or a follow-up ticket.

## Tests run

- `pnpm --filter @kobe/server exec vitest run -c vitest.db.config.ts src/workspace-changes.db.test.ts`: 6/6 passed (dev Postgres).
- Server unit tests `change-stream.test.ts`, `notify.test.ts`, `stream.test.ts`: 54/54.
- Web `file-tab-shared-change.test.tsx`, `file-tab-outside.test.tsx`, `remote-changes.test.ts`,
  `outside-change.test.ts`: 34/34.
- Protocol `workspace-changes.test.ts`: 4/4.
- Browser spec `e2e/browser/tests/shared-file-badge.spec.ts`: not run (the ledger says so too).

## Verified OK

- **Authorization.** `readFileChanges` (`workspace-files/changes.ts:36-49`) filters on
  `f.team_id = owner.teamId AND f.user_id = owner.userId`, and RLS applies through `withTeam`
  (`routes/workspace-changes.ts:86`). The hub subscription is keyed on the session's user id. A
  forged or cross-team `ws:` hint costs one indexed read and sends nothing. A path the caller has
  no file at reads as "never seen", so nobody learns whether another member has a file there. The
  `project_adder` subquery runs in the same team, and only for a path already in the caller's own
  manifest. Shared-thread readers and other teams are covered by db probes.
- **NOTIFY.** `saveState` (`workspace-sync/store.ts:107-127`) calls `pg_notify` on the caller's
  `tx`, so it is delivered only on commit and never on rollback. It fires only when `head_rev`
  moved. The payload is `ws:<uuid>` (≤ 64 chars, uuid-validated on decode). Old replicas ignore it
  during a rolling deploy: `decodeHint` and `decodeAccessHint` both return undefined, and a test
  covers this. `saveState` is the only path that moves the revision: `putServerFile`,
  `deleteServerFile` and `commitChanges` go through it, `move.ts` calls it, and GC and offboarding
  purge do not move the revision.
- **Ordering.** The stream subscribes in `start()` before the first read. Revisions are taken under
  the `FOR UPDATE` lock on `workspace_sync`, so reading `rev > lastRev` cannot skip a commit. A hint
  that lands during a read sets a new debounce (no lost wake-up).
- **Bounds.** The per-user slot is taken before the stream is built and freed exactly once
  (`cleanup` → `onEnd`). Cancel, hub close, stall cut-off (60 s), keep-alives and `retry:` all
  work. Paths: ≤ 32 (checked before dedupe), each ≤ 1024 bytes, `..`, absolute and control-char
  paths refused, `.kobe/` refused (`isInternalPath`). A URL stays within Node's header limit.
- **Revalidation.** The first `step` revalidates (session live, `team.chat`) before the first read,
  and again every 30 s. Deactivation deletes sessions, so that is caught too. This matches run
  streams.
- **Web.** One feed per `ChatSession`, ref-counted `watch`, a 300 ms debounce on the path set,
  `dispose` clears the timer and closes the source. Server-refused streams reopen after 5/15/30/60 s
  (no tight loop). Incoming changes are zod-validated and never step back a revision. The badge
  shows only with no draft, and typing under it turns it into KOBE-491's banner (`own: false`).
  The save base SHA still yields a 409, so no unsaved edit is lost.

## Findings

### MEDIUM

1. **Change streams share the run-stream slot cap (16 per user per replica).**
   `routes/workspace-changes.ts:70` (`hub.acquireSlot`).
   - _What changes:_ before this branch, slots were held only while a run streamed. A change stream
     is held for as long as a page has any file tab open, possibly for hours.
   - _Failure:_ a member keeps about 10 chat tabs open with files showing, then starts runs in a few
     of them. The run event streams get `429 too_many_streams`, so the chat stops streaming live
     output. Idle file badges have starved the core feature.
   - _Fix:_ give workspace streams their own small cap (for example 8), or count them apart from
     the run-stream cap.

2. **The ledger says the stream revalidates "on `user` access hints"; the code does not.**
   `docs/ledger/KOBE-496.md:37`; `hub.ts:118-125`.
   - _What the code does:_ `WorkspaceHubSubscriber` has no `revalidate`, access hints go only to run
     subscribers (`byRun`), and `resyncAll` after a LISTEN reconnect revalidates run streams but not
     workspace streams.
   - _Failure:_ a removed member's stream keeps sending their own path versions in that team for up
     to 30 s. That is low impact (it is their own data), but the documented guarantee is false.
   - _Fix:_ add an optional `revalidate()` to the workspace subscriber, call it from `resyncAll`,
     and fire it on member removal (`routes/team.ts` already calls `revalidateUser`). Otherwise
     correct the ledger and `docs/file-editing.md`.

3. **Another thread's or a schedule's agent can silently replace a clean tab.**
   `components/files/use-outside-change.ts:88-90`.
   - _Cause:_ `own = kind === "agent" && (source === "agent" || recent)`. Any agent change counts as
     this thread's if it arrives within 90 s of this thread's own write or run-end hint.
   - _Failure:_ this thread's agent writes `report.md`. Within 90 s, a scheduled run (or the
     member's other thread) pushes a different `report.md`. The clean tab reloads silently with the
     other agent's content and no badge, which goes against ac-3. No typed text is lost.
   - _Fix:_ require the stream change's SHA to match a version that this thread's own check found
     (the VersionWatch result for `source: "agent"`), instead of relying on the time window alone.

4. **Persistent 1 Hz polling while the LISTEN connection is degraded.** `hub.ts:118-125`, `startPolling`.
   - _Cause:_ in degraded mode every workspace subscriber is resynced every `degradedPollMs`
     (1 s). That costs one `withTeam` read each, plus a 250 ms debounce.
   - _Failure:_ run streams are short-lived, but change streams live as long as a tab stays open.
     If the listener stays down (pooler misconfiguration, or Postgres failover), every page with
     file tabs polls the database once a second for hours. The ticket says "no polling loops".
   - _Fix:_ use a slower poll for workspace subscribers (for example 10-15 s), or rely on the 60 s
     safety read while degraded.

### LOW

5. **The server can emit values the client's schema rejects, and the client then drops the whole change.**
   `workspace-files/changes.ts:63-67` vs `protocol/src/workspace-changes.ts:34`.
   - _Cause:_ `users.name` is unbounded `text`, while the actor schema requires 1-200 characters.
     The server does not validate its own output.
   - _Failure:_ an empty or over-long name makes `remote-changes.ts:139` drop the change silently,
     so no badge appears until a focus check.
   - _Fix:_ clamp or nullify the name server-side, or parse the output with the schema.
6. **Tabs beyond 32 get no live changes, silently.** `lib/files/remote-changes.ts:112`. They fall
   back to focus checks only. Acceptable, but log it or note it in the docs.
7. **A file deleted while the stream was down is missed.** `remote-changes.ts:143` and
   `use-outside-change.ts:132-137`.
   - _Failure:_ the file is deleted while the stream is down and its tombstone is then GC'd. On
     reconnect the `file.state` says `rev: 0`, `sha256: null`, which is dropped because it steps the
     revision back (and rev 0 is ignored anyway). The tab keeps stale content until a focus check.
   - _Related:_ after an offboarding purge and a rejoin, revisions restart at 0, so a page that
     stayed open drops every change until it is reloaded.
8. **A stale team after a team switch reconnects forever.** `remote-changes.ts:149-156`.
   - _Failure:_ the member switches team in another browser tab. The page's next reconnect gets
     `409 team_mismatch`, and the feed retries every 60 s forever with the old team.
   - _Fix:_ stop on 409; EventSource cannot see the status, so do one `fetch` probe before
     reopening.
   - _Note:_ the open stream keeps serving the old team until then. That is not a leak (they are
     still a member), but revalidate could also compare the session's active team.
9. **The badge's live region may not be announced.** `outside-change-notice.tsx:72-84`.
   - _Cause:_ `role="status"` is inserted together with its text, and some screen readers (notably
     NVDA and JAWS with Chrome) do not announce a live region that is mounted with its content
     already in it.
   - _Fix:_ keep an always-mounted, empty status region and fill it. `aria-live="polite"` is
     redundant with `role="status"`.
   - _Also:_ when the actor is unknown (a focus check), "just now" is shown even if the change is
     old (`changedWhen(null)`).
10. **The project-adder subquery is unindexed.** `changes.ts:39-45`. It matches on string
    concatenation (`'projects/' || slug || '/' || path = f.path`) for each server-origin row. That
    is fine at 32 paths, but it scans the team's `project_files`; consider joining on
    `(project_id, path)` derived in SQL.
11. **The browser spec has not been run** (ac-7). The coordinator should run it on gate1 with
    member2 before closing.

## Not issues (checked)

- **Cross-site use:** a cross-site EventSource is a GET with SameSite cookies and has no side
  effects.
- **API keys:** there is no key-auth path here; `sessionId` is always set by the session
  middleware.
- **NOTIFY lock:** NOTIFY on commit takes the global notify-queue lock, the same cost run events
  already pay.
- **Read-only paths:** they use the same badge with Reload only (ac-5), as required.
