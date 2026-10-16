# KOBE-221: C3: Share scope none/project/team: menu, banner, Shared with me, fork

- **Status:** in review (group G3, branch `group-3-phase-c-org`, last ticket of the group)
- **Branch / worktree:** `group-3-phase-c-org` in `../Kobe-g3`
- **Depends on:** KOBE-163 (project share, fork route, `threads/share.ts`), KOBE-216 (fork provenance),
  KOBE-292 (row ⋯ menu), KOBE-219 (card route), KOBE-220 (move unshares a project share)

## Plan

KOBE-163 left `team` to this ticket: a column, the reader predicate and the stream visibility. Built
on it, nothing duplicated: `POST /v1/threads/{id}/share` and `/fork` are KOBE-163's routes; the scope
is one more column behind `threads/share.ts`.

## Decisions

- **Storage:** `threads.shared_to_team boolean` (generated `0105_thread_share_team`), next to
  `shared_to_project`. Custom `0106_thread_share_team_checks`: CHECK `threads_share_scope` (never both
  scopes, never a test thread; NOT VALID, as 0104) and `threads_team_shared_idx` (Shared with me).
  No new table, no RLS change. `docs/install.md` "Upgrading" has the index note.
- **Wire:** `THREAD_VISIBILITIES` gains `team` (protocol, in this branch: the group has no contract PR
  of its own). Summaries now carry `read_only` (for the caller) and `owner_name` (readers only: the
  sharer's name while they are in the team, never an email). New `GET /v1/threads/shared` (others'
  threads shared with the caller, keyset like the other lists). OpenAPI regenerated.
- **One predicate:** `readableBy` (repository) = own, or `(shared_to_team OR shared_to_project AND
project ∈ viewer's projects) AND deleted_at IS NULL`, always with `team_id`. Every read path goes
  through it (`findThread`): detail, entries, tool output, card, markers, pending, runs, usage,
  artifacts (list, detail, content, frame), files, fork, provenance titles. Search (`@kobe/db`
  `thread-search.ts`) and the event stream (`event-stream/read.ts` + `visibility.ts`) mirror it.
  Exports, workspace files and notifications are the caller's own only (unchanged).
- **Team admins** get nothing extra: no admin branch exists in the predicate; tested.
- **Writes:** unchanged: every change goes through `lockForChange` (owner only, 403 `read_only`).
  Tested for a team reader across rename, model, share, leaf, agent version, trash/restore, send,
  regenerate, compact, pin/unpin, archive/unarchive, move, queue, steer, cancel, retry, edit; the
  admin too.
- **Scope changes** (`threads/share-scope.ts`): `team` needs no project; `project` keeps KOBE-163's
  checks; `private` (revoke) is always allowed. Audit `thread.sharing_changed` now has `from` and a
  nullable `projectId` (a team share outside a project). `PATCH shared_to_project:false` ends only a
  project share (a team share stays).
- **Immediate revocation:** a new access hint `access:<run_id>` on the existing
  `kobe_run_events` channel (ids only). Revoke, team→project narrowing, a move ending a project share
  and Trash of a shared thread send it for the thread's runs still streamable (inside the change's
  transaction, delivered on commit); the hub has those runs' streams revalidate at once. The 30 s
  periodic revalidation stays as the fallback (lost notification, member removal).
- **Move (KOBE-220):** still ends a project share (audited `from: project`, streams told); a team
  share stays, since its readers don't depend on the project.
- **Web:** the row ⋯ menu gains Share (submenu Only you / Project members (in a project only) /
  Everyone in the team, current marked; readers see why not). The reader banner says
  "Shared by <name>." (or "a former member") and keeps Fork. The owner's bar on a team-shared thread
  says so with Make private. The rail lists `/v1/threads/shared` in Shared with me; a project-scoped
  one is also in its project group. The header's Conversation actions menu still holds Compact only.

## Review fixes (review-221)

- **S1:** a stream checks access once right after it subscribes to the hub, so a revoke that
  committed between the route's check and the subscribe is not missed (`stream.ts` `start`).
- **S2 (fail closed):** removing a member ends every share of their threads in the team, in the
  removal's transaction (`endSharesOf`, `share-scope.ts`, called from `teams/members.ts`), each
  audited `thread.sharing_changed` with the system actor and with the access hint sent. Deactivation
  does the same per team in a lifecycle hook (see R1). Reactivation does not share again. No admin
  write action.
- **R1 (re-review, backstop):** a share counts only while its owner is a current, active member of
  the thread's team: `sharedWith` (repository), the search CTE and the stream's access SQL all add
  `EXISTS (team_members m JOIN users u ... u.deactivated_at IS NULL)`, two primary-key lookups
  (plan checked in `thread-team-sharing.db.test.ts`). `endSharesOf` stays the durable cleanup.
  Deactivation's step is now the `thread-shares` lifecycle hook (`endUserShares`), which throws on
  any failed team, so it shows in `incompleteSteps`. Tested: a share committed after the owner's
  removal, and a deactivation whose steps never ran, are unreadable everywhere (stream included).
- **R2:** searching a project the viewer may not open passes `ownOnly` to the search, so the page
  is filtered before paging.
- **R3:** the removal and deactivation tests LISTEN for the access hint, cover a project share
  ending, and a deactivated user in two teams.
- **S3:** team-scope tests for tool output, pending drafts, shared files (meta and content),
  artifact detail/content/frame, an approval by a reader, a test thread, and the real Trash and
  move paths sending the hint (LISTEN in the test). A reader's approval attempt is 404 (decided by
  its asker only, as for project readers since KOBE-163), not 403.
- **N1:** a hint that arrives during a read discards that page and rechecks first. **N2:** comment
  fixed; the `ended_at` bound stays (old replay streams rely on the 30 s check). **N3:** the hub's
  resync also rechecks access. **N4:** others' summaries and search hits hide `project_id` when the
  viewer may not open the project (as the markers do), and listing or searching such a project shows
  them only their own threads.
- **Noted, unchanged:** N5, a reader sees the name and status of the owner's pinned agent (detail
  and card), as project readers already did; N6, storage is a second boolean (`shared_to_team`)
  next to `shared_to_project` instead of CE20's `threads.shared_scope`; flag for the spec owner.

## Evidence (acceptance criteria → test)

- ac-1: `services/server/src/thread-team-sharing.db.test.ts` ("shares with the team, read-only with the
  author's name, forkable, and revoked everywhere", "switches between project and team scope", "a reader
  never writes", "revocation reaches open streams at once" with `revalidateMs` 60 s);
  `apps/web/components/chat/thread-share.test.tsx` (menu, refusal, banner, fork, Make private).
- ac-2: `thread-share.test.tsx` "lists others' shared threads, a project-scoped one also in its project
  group"; `lib/chat/thread-groups.test.ts`; server test above (`/v1/threads/shared`, `?project_id=`).
- ac-3: `thread-team-sharing.db.test.ts` "shows a team admin only shared threads" and "never lets
  another team read a team-shared thread, not even a member of both"; probe fixture
  `probe-fixtures/conversations.ts` adds a team-shared thread; `packages/db/src/thread-search.db.test.ts`
  (team scope, other team); `conversations.db.test.ts` (`threads_share_scope`).
- Unit: `event-stream/notify.test.ts` (access hint codec), `stream.test.ts` (push revalidation).
- Browser: `e2e/browser/tests/share.spec.ts` (two members; needs `KOBE_USER2`/`KOBE_PW2`, see below).

## gate1 setup for the browser spec

gate1 has one password member (the owner). The spec needs a second member of the same team, in that
team only, with a password: invite one (e.g. `member2@gate1.test`) to the owner's team, sign up via
Mailpit, and pass `KOBE_USER2`/`KOBE_PW2` with the other variables. Without them the spec skips.

## Verification

`pnpm format`, `lint`, `typecheck`, unit tests green; `@kobe/db test:db` 1128 and `@kobe/server
test:db` 1471 green (probe suite included). Known: `@kobe/cli test:db` pg_dump failures; one run of
`gateway-client.test.ts` "does not follow redirects" failed under full-suite load and passes alone.

After the review fixes: format, lint, typecheck and every package's unit tests green;
`@kobe/db test:db` 1128 and `@kobe/server test:db` 1478 green.

After the re-review fixes: format, lint, typecheck and unit tests green (`sandbox-agent` had two
timing failures under the full parallel run, untouched here, green when rerun alone);
`@kobe/db test:db` 1129 and `@kobe/server test:db` 1481 green.
