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

## Open questions (for Chris or the coordinator)

- A member who leaves the team keeps their team-shared threads visible to the team (as project
  shares stay visible to project members); revisit with offboarding if that is unwanted.

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
