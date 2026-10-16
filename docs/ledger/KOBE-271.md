# KOBE-271: Audit a runtime tamper as a security event (runs and compactions)

- **Status:** committed on `group-1-fixes` (group G1; no PR of its own)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-15/17 (audit chain, IP/UA erasure), KOBE-41/71 (runtime check), KOBE-212/213 (compaction runs)

## Plan

The server records `runtime_tampered` as a run's failure in two places, both in
`services/server/src/sandbox-wire/delivery.ts`: `#endRun` (a message run's `run.start` answered
`runtime_tampered`) and `#endCompaction` (a `thread.compact_result` with that code). Each now also
writes `sandbox.runtime_tampered` in that same `withAppendTx` transaction, as its last write, through
`auditRuntimeTamperInTx` (`sandbox-wire/runtime-tamper.ts`, `recordAudit` underneath: hash chain).

## Decisions

- **No migration.** Audit actions are the `AUDIT_EVENTS` registry in `@kobe/db`; the database only
  checks the action's format and length (`0014_audit_log.sql`).
- **Target (ids only):** `sandboxId`, `userId` (sandbox owner, as every `sandbox.*` row), `threadId`,
  `runId`, `runKind` (message, compaction), `replicaId` (the wire's replica UUID holding the
  connection). The agent's reason text is never stored (it stays in the warn log only). Team scope:
  the team view shows it, and the site view always does. Actor `system`, so no IP/UA: the PII sweep
  has nothing to erase and the row is kept forever like every audit row.
- **Once per run:** the helper takes a transaction-scoped advisory lock on the run id
  (`hashtextextended('kobe.audit.runtime_tampered:<runId>')`) and writes only if no
  `sandbox.runtime_tampered` row names the run (same pattern as `connectors/drift-notify.ts`).
  Racing reports serialize on that lock even when the run row is gone (review LOW-3; first version
  locked the run row, which locks nothing for a deleted run); under READ COMMITTED the second sees
  the first's row. No unique index: that would be a migration on the append-only `audit_log`.
- **The event is not lost when the run end fails** (review LOW-2): if the end transaction throws
  (e.g. `lock_timeout` on the chain lock), `withTamperAudit` writes the row on its own, up to
  `TAMPER_AUDIT_ATTEMPTS` (3) times with a growing pause, still once per run, then rethrows for the
  existing error log. The run itself stays active until the lost-run sweep ends it (unchanged,
  as for any failed run end). If every write fails, an error log with `security: true` and the
  ids remains.
- **Written even when the run had already ended** (e.g. Stop while the sandbox prepared the run): the
  tamper still happened, so it is audited even though the run's status is not `failed`.
- **Out of scope:** a tamper found around a `pi.command` (KOBE-169,
  `services/sandbox-agent/src/threads/manager.ts:365-379`) fails only that command; the server
  neither ends the run nor audits it. Same security event: worth a follow-up ticket (review INFO-1).
- A message run's tamper has no `security: true` server log of its own (pre-existing; the audit row
  now covers it, review INFO-3).

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2: `services/server/src/runtime-tamper.db.test.ts` — message run (row with exact ids,
  system actor, null IP/UA/commitment, no reason text), compaction run, duplicate report (one row;
  a later run of the thread its own row), three racing first reports (one row), site view
  `listAuditEvents({action})` and team view `listTeamAuditEvents({action})`. Red without the
  `delivery.ts` change (4 of 5 failed), green with it. Review fixes: a refused audit insert
  (test trigger on `audit_log`) leaves the run active with no `run.failed` and no row (LOW-1); a
  first refused insert still yields the row on its own (LOW-2); two reports of a deleted run, the
  second started while the first's transaction is open, write one row (LOW-3; red before the
  advisory lock).
- `packages/db/src/audit/events.test.ts`: target shape (ids + run kind only, strict) and documented.
- `docs/audit-log.md`: taxonomy row plus how admins filter for it under "Reading the log".
