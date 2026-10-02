# KOBE-15: Append-only audit log

- **Status:** in review (PR #26)
- **Branch / worktree:** `kobe-15-audit-log` in `../Kobe-wt15`
- **Depends on:** KOBE-14, KOBE-13, KOBE-12, KOBE-45, KOBE-9, KOBE-11 (all merged)

## Acceptance criteria (derived from spec D6, D8, D31, §5.4, §6.1, Gate 2; Hadron unreachable)

1. **ac-1 Table:** `audit_log†(id, team_id?, actor_kind: user|agent|system, actor_id, action, target
jsonb, at)` per §5.4, install-wide, registered in the tenancy registry.
2. **ac-2 Append-only in Postgres:** the app role can INSERT and SELECT only. UPDATE, DELETE and
   TRUNCATE are denied, and the catalog/grants tests prove it. Tampering by a privileged DB user is
   at least detectable.
3. **ac-3 Same transaction:** a typed `audit()` API records an event inside the transaction of the
   action it records. A rolled-back action leaves no audit row, and a failed audit write fails the
   action.
4. **ac-4 Taxonomy and wiring:** existing code paths are audited: auth (sign-in/out, failed
   sign-in, passkey/TOTP changes, password reset), identity (invitations, membership and role
   changes, deactivation and reactivation, ownership transfer), install settings, isolation state
   changes, agents (create, import, update, delete, suspend, export, fork), restore, and, once on
   main, policy rules and switches (KOBE-35) and thread Trash, restore and sharing (KOBE-34).
5. **ac-5 Read APIs:** an install audit for Owner/Admin (`/v1/install/audit`) and a team audit view
   for team admins (`/v1/team/audit`) that shows only that team's events. Both use keyset
   pagination and filters.
6. **ac-6 Metadata only:** secrets, tokens, passwords, prompts and message text are never logged.
   There is a documented field allowlist.
7. **ac-7 Downstream-ready:** the record suits export and SIEM forwarding (KOBE-19). Break-glass and
   legal hold (KOBE-16/17) and later tickets have a documented way to record their events.
8. **ac-8 Backup:** `audit_log` is backed up, and restore keeps the append-only guarantees and the
   chain.

## Plan

- `@kobe/db`: `schema/audit.ts`, migrations `0011_audit_log` (generated) and
  `0012_audit_log_append_only` (custom: canonical form, append trigger, refusal triggers), grants
  in `tenancy/identity.ts`, `audit/` (events taxonomy, `audit()`, `auditStandalone()`, reads,
  `verifyAuditChain()`).
- Server: `audit/context.ts` (AsyncLocalStorage request context: actor, IP, UA), `audit/record.ts`
  (`recordAudit(tx, …)`, `recordAuditAfter(db, …)`), `audit/auth-plugin.ts` (Better Auth), and
  `audit/isolation.ts`. Routes `install-audit.ts` and `team-audit.ts`; permission
  `team.audit.read`. Each existing path gets one `recordAudit` call, as the last write in its
  transaction.
- CLI: the restore appends `platform.restore.completed` inside its transaction.
- Docs: `docs/audit-log.md` (design, record format, taxonomy and allowlist, developer contract,
  what later tickets must record, operations) and `packages/db/README.md`.

## Decisions

- **Tamper evidence = gapless seq + SHA-256 hash chain**, assigned in a `BEFORE INSERT` trigger
  under `pg_advisory_xact_lock(hashtextextended('kobe.audit_log', 0))`. The lock is held until
  commit, so seq is gapless and in commit order, and rollbacks leave no gap. Each row's hash covers
  `prev_hash` and its canonical form (`audit_log_canonical`: jsonb array text, `at` rendered in
  UTC). This beats a plain sequence: a sequence can't reveal edits, and it gaps on rollback.
  `verifyAuditChain()` (and `GET /v1/install/audit/integrity`) finds edited, deleted and
  re-chained rows. A whole-suffix rewrite or tail truncation by a superuser needs an external
  anchor (`head`), which KOBE-19 forwards. Cost: appends serialize until commit, so audit last and
  keep the transaction short. No SECURITY DEFINER (the catalog test forbids it); all triggers run
  as the invoker.
- **Append-only is enforced in three layers:** the grants (INSERT, SELECT), triggers refusing
  UPDATE/DELETE (row) and TRUNCATE (statement) for every role including the owner, and the chain.
  The app role can't set seq or hash (the trigger rejects non-default values) and can't write
  another team's events inside `withTeam` (the trigger checks `kobe.team_id`).
- **Team scoping = a nullable `team_id` column on the install-wide table plus a mandatory filter**
  in `listTeamAuditEvents()`, not a separate RLS team table. Reasons: install-level acts on a team
  (team creation, break-glass, legal hold) must appear in both views from one row and one chain,
  and team RLS would hide them from install admins. The table holds allowlisted metadata only. It
  is registered in `teamReferencing` with that reason. The team view drops `ip` and `user_agent`.
- **No foreign keys** on `audit_log`: records outlive their subjects, and restore can load them in
  any order.
- **Typed taxonomy with a strict per-action allowlist** (`AUDIT_EVENTS`, zod `strictObject`). Unknown
  keys or actions, a wrong team scope, or a missing or invalid actor throw `AuditEventError`, which
  fails the action. Unit tests check that action names match the DB check, that no field name
  suggests content or credentials, that every string is bounded, and that every action is
  documented.
- **Actor via AsyncLocalStorage:** `auditUserContext` (after `requireSession`) makes the session
  user the actor of everything audited in the request, so store functions needed no new
  parameters (one-line edits). Without a context and without an explicit actor, the write throws
  (fail closed). Unauthenticated routes (Better Auth, setup) pass the actor explicitly. They get IP
  and UA from `auditRequestContext`. The client IP is taken from X-Forwarded-For through the same
  trusted proxies Better Auth uses for rate limits.
- **Better Auth events are recorded after the endpoint** (`auditPlugin`, registered last so that
  it runs after two-factor's after hook), in their own transaction, best effort with failures
  logged at error level. Better Auth owns those writes, so they can't share a transaction. Reset
  request and reset use Better Auth's own callbacks. Failed sign-ins store the account id only
  when the email matches an account, and never the typed email.
- **Agents:** team-agent events carry the team (team view). Personal and gallery agents are
  install-level (`any` scope). `source` is json, import (markdown body) or fork, with
  `forkedFrom`. Export is a read, so it is recorded with `recordAuditAfter`.
- **Isolation:** the per-replica gate's transitions are recorded as system events, except the
  normal boot `checking → verified` (otherwise one row per replica per rollout). Nothing is
  recorded before first-run setup, so a fresh install about to be restored stays empty.
- **Backup/restore:** `audit_log` is backed up (it isn't excluded) and restored verbatim. The
  restore appends `platform.restore.completed` after re-enabling triggers, in the same transaction,
  so the chain continues and stays verifiable (round-trip test). `kobe backup` isn't recorded in
  the DB: the backup role is read-only.
- **Only real changes are recorded:** no event for a no-op role grant, re-deactivation, unchanged
  team role, or refused or failed action.
- Small behavior change: `reissueInvite`, `revokeInvite`, `issueInvite`, `reactivateUser`, the
  team rename and the install settings update now run in a transaction, so their audit row commits
  with them.

- **Policy (KOBE-35) and threads (KOBE-34), merged after this branch started:** rule
  create/update/delete (install, team, a member's own remember-rule) and the policy switch are
  recorded. Rules are recorded by `ruleId`, `scope`, `effect`, `toolGlob`, the arg-pattern entry
  count and `expiresAt`, never the note or the patterns. Thread Trash, restore and project sharing
  are recorded by ids only, never the title. Thread creation, renames and leaf changes aren't
  recorded: they are content activity, not governance.
- **Main was red when I merged it (KOBE-34 x KOBE-13):** `threads.db.test.ts` built deps without
  a mailer and added members through the removed `POST /v1/team/members`. Fixed in this branch the
  way KOBE-35's tests were fixed (invitation + accept, `MemoryMailer`). Store-level calls in
  `policy.db.test.ts` now run with an audit actor (`runWithAuditContext`).

## Review round 1 (coordinator security review; no CRITICAL/HIGH) — resolution

1. **Unauthenticated growth:** `AuthAttemptAudit` (per replica, in memory) aggregates failed
   sign-ins (all methods), 2FA challenges and reset requests per (action, method,
   account-or-none) and 5-minute window. The first attempt is recorded as itself, with its IP;
   the rest become one `auth.attempts.summarized` row (system; count, distinct IPs up to 1,000,
   window) when the window closes (flushed every minute and on shutdown). That is at most two
   rows per key and window, and keys are bounded by accounts. A crash loses the open windows'
   counts, but their first attempts are already recorded. Test: 30 failures for an unknown address
   and 30 for a real account, from 60 addresses, give 2 rows plus 2 summaries; a reset flood gives
   1 plus 1. Successful and state-changing events are never aggregated.
2. **Tamper evidence vs the owner:**
   - `AuditAnchorLogger`: every replica logs `audit chain head` (`seq`, `hash`, `at`, `mac`) at
     startup and every 5 minutes, after verifying the rows since its previous head and that the
     previous head is unchanged (error log `audit chain verification failed`).
   - `mac` = HMAC-SHA256(`seq:hash`) under a key derived from the auth secret (not in the
     database). `/v1/install/audit/integrity` returns the attested `anchor`; it is rate limited.
   - **Decision: no keyed hash in the DB.** The key would have to enter the DB session on every
     insert (visible to the owner and to statement logs) or go through SECURITY DEFINER, which is
     forbidden. Server-side attested anchors give the same protection for anchored heads.
   - Documented: operators ship the server log off the box until KOBE-19 forwards the anchors.
3. **Restore verifies the chain:** inside the restore transaction (after the triggers are back,
   before the restore event and COMMIT) a DO block checks seq continuity, `prev_hash` links and
   every row's hash.
   - The signed manifest now records the snapshot's head (`auditHead`), and the restored chain must
     end there.
   - `--expect-audit-head <seq>:<sha256>` must be contained in the restored chain.
   - `--operator` (default: the OS user) and the restored head go into `platform.restore.completed`,
     and the CLI prints the final head.
   - Tests: a tampered backup is refused with nothing restored; a wrong expected head is refused.
4. **Team isolation:** `listTeamAuditEvents(tx, query)` takes the withTeam transaction and matches
   `team_id = NULLIF(current_setting('kobe.team_id', true), '')::uuid`. The team is not a
   parameter. Outside withTeam it returns nothing, and a `teamId` in the query is ignored. Team
   view entries have no `ip`, `userAgent`, `prevHash` or `hash`. A cross-team probe test checks
   each team's view against the table.
5. **Personal data:** invitation events record the invitation id only (no invitee email). IP and
   user agent are kept for now; their retention is an open question with Chris (below).

- **LOW:**
  - Audited transactions without their own `lock_timeout` get 5 s for the chain lock (a caller's
    own timeout is kept). On expiry, `AuditBusyError` maps to 503 `audit_busy` and the action rolls
    back (tested).
  - `insertUserAllowRule` records `policy.rule.created` (scope `user`) and requires an `actor`
    parameter.
  - Category filter uses a stored generated `category` column with index `(category, seq)` (EXPLAIN
    test).
  - Recorded, not changed: Better Auth events are best effort, and there is no metric for lost
    writes yet; failures are logged at error level (`audit event could not be recorded`), so alert
    on that log line until a metrics stack exists (KOBE-10). Audit reads are not audited.
    `/update-user` (name and image) and passkey rename are not audited (profile cosmetics, no
    security effect); add them if Chris wants them.
- Merged origin/main again after #15 (thread search): audit migrations regenerated as `0014_audit_log` / `0015_audit_log_append_only`; the event-stream test fixture (KOBE-31) names the actor for its direct `createTeamWithAdmin` call.
- Merged origin/main (KOBE-20, main fix #25): `threads.db.test.ts` is main's. The web team audit
  nav uses `team.audit.read`.

## Open questions (for Chris or the coordinator)

- **IP / user-agent retention** in an append-only log (GDPR erasure vs. evidence): kept for now.
  Options are a retention period with a chain-preserving pruning procedure (verify from an anchored
  `(seq, prev_hash)`), or pseudonymizing IPs with a keyed hash. Raised with Chris by the
  coordinator.

- **Spec gap:** `actor_kind` has no "anonymous" value. Unauthenticated attempts use `user` with a
  null `actor_id` (failed sign-in, reset request). Is that OK, or add `anonymous`?
- **Audit retention** isn't specified (D18 covers content). v1 keeps the audit log forever, and
  nothing in the app can delete from it.
- **Observed pre-existing behavior (KOBE-12, not changed):** turning 2FA off signs the current
  browser out too. Better Auth's `/two-factor/disable` issues a new session and deletes the old
  one, and `auth.ts`'s after hook then deletes every session except the old token, which includes
  the new one. Intended?
- Reads of the audit log are not audited. Add `audit.read` if Chris wants that.

## Notes for later tickets

See `docs/audit-log.md` → "What later tickets must record". In short: call
`recordAudit(tx, { action, teamId?, target })` as the **last write in the transaction** that
performs the action, add the action and its minimal allowlisted target to `AUDIT_EVENTS`, and
document it. Code outside a request (jobs, scheduler, proxies) passes an explicit actor
(`SYSTEM_ACTOR`, or `{ kind: "agent", id }`). KOBE-16 must record every break-glass read with the
team's id. KOBE-19 pages with `listAuditEvents({ after })` and anchors `verifyAuditChain().head`.

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | `0011_audit_log.sql`; `tenancy.test.ts`; `catalog.db.test.ts` classifies every table, and the team-referencing allowlist covers it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ac-2 | `catalog.db.test.ts` "can only append to and read audit_log" (has_table_privilege matrix + triggers enabled) and "exactly the privileges in the grants matrix"; `packages/db/src/audit.db.test.ts` "denies UPDATE, DELETE and TRUNCATE" (42501 for the app role), "refuses … for the owner role too", "refuses caller-supplied" seq and hash, the hash chain describe (edited, deleted, re-chained rows detected; incremental verification)                                                                                                                                                                                                                                                                                                                                      |
| ac-3 | db: "rolls back with the action", "fails the action when the event is invalid", concurrent appends with rollbacks keep seq gapless and the chain valid; server: "rolls the action back when its audit row can't be written" (deactivation without an actor leaves the user active, with sessions and no row), "records nothing when the action fails (duplicate slug)"                                                                                                                                                                                                                                                                                                                                                                                                           |
| ac-4 | `services/server/src/audit.db.test.ts`: policy rules (install update/delete, team create/delete, member remember-rule revoke) and the switch, with no note or pattern recorded; thread Trash and restore (idempotent re-trash records nothing, no title); setup; failed sign-in (known and unknown email), sign-in, password change, sign-out, reset request and reset, 2FA enable, 2FA-required step, TOTP failure and success, backup codes, 2FA off, passkey add, sign-in and remove; team create and rename, install invitations (create, resend, accept, revoke), roles and ownership transfer, settings, deactivation and reactivation; team invitations, accept, role change, removal; agent create, import, fork, update, suspend, export, delete; isolation transitions |
| ac-5 | server "limits the install log to install admins" (403, keyset, category filter, 400s), "shows team admins only their team's events, without IPs" (two teams), "refuses the team view to non-admins"; db "shows a team only its own events…" (`teamId` in the query can't widen the view), filter tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ac-6 | server "stores only allowlisted target fields: no secrets, tokens or content anywhere" (every row checked against the allowlist; passwords, prompt, session tokens and invitation hashes absent); per-test checks that the wrong password, reset token, invite token and TOTP secret are absent; `events.test.ts` allowlist checks; `docs/audit-log.md`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ac-7 | `docs/audit-log.md` record format, keyset `after` paging and `verifyAuditChain` anchors (db tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ac-8 | `packages/cli/src/backup-restore.db.test.ts` round trip: audit rows restored verbatim, the restore event is appended as seq 3, the chain verifies, triggers are back (`O`), and the app role can't DELETE; `restore-sql.test.ts` ordering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| all  | `pnpm build test typecheck lint format:check license:check` green (the chart lint fails locally on Helm 4, as before); `test:db` for db (214), server (274) and cli (24) green (after merging #15; audit migrations are now 0014/0015); `db:check` clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
