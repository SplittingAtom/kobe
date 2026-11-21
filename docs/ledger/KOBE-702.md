# KOBE-702: Server shared helpers: pgCodeOf everywhere, one cursor codec, readCapped/SSE/actorOf, parseCanonicalInput

- **Status:** in review (group 59)
- **Branch / worktree:** `group-59-server-helpers` in `../Kobe-g59` (on top of group 55)
- **Depends on:** KOBE-704/736 (group 55, shared LISTEN client)

## Plan

Review findings CODE-16, 17, 19, 40 (approvals part): one definition per helper, no behaviour change
except where noted below.

## Decisions

- **pgCodeOf (CODE-16).** 22 local SQLSTATE readers removed from source (11 named `pgCode` copies in
  `artifacts/put`, `routes/me`, `files/share`, `gallery/seed`, `agents/store`, `agents/roster-transfer`,
  `skills/registry/settings`, `sso/mappings`, `uploads/store`, `sso/providers`, `sso/sign-in`, plus
  inline readers in `routes/site-teams`, `routes/projects`, `routes/project-from-folder`,
  `skills/drafts/service`, `skills/registry/review-approve`, `skills/registry/promote` (2),
  `sso/linking`, `packages/db` `audit/write`, `legal-hold`, `thread-search`) and the helper copies in
  27 `packages/db` db test files (`budget-reservations*` left alone: flaky-test lane). New in
  `pg-errors.ts`: `PG_UNIQUE_VIOLATION` and `isUniqueViolation(err, constraint?)`.
  Widening: the copies read `cause.code ?? code` (one level); `pgErrorOf` walks five levels and only
  accepts a SQLSTATE-shaped code. The only multi-level wrapper in the code base is
  `DatabaseConnectionLostError` (copies its cause's code, never a constraint violation), so no call
  site's outcome changes in practice; a unique violation wrapped twice would now give the intended
  `slug_taken` / `mapping_exists` / 409 instead of a 500. `sso/providers`, `sso/sign-in`, `sso/linking`
  already walked the chain but stopped at any string `code` (e.g. `ECONNRESET`); they now skip
  non-SQLSTATE codes. Left alone on purpose (not copies): `notifications/record.ts` logs whichever
  `code` it finds; `workspace-sync/routes.ts isTimeout` matches either of two codes at any depth;
  `test-support/lane.ts`, `wait.ts`, `models/leader-lock.ts` read raw `pg.Client` errors.
- **Cursor codec (CODE-17).** `makeCursorCodec(schema, { maxLength })` in `@kobe/db`
  (`cursor-codec.ts`): encode = base64url(JSON.stringify(value)), decode = undefined for empty,
  non-base64url, over `maxLength` (default 4096; threads keep 256), unparsable or wrong-shape input.
  Migrated 8 JSON cursors: workspace folder listing, memory items, agent roster, skill blocklist,
  team skill review, notifications, thread activity (threads + break-glass), thread search
  (`packages/db`). Each module keeps its public decode signature, so every endpoint keeps its
  documented bad-cursor answer: memory items still throws `invalid` (400), workspace files 400
  `invalid_request`, threads/break-glass 400 `invalid_cursor`, blocklist/review/notifications/roster
  400 `invalid_request`, thread search `ThreadSearchError("invalid_cursor")`. None falls back to the
  first page.
  New narrowing: a token over 4096 characters or with characters outside base64url (`=`, spaces)
  is now refused; no issued token has either. Wire format is byte-identical: `cursor-wire.test.ts`
  and `thread-search-cursor.test.ts` hold tokens produced by the old encoders.
  Not migrated: `routes/skill-drafts.ts` (pipe-delimited, not JSON), `kobe-mcp/catalog.ts` and
  `kobe-mcp/tools/team-reports.ts` (base64url decimal offsets), `memory/review/notes-approval.ts`
  (an HMAC-signed approval token, not a list cursor; verified by signature).
- **Small helpers (CODE-19).** `http/read-capped.ts`: `readCapped(res, max)` (Response; was in
  `connectors/probe`, `models/embedding-client`, `models/gateway-client`, used by `apps/app-caller`)
  and `readCappedStream(body, max)` (was `artifacts/serve readCappedBody`, `skills/drafts/from-workspace`,
  `routes/site-branding`). The stream variant destroys the stream on overflow; `from-workspace` did
  not (it then throws anyway, so only the socket is freed sooner). `http/sse.ts`: `SSE_HEADERS`,
  `nodeResponseDestroyer` (was in `run-events`, `workspace-changes` (+ `workspace-events`),
  `skill-evals`). `authz/actor.ts`: `actorOf` (was in `routes/approvals`, `runs`, `usage`,
  `thread-notebooks`, inline in `thread-branch-summary` and `thread-compact`).
- **parseCanonicalInput (CODE-40).** `approvals/canonical-input.ts`: JSON.parse, check the shape with
  `jsonObjectSchema`, return the value JSON.parse produced (never a re-serialised or rebuilt copy, so
  the signing path's canonical check sees the same object). Used by `approve-all`, `remember-options`,
  `view`, `decide` (2) and `broker`. A malformed row throws `CanonicalInputError` (was a SyntaxError;
  both a 500).

## Docs

No user-facing change: no `docs/guide` update needed.

## Evidence (acceptance criteria → test or command output)

- ac-1: `grep -rn "function pgCode\|const pgCode\|cause?.code ??" services/server/src packages/db/src`
  finds only `budget-reservations*` assertions and one log line in `thread-lock-order.db.test.ts`.
- ac-2: `packages/db/src/cursor-codec.test.ts` (malformed, wrong shape, oversize, at the limit, round
  trip); old-token tests in `services/server/src/cursor-wire.test.ts`, `packages/db/src/thread-search-cursor.test.ts`.
- ac-3: `http/read-capped.test.ts` (at cap, one over, multibyte split, both variants), `http/sse.test.ts`,
  `authz/actor.test.ts`.
- ac-4: `approvals/canonical-input.test.ts`; grep `JSON.parse(.*[Cc]anonical` in services/server/src: none.
- ac-5: see the results below.
- Results: `pnpm verify` green; server db suite (`KOBE_DB_TEST_WORKERS=2`) 267 files / 3306 tests
  passed; `packages/db` db tests of the 27 changed files 28 files / 371 tests passed; server unit
  suite 3857 passed.
