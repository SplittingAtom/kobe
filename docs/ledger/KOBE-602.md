# KOBE-602: EA-1: Egress requests off the ceiling, decisions from the card, internal flag

- **Status:** in review (committed on the branch; coordinator opens the PR)
- **Branch / worktree:** `kobe-602-egress` in `../Kobe-wt602`
- **Spec:** `docs/specs/egress-access.md` §3 and the data part of §4 (EA1-EA4)

## What changed

- **Migration `0203_egress_access`** (generated): `egress_domains.internal boolean NOT NULL DEFAULT
false` (site table); `egress_requests.scope text NOT NULL DEFAULT 'team'` checked IN
  (`team`,`site`) and `egress_requests.internal boolean NOT NULL DEFAULT false`, checked
  `NOT internal OR scope = 'site'`. Existing rows backfill to team scope, not internal. No RLS change
  (egress_requests keeps its team policy; egress_domains stays site-wide).
- **Protocol:** `egress.blocked` gains optional `reason` (`EGRESS_BLOCKED_REASONS`:
  `not_enabled`, `not_in_ceiling`, `forbidden_address`). Additive.
- **Relay** (`blocked-relay.ts`, `blockedPayload`): forwards a known `reason`, and sets
  `request_access` true for a fixable reason on a host name (so it is right even with an older
  proxy); a row without a reason keeps the proxy's flag.
- **`POST /v1/egress/requests`** accepts `reason?`. Target: host already reachable →
  `409 already_enabled` (for `forbidden_address` only if the matching pattern is also internal);
  in the ceiling → `scope: team`, the ceiling pattern, team admins emailed; outside → `scope: site`,
  pattern = host, every active site admin/owner emailed (same outbox; delivery checks the recipient
  still holds a site role); `forbidden_address` → `scope: site, internal: true`.
- **`POST /v1/egress/requests/:id/decision {decision, pattern?, internal?}`** (active team) and
  **`POST /v1/site/egress-ceiling/requests/:teamId/:id/decision`** (site console, any team), one
  core `decideEgressRequest`. Team console `POST /v1/team/egress/requests/:id` uses it too.
- **`GET /v1/site/egress-ceiling/requests?status=`**: site-scope requests across teams, each with
  `team: {id, name}`.
- **`PUT /v1/site/egress-ceiling/:domain {in_ceiling?, internal?}`** (at least one); ceiling
  entries carry `internal`.
- **Audit:** `egress.request.created` + `scope`, `internal?`; `egress.request.decided` +
  `requested?`, `by`, `internal?`; new `egress.ceiling.internal_changed {domain, internal}`.
- **OpenAPI:** `openapi/egress-access.ts` documents the request routes, both decision routes, the
  site list and the ceiling PUT; regenerated with `UPDATE_OPENAPI=1`.

## Decisions

- Decision rules (server-side, whatever the UI shows): caller must be site admin
  (`site.egress.manage`) or team admin (`team.egress.manage`) of the active team, else 403
  `forbidden`. Team admin: `site_admin_required` (403) on a site-scope request (approve and deny),
  `internal_not_allowed` (403) on `internal: true`, `not_in_ceiling` (409) when the pattern is not in
  the ceiling. Pattern (approve only; default the request's): `parseDomainPattern` (public suffix,
  two labels after `*.`) → 422 `invalid_pattern`; `patternMatches(pattern, host)` → 422
  `pattern_not_covering`.
- Site admin approve: ceiling upsert under `LOCK TABLE egress_domains SHARE ROW EXCLUSIVE` (cap 500
  → 409 `too_many_domains`), insert or put back in (`ceiling: "added" | "restored"`), `internal: true`
  marks it internal; `internal` false/absent never clears an existing flag (clearing is the
  console's PUT). Then team enablement. NOTIFY: ceiling (`null`) and team, as the consoles.
- Approve settles every pending request in the team the pattern allows (same pattern, or a host it
  covers; an internal request only when the pattern is internal). Deny settles pending requests
  for the request's own pattern. Pattern advisory locks taken in sorted order.
- A site admin who is also team admin deciding from the team console decides as a site admin.
- Requester emails now say "An admin enabled/denied" (site admins decide too).

## For KOBE-603 / KOBE-604

- Column is `egress_domains.internal` (as 603 reads it).
- Card: send `POST /v1/egress/requests {domain, thread_id?, reason?}`; response `request` has
  `scope` and `internal`. Decide with `POST /v1/egress/requests/:id/decision`; 200 body
  `{request, settled, enabled, pattern, ceiling: "added"|"restored"|null, internal}`.
- Site console: `GET /v1/site/egress-ceiling/requests`, decide with
  `POST /v1/site/egress-ceiling/requests/:teamId/:id/decision`, toggle with
  `PUT /v1/site/egress-ceiling/:domain {internal}`.

## Evidence

- ac-1: `packages/db/src/egress-access-upgrade.db.test.ts` (populated upgrade, app role, checks,
  RLS); db package `test:db` incl. the probe suite.
- ac-2/ac-3: `services/server/src/egress-access.db.test.ts`; existing `egress-requests.db.test.ts`
  and `egress.db.test.ts` updated.
- ac-4: `egress/blocked-relay.test.ts`, protocol `events.test.ts`, `openapi/document.test.ts`.
