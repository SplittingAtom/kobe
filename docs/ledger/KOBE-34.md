# KOBE-34: Thread API

- **Status:** in review
- **Branch / worktree:** `kobe-34-thread-api` in `../Kobe-wt34`
- **Depends on:** KOBE-29 (merged), KOBE-14 (merged); contracts PR #13 (merged)

## Acceptance criteria

Hadron's ticket (reached once at the start): "Endpoints: POST/GET /v1/threads, GET /v1/threads/{id},
POST /v1/threads/{id}/messages, POST /v1/threads/{id}/leaf, POST /v1/runs/{id}/steer|cancel|retry.
All team-scoped via withTeam; OpenAPI document generated." Hadron criteria: ac-1 endpoints match
§6.1 with OpenAPI; ac-2 history reads never wake sandboxes; ac-3 authorization tests per role.
Scope from the coordinator: thread CRUD, list, entries, rename, Trash/restore, sharing and
visibility. Messages and runs go to the run orchestrator (KOBE-30); search goes to KOBE-33.
Derived from D9, D15, D17, D18, D23, §6.1, U2, U15:

1. **ac-1 Endpoints (§6.1) and OpenAPI.** `POST /v1/threads {agent_id?, project_id?, title?}`,
   `GET /v1/threads?project_id=&q=&cursor=&limit=`, `GET /v1/threads/{id}` (entries, leaf, agent
   version, status), `POST /v1/threads/{id}/leaf {entry_id}`. Added: `GET /v1/threads/{id}/entries`,
   `PATCH /v1/threads/{id}` (rename, share), `DELETE /v1/threads/{id}` (Trash),
   `POST /v1/threads/{id}/restore`, `GET /v1/threads/trash`. An OpenAPI 3.1 document is generated
   from the same zod schemas and committed (`services/server/openapi.json`).
2. **ac-2 Reads never wake sandboxes (D14, U15).** List, read and entries touch Postgres only.
3. **ac-3 Authorization per role (D8, D9).** Member, builder and team admin can all chat
   (`team.chat`). Install admins and owners who are not members are refused, and so are users
   with no team. A removed member is refused at once.
4. **ac-4 Visibility (D18, D23).** A thread is readable by its owner, or by members of its project
   when shared there, read-only. Team admins can't read members' threads. Only the owner changes a
   thread. Another user's private thread looks the same as an unknown id.
5. **ac-5 Team walls (D5, D9, U2).** All work runs in `withTeam(active team)`. `team_id` and the
   owner come from the session and never from input. Another team's thread is 404 for every
   route, even for the same user.
6. **ac-6 Keyset pagination.** Order is (last_activity_at DESC, id DESC) with µs-precise opaque
   cursors. Every thread appears exactly once and the walk is stable under concurrent inserts and
   bumps. Entries page by `seq`.
7. **ac-7 Trash (D18).** Deleting is a 30-day soft delete, restorable within the window. Trash is
   kept out of the list and has its own list.
8. **ac-8 Validation.** zod on every body, query and path parameter. Request schemas are strict
   (unknown keys → 400). Errors use the `{code, message}` envelope of the existing routes.

## Plan

- `services/server/src/threads/`: `schemas.ts` (wire schemas, from `@kobe/protocol` where shared),
  `cursor.ts`, `repository.ts` (data access inside `withTeam`), `references.ts` (project/agent
  seams), `search.ts` (KOBE-33 seam). `routes/threads.ts` is mounted with one line in `app.ts`.
- `src/openapi/` builds the document. `openapi.json` is committed.
- Tests: `threads/*.test.ts` (schemas, cursor), `openapi/document.test.ts` (drift + route coverage),
  `threads.db.test.ts` (34 integration tests on Postgres).

## Decisions

1. **snake_case wire keys** for the Thread API, as in §6.1 (`agent_id`, `leaf_entry_id`, …) and
   `@kobe/protocol`. The KOBE-14 routes use camelCase. The error envelope is shared:
   `{code, message}`.
2. **Messages and runs are not here.** The ticket lists `POST /v1/threads/{id}/messages` and
   `/v1/runs/{id}/steer|cancel|retry`, but the coordinator assigned runs to KOBE-30, which
   implements `RunOrchestrator` (`@kobe/protocol`) and can mount those routes over it. KOBE-30
   should reuse `findThread` (visibility) and add its paths to `src/openapi/document.ts`.
3. **Visibility rule** (`repository.ts readableBy`): owner (Trash included), or
   `shared_to_project AND project_id ∈ viewer's projects AND not in Trash`. Mutations need the
   owner: 403 `read_only` for a reader who can see the thread, 404 `thread_not_found` for everyone
   else (no existence oracle). Queries also carry explicit `team_id` predicates on top of RLS, as
   defence in depth and so that each query leads its index.
4. **Project and agent seams** (`references.ts`). `viewerProjectIds` returns `[]` until KOBE-57.
   `canCreateInProject` returns false, so `project_id` gives 404 `project_not_found`.
   `resolveAgentPin` accepts only null (the install default agent, KOBE-29 decision 7), so
   `agent_id` gives 404 `agent_not_found` until KOBE-45/46. `agent_id` is optional (§6.1 lists it,
   but no agents exist yet).
5. **Search seam.** `?q=` is validated (1–256 chars) and then answers 501 `search_unavailable`.
   `threads/search.ts` documents the one-call wiring to KOBE-33's `searchThreads` (cap the limit
   at 50 and set a statement timeout). The list without `q` is unaffected.
6. **Leaf switch is refused while a run is active** (409 `thread_busy`): Pi continues from its own
   leaf and would diverge from `threads.leaf_entry_id`. Queued runs don't block it.
7. **Trash is refused while a run is active or queued** (409 `thread_busy`): Stop and clear the
   queue first, so nothing runs on a thread its owner deleted. Delete is idempotent. Restore works
   only while `deleted_at > now() - 30 days`. After that the thread is 404 and waits for KOBE-18's
   purge. A trashed thread stays readable by its owner, and every change except restore gets 409
   `thread_in_trash`. Trashed threads are never visible to project readers.
8. **Trash/restore overlap with KOBE-18** (whose ticket says "user thread delete = 30-day soft
   delete (Trash) then hard purge"). Built here as the coordinator asked. KOBE-18 keeps the purge
   (incl. S3), legal hold, retention, export and the "restore within 30 days, hard purge after"
   test. `TRASH_RETENTION_DAYS` lives in `threads/schemas.ts` for it to share.
9. **Entries.** `GET /v1/threads/{id}` returns the thread summary plus the first page of the
   **whole entry tree** in `seq` order (default 200, max 500), so the client can build branches
   (assistant-ui `parentId`/`headId`). `next_entries_after` continues via `/entries?after=`.
   `blob_ref` is not exposed: `payload_offloaded: true` tells the client the body is in object
   storage, and a blob route comes with KOBE-27/53.
10. **Cursors** are base64url JSON `{a: epoch µs as a decimal string, i: id}`, validated by zod. A
    JS Date has ms precision and timestamptz has µs, so a ms cursor would skip or repeat rows
    (a mutation test confirms this). Malformed cursor → 400 `invalid_cursor`.
11. **Path ids** must be uuids (any case, normalized to lowercase). A non-uuid gets 400
    `invalid_request`, as in KOBE-14.
12. **Title:** trimmed, 1–200 chars, no control characters. Null clears it. Rename doesn't bump
    `last_activity_at`.
13. **OpenAPI** is generated with zod 4's `z.toJSONSchema` (no new dependency) from the schemas the
    routes validate with. The test fails if `openapi.json` drifts, or if a mounted route is
    undocumented or a documented one is missing. Regenerate with
    `UPDATE_OPENAPI=1 pnpm --filter @kobe/server exec vitest run src/openapi && pnpm format`. The
    document is not served over HTTP (not needed yet; one route when it is).
14. **ac-2 proof:** the thread routes use only `deps.database` (plus the session check). The test
    builds the app over a `Proxy` of deps that throws if any other dependency is touched, and runs
    every read through it.

15. **Security review round 1 (coordinator, no CRITICAL/HIGH).**
    - MEDIUM: an offloaded entry (`blob_ref` set) always gets `payload: {}`, whatever was stored
      inline. **Suggestion for whoever writes offloaded entries (KOBE-23/30/27):** add a CHECK
      `blob_ref IS NULL OR payload = '{}'` on `thread_entries` (not this ticket's table).
    - MEDIUM: changes (PATCH, leaf, DELETE, restore) run `SET LOCAL lock_timeout = '2s'`
      (`THREAD_LOCK_TIMEOUT`) before `FOR UPDATE` on the thread row. Appenders (seq trigger) and the
      orchestrator hold that row, so a change fails fast instead of piling up connections. Postgres
      55P03 → **409 `thread_busy`**, the same code as "run active or queued" (chosen over 503 +
      Retry-After: the client already handles it as "busy, try again"; the message says so).
      Reads take no lock and are never blocked.
    - LOW: Trash older than 30 days (awaiting KOBE-18's purge) is treated as gone everywhere:
      read, entries, change, delete and restore all return 404 `thread_not_found` (in `readableBy`),
      consistent with the Trash list.

## For downstream tickets

- **KOBE-30 (hard requirements, security review):** lock the thread row (`FOR UPDATE`) first
  in every transaction that creates, enqueues or promotes a run (lock order thread → run), and
  refuse trashed threads (`deleted_at` set) there, with a concurrency test (trash racing a message
  or promotion: never a run on a trashed thread). Never start queued runs of a trashed thread. Bump `threads.last_activity_at` on each message. Mount messages/steer/cancel/retry
  and document them in `src/openapi/document.ts`. Reuse `findThread` for visibility (readers of a
  shared thread must not post: D23, read-only).
- **KOBE-32:** `RemoteThreadListAdapter` → `GET /v1/threads` (+ `next_cursor`), `POST /v1/threads`,
  `PATCH` (rename), `DELETE` (Trash). The thread view → `GET /v1/threads/{id}` (+ `/entries`).
  Branch switch → `POST /leaf`. Send `X-Kobe-Team` on every request.
- **KOBE-33:** wire `threads/search.ts` (see its comment).
- **KOBE-57:** implement `viewerProjectIds` / `canCreateInProject` in `threads/references.ts`,
  and **must add shared-reader authz tests over HTTP** (project member reads a shared thread
  read-only: 403 `read_only` on every change, no messages; non-member and ex-member 404; unshared
  and trashed hidden). Today they are covered only at the data layer.
- **Tracked follow-up (security review):** rate limiting for `POST /v1/threads` (per user), and a
  request body size cap in `teams/http.ts parseBody` (shared by all JSON routes) or as Hono
  `bodyLimit` middleware on `/v1`. Not done here: both are cross-cutting.
- **KOBE-45/46:** implement `resolveAgentPin` (current published version; D19 pinning).
- **KOBE-18:** purge from `threads_deleted_idx`. If a user's Trash is large, consider an index
  `(team_id, owner_user_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL` (see evidence).

## Open questions (for Chris or the coordinator)

- **"Archive"** is not in the spec (no column or decision). Not built. Trash covers deletion.
- **"Delete forever"** (empty Trash before 30 days) isn't specified. Not built; KOBE-18 could add it.
- Should KOBE-30's message/run routes live in `routes/threads.ts` (ticket text) or in a runs module?
  Either works; the coordinator decides.

## Evidence (acceptance criteria → test or command output)

- ac-1: `src/openapi/document.test.ts` (committed doc = generated; documented operations = mounted
  routes; §6.1 fields present). `threads.db.test.ts` › "responses match the OpenAPI schemas"
  (every route's live response strictly parses against its documented schema).
- ac-2: › "history reads never wake sandboxes" (proxy deps).
- ac-3: › "authorization per role" (member/builder/team_admin allowed; install owner/admin and
  team-less user refused, and can't select the team; removed member refused at once; no session
  401). › "create" (`team_header_required`, `no_active_team`).
- ac-4: › "visibility" (team admin and builder get the same 404 as an unknown id on all 7 thread
  routes and don't see the thread listed). › "shared project threads" (reader access,
  `read_only` on change, unshared/trashed hidden, other team never, `not_in_project`, project list).
- ac-5: › "never reaches another team's thread" (same user in another team: 404 everywhere, empty
  list, rows stay in their team). › "stale tab" (`team_mismatch`). › "takes the team and owner
  from the session" (`team_id`/`owner_user_id` in body → 400).
- ac-6: › "list pagination": 9 threads, several sharing a µs timestamp and others 1 µs apart,
  walked at limits 1/2/3/4/100 equal the DB order exactly. Stable with a new and a bumped thread
  between pages. Malformed cursor/limits 400. Trash pagination. › "pages entries by seq".
- ac-7: › "Trash and restore" (idempotent delete, `purge_after` = +30 d, out of list, in Trash,
  owner-only Trash, `thread_in_trash`, restore, `not_in_trash`, past 30 d → 404, busy with
  running/waiting_approval/queued run).
- ac-8: `threads/schemas.test.ts` (strict bodies, bounds, entry ids, statuses equal DB and
  `@kobe/protocol` `THREAD_STATUSES`), `threads/cursor.test.ts`.
- Mutation checks: dropping the owner predicate fails 2 visibility tests; ms-precision cursors fail
  2 pagination tests.
- EXPLAIN (ANALYZE) as the app role under RLS, 2 teams × 100k threads, 200 owners: first page and
  cursor page → Index Scan on `threads_owner_activity_idx`, with the row comparison as an Index
  Cond (0.05–0.1 ms). Project list → BitmapOr of owner and project indexes (4 ms). Trash → Bitmap
  scan of `threads_deleted_idx`, filtered by owner (6 ms over 10k trashed rows in the team).
- Review round 1: `threads.db.test.ts` › "security review fixes" (offloaded entry → `{}` on
  both entry routes; a thread row held by another transaction → 409 `thread_busy` within 5 s
  on PATCH, leaf, DELETE and restore, reads unblocked, change succeeds after release; Trash past
  30 days → 404 on read, entries, PATCH, leaf, DELETE, restore). All three failed before the fix.
- Self-review (IDOR/authz): every route sits behind `requireTeam` + `team.chat`. Every query is
  inside `withTeam` with explicit `team_id` predicates. Ids come only from the path, and
  `team_id`/owner come from the session. Visibility is checked in the same transaction as the
  read or change, with the row lock held on changes. Found and fixed: a crafted cursor with a
  20-digit µs value could overflow Postgres bigint/timestamp arithmetic and give a 500. Cursors
  are now limited to 0–17 digits (tests in `cursor.test.ts` and the DB suite).
- `pnpm build test typecheck format:check` green. `lint` green except the pre-existing
  `@kobe/chart` failure (Helm 4 `license` field). `pnpm --filter @kobe/server test:db` 84/84 at
  first run (now 34 thread tests). `pnpm --filter @kobe/db test:db` 114/114.
