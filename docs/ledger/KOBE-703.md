# KOBE-703: Server routes: shared body/param parsing helpers; fix 500 on PUT /v1/team/budgets/eval-cap with a primitive body

- **Status:** in review (group 59)
- **Branch / worktree:** `group-59-server-helpers` in `../Kobe-g59`
- **Depends on:** KOBE-702

## Plan

Review CODE-18 and CODE-26. Mechanical migration, no handler restructured, every status code,
error code and message kept.

## Decisions

- `services/server/src/http/request.ts`: `readJson(c, fallback)` (the body, or `fallback` for a
  missing/invalid body: each call site passes the fallback it had: `null`, `undefined` or `{}`, so
  schemas that treat those differently behave as before), `parseBody(c, schema)` (moved from
  `teams/http.ts`), `invalidRequest(c, message?)` (was in `teams/http.ts` and `agents/http.ts`),
  `param(c, name, schema)` and `notFound(c, code, message)`.
- `param` returns the zod safe-parse result rather than `T | undefined`: every route keeps its own
  `.success` handling and its own refusal, so the migration of 252 parameter parses is a textual
  replacement (`X.safeParse(c.req.param("n"))` -> `param(c, "n", X)`) with no handler change. Each
  route keeps its schema: switching the `z.uuid()` sites to the lowercasing `uuidSchema` would change
  echoed ids, so that is left to the route-split ticket.
- Migrated: 30 `c.req.json().catch` sites (none left outside `readJson`), 252 param parses,
  10 single-line `invalid_request` bodies, 65 single-line 404 bodies (files that define their own
  `notFound` were skipped), 95 imports of `parseBody`/`invalidRequest` moved; 124 files, 109 of
  them in `routes/`. Multi-line hand-built bodies, bodies with extra fields (`issues`) and non-400
  `invalid_request` answers (413, 415, 411) were left as written.
- Left alone: `routes/run-events.ts` lowercases `:runId` before validating it (a mixed-case id is
  accepted there and nowhere else), `routes/site-team-members.ts` reads an optional `:userId`;
  the regex UUID checks in `routes/eval-thread-guard.ts` (middleware) and `agents/team-default.ts`
  (a stored setting, not a parameter); `workspace-sync/routes.ts` reads its body inside its own
  try (no `.catch`).
- Eval cap (CODE-26): only a JSON object can hold `evalCap`; any other body falls into the
  existing refusal with the existing message. User-facing change: a number or string body now
  answers 400 `invalid_request` instead of 500.

## Docs

No `docs/guide` change: the guide documents the eval cap, not its error statuses; nothing a member,
admin or agent sees changes except a 500 becoming the documented 400.

## Evidence (acceptance criteria → test or command output)

- ac-1: `budgets-eval-cap-body.db.test.ts`: 5, "x", [], null, {} answer 400 invalid_request with
  the route's message; `{evalCap: null}` answers 200. Red before the fix (5 and "x" were 500).
- ac-2: `http/request.test.ts` (invalid JSON, wrong type, array, null, number, string, no body;
  param; notFound).
- ac-3: `grep -rn "c.req.json().catch" services/server/src` finds only `http/request.ts`;
  `grep -rn "safeParse(c.req.param" services/server/src` finds only `http/request.ts`.
- ac-4: see results below (route db tests, `openapi/document.test.ts` in the unit suite).
- Results: `pnpm verify` green (includes the server unit suite with `openapi/document.test.ts`);
  server db suite 268 files / 3312 tests passed.
