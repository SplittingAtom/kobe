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
[docs/audit-log.md](../../docs/audit-log.md). The client IP and user agent are erased after the
install's retention period (default 12 h, KOBE-17): the hash covers a salted commitment to them
(chain v2), `eraseExpiredAuditPii(tx, pageSize)` is the server sweep's step and `sealAuditV1(db)`
seals the rows chained before the upgrade.

## Legal hold (KOBE-17)

`legal_holds` (install-wide) holds a team's data, or one user's data in a team, against every
purge (spec D18). Placing and releasing need a second install admin; the `legal_holds_guard`
trigger enforces that. **Every purge job (KOBE-18 retention and Trash, KOBE-28 offboarding
volumes, and any later one) must:**

1. call `lockLegalHolds(tx)` first in each purge transaction (shared advisory lock: an approval
   waits for purges in flight, later purges see the hold), and keep those transactions short;
2. skip held data: `isUnderLegalHold(tx, teamId, userId)` per item (without `userId` it is true
   when **any** hold exists in the team), `legalHoldsForTeam(tx, teamId)` for batches, or
   `WHERE NOT legal_hold_covers(team_id, owner_user_id)` in SQL;
3. treat SQLSTATE `KH001` (`LEGAL_HOLD_SQLSTATE`, `isLegalHoldViolation(err)`) as "held, skip";
4. record the purge's audit event **last**, after the deletes: lock order is legal-hold lock, then
   the audit chain lock (an approval takes them in that order); the reverse order can deadlock.

Backstop: deleting a held `threads` row or `thread_entries` rows, moving a held thread to another
owner or team, and truncating either table while any hold is active fail with `KH001`
(`threads_legal_hold*`, `thread_entries_legal_hold*` triggers). Moving a thread to Trash is an
update and stays allowed. Add the same guards to any new table a purge deletes from.

## Retention (KOBE-18)

`team_retention` (team period, `30d|90d|1y|forever`, no row = forever) and
`install_settings['retention.maximum']` (install maximum): the nightly job applies the shorter.
Purges queue the object keys of thread-owned blob columns (`BLOB_REF_COLUMNS` entries with
`thread: true`) in `retention_blob_deletions` inside the purge transaction; the bytes go later,
only when no registered column of the team references the key and no hold covers its owner. **A
table whose rows belong to a thread and hold object keys** (uploads, artifacts): reference the
thread as `(team_id, thread_id) → threads ON DELETE CASCADE` and register the column with
`thread: true`. `runs` and `run_events` have the same delete and TRUNCATE guards as threads and
entries (KH001 under hold). The jobs and the offboarding entry point (`purgeDepartedMember`, for
KOBE-28) are in `services/server/src/retention/`; design in `docs/ledger/KOBE-18.md`.

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
