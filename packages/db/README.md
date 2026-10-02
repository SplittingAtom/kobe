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
