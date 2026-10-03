# @kobe/db

Drizzle schema, migrations, the tenancy registry (team RLS and app-role grants), `withTeam()`, the
cross-team probe suite, and the audit log API.

## Audit log (KOBE-15)

Every audited action calls `audit(tx, event)` with the transaction that performs it, so the action
and its audit row commit or roll back together (server code uses `recordAudit(tx, event)`, which
fills in the request's actor and client address). Events are typed by `AUDIT_EVENTS`: each action
has a strict allowlist of metadata fields, and anything else (secrets, tokens, prompts, message
text) is rejected. `audit_log` is append-only in Postgres (INSERT/SELECT grants, refusal triggers,
SHA-256 hash chain; `verifyAuditChain()`). Read with `listAuditEvents()` (install) and
`listTeamAuditEvents()` (team view).

Design, field allowlist, taxonomy and the events later tickets must add:
[docs/audit-log.md](../../docs/audit-log.md).

## Break-glass and the explicit team filter (KOBE-16)

`threads` and `thread_entries` have two RLS policies: the canonical `team_isolation` (all
commands) and `break_glass_read` (SELECT only, spec D10), which honors an approved, unexpired
break-glass grant for the named install admin. Team content is read under a grant only through
`readWithBreakGlass()`, which verifies the grant, writes the audit row and sets
`kobe.break_glass_grant` / `kobe.break_glass_actor`; the policies re-check the grant in Postgres.

**Rule: every query on `threads` and `thread_entries` states its team itself**
(`eq(threads.teamId, …)`, `WHERE team_id = ${teamId}`, or a join on `x.team_id = y.team_id`
from a team-filtered table), even inside `withTeam()`. Permissive policies are ORed, so a query
that leaves the team filter to RLS alone pays for the break-glass arm and, depending on the plan
Postgres picks, can lose the team-leading index. This is by design (Chris, KOBE-16 review): RLS
still guarantees isolation; the explicit filter keeps the plans.

Enforced by two tests in `services/server`:

- `team-filter.test.ts` scans `packages/db/src` and `services/server/src` and fails on a drizzle
  query (`.from/.update/.delete(threads|threadEntries)`) or raw SQL (`FROM`/`JOIN`/`UPDATE`/
  `DELETE FROM` those tables) without a team predicate in the same statement. A statement that
  genuinely needs none says why with `team-filter-ok: <reason>`.
- `threads-plans.db.test.ts` captures the SQL of the hot paths (thread list, Trash, lookup,
  entries, rename, leaf, sandbox-wire mirroring and restore, run lookup, search) and EXPLAINs it
  as the app role over 300 teams: no sequential scans, and every team-leading index is entered by
  an explicit team value. Add new hot queries there.

The settings are self-asserted by the app role: the policies limit what they expose (only that
grant's team and scope, SELECT only) but don't authenticate the admin or write the audit row; only
`readWithBreakGlass()` does. Never set them anywhere else.
