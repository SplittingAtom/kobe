# KOBE-17: Legal hold (plus audit IP and user-agent erasure)

- **Status:** in review (PR #49), round 3
- **Branch / worktree:** `kobe-17-legal-hold` in `../Kobe-wt17`
- **Depends on:** KOBE-16, KOBE-15, KOBE-20, KOBE-11 (all merged)

## Acceptance criteria (Hadron KOBE-17, spec D18/D10/D6, user decision 2026-10-03)

1. **ac-1** Held data survives retention and soft-delete purge jobs.
2. **ac-2** Placing and releasing a hold requires the two-person rule when a second install admin
   exists (a single-admin install self-approves, flagged; D10).
3. **ac-3** Hold actions are audited.
4. **ac-4 (user decision)** The client IP and user agent of each audit row are erased after a
   configurable period (default 12 h, an audited install setting), by a background job, without
   breaking `verifyAuditChain`; rows are kept forever; an active hold suspends the erasure for the
   held team or user; `audit.pii_erased` records counts only.

## Design

### Legal holds

- **Table `legal_holds`** (install-wide †, §5.4 `legal_holds†(id, team_id, user_id?, reason,
placed_by, approved_by, released_at?)`), plus `status` (`pending`, `active`, `denied`,
  `withdrawn`, `released`), timestamps, `self_approved`, `closed_by` (denial/withdrawal), and the
  release request (`release_requested_by/_at`, `release_reason`, `released_by`,
  `release_self_approved`). Never deleted (SELECT/INSERT/UPDATE grants): it is the record behind
  the audit events. Install-wide for the same reasons as `break_glass_grants`: it exists before
  any team context, every install admin who may approve it must see it, and it holds ids and the
  requester's reason, never team content.
- **Scope:** `team_id` is required (spec). A team hold has no `user_id`; a user hold covers that
  user's data in that team. The user need not be a member any more (offboarding, KOBE-28, keeps
  a removed member's volume 30 days; a hold must be placeable on it).
- **Two-person rule in Postgres, over the ids written** (`legal_holds_guard`, SECURITY INVOKER,
  same rules and admin-set lock as `break_glass_grants_guard`; the approver ids are asserted by the
  writer, not authenticated: the server binds them to the session, see review round 2, L3): inserts start `pending` from an active install admin, the
  subject is not the requester; the request is immutable; `pending → active` by an active install
  admin who is not the subject, and the requester only when no other active install admin exists
  (`self_approved`); `pending → denied` (another admin) or `withdrawn` (the requester);
  `active → active` to open or cancel a release request; `active → released` approved by an active
  admin other than the release requester (again self-approval only on a single-admin install,
  flagged `release_self_approved`). A hold stays active while its release is pending.
- **Ordering against purges:** approving a hold takes `pg_advisory_xact_lock('kobe.legal_hold')`
  in the guard; every purge takes the same lock **shared** (`lockLegalHolds(tx)`, and the delete
  guards below) before it checks. So a purge that started before an approval finishes first, and
  one that starts after sees the hold. No purge can slip between "checked" and "deleted".
- **Consumer API (`@kobe/db`), for KOBE-18 and KOBE-28:**
  - `isUnderLegalHold(db, teamId, userId?)`: with a user, true when a team-wide hold or a hold on
    that user in that team is active; **without a user, true when any hold in the team is
    active** (conservative: a team-level purge must not run past a user hold).
  - `legalHoldsForTeam(db, teamId)` → `{ team: boolean, userIds: string[] }` for batch purges.
  - SQL `legal_hold_covers(team_id uuid, user_id uuid) → boolean` (STABLE) for a `WHERE NOT …`
    inside a purge query, and `lockLegalHolds(tx)` (shared lock) as the purge's first statement.
  - **Backstop in the database:** `BEFORE DELETE` on `threads` (per row: team + owner) and an
    `AFTER DELETE` statement trigger on `thread_entries` (transition table, team + thread owner)
    raise SQLSTATE `KH001` (`LEGAL_HOLD_SQLSTATE`) when the data is held. A purge that forgets
    the check fails loudly instead of deleting held data. Soft delete (Trash) is an UPDATE and
    stays allowed. `run_events` compaction (D18, 7 days) keeps the content in entries, so it is
    not guarded; KOBE-18 guards any further table it purges the same way.
- **Audit events (install scope, category `governance`):** `governance.legal_hold.requested`,
  `.placed`, `.denied`, `.withdrawn`, `.release_requested`, `.release_denied`,
  `.release_withdrawn`, `.released`. Targets: `holdId` only, plus
  `selfApproved` on placement and release (see review round 1).
- **Server:** `legal-hold/store.ts` (row locked `FOR UPDATE`, audit last),
  `routes/install-legal-hold.ts` under `/v1/install/legal-hold` (`install.legal_hold.manage`).
  A hold about an install admin is invisible to them (404), like a break-glass legal hold.
- **Web:** install section `legal-hold` (READY): request form (team, optional member, reason),
  table with approve/deny/withdraw, release request and release approve/deny/withdraw.

### Audit IP and user-agent erasure (chain v2)

The v1 hash covers `host(ip)` and `user_agent` directly, so nulling them breaks the row's hash.

- **Commitment instead of raw values.** New columns: `hash_version` (1 or 2), `pii_salt` (64 hex
  chars, 244 random bits from two `gen_random_uuid()`s, no extension needed) and
  `pii_commitment = sha256('kobe.audit.pii.v1' \n salt \n [id, host(ip), user_agent])`, both
  null when the row has neither field. The v2 row hash is
  `sha256('kobe.audit.v2' \n prev_hash \n [seq, id, at, team_id, actor_kind, actor_id, action,
target, pii_commitment])`: it covers the commitment, never the values or the salt.
- **Erasure** sets `ip`, `user_agent` and `pii_salt` to NULL together. The row hash still
  verifies (commitment unchanged); without the salt the commitment reveals nothing (2^244 guesses
  per address). While the values are present, the verifier checks them against the commitment, so
  an edited IP is still detected.
- **Who may erase.** The app role gets column-level `UPDATE (ip, user_agent, pii_salt)` (new
  `columnGrants` in the tenancy registry, applied by the migration runner). The `BEFORE UPDATE`
  trigger (fires for every role, owner included) allows exactly one change: those three columns
  to NULL, every other column unchanged, the row older than the configured period
  (`audit_pii_retention_hours()` reads the install setting, clamped to the bounds), and the row
  not held. DELETE and TRUNCATE stay refused; the app never deletes rows.
- **Held rows:** a row is held when its `team_id` is under a team-wide hold or a hold on its
  actor in that team, or when its actor is the subject of any active user hold (IP and user agent
  are the actor's personal data, so a user hold keeps the person's install-level rows such as
  sign-ins too).
- **Existing (v1) rows: sealed by the server, not the migration** (review round 2, H1). The
  migrations change no row: `hash_version` is nullable without a default, so every existing row
  reads NULL (= v1) at no cost. After the upgrade the server (`sealAuditV1`, in the sweeper)
  verifies the v1 rows strictly and appends `audit.chain.upgraded { throughSeq, rows, seal }`,
  `s_n = sha256('kobe.audit.seal.v1' \n s_{n-1} \n hash_n \n sha256(v2 view of row n))`. Stored
  v1 hashes are untouched, so every anchor already shipped off the box stays valid. A v1 row may be
  erased only 24 h after the seal (trigger, `audit_log_v1_erasable()`): previous-release replicas,
  which recompute v1 hashes, are gone by then (review M3). An erased v1 row (v1 hash no longer
  recomputable, values gone) passes only under a valid seal. A broken v1 chain is never sealed;
  the release isn't blocked (review M4; runbook in docs/audit-log.md). A fresh install has no v1
  rows: no seal, no event.
- **Rolling upgrade:** `audit_log_canonical(r)` is version-aware (v1 text when `hash_version` is
  NULL, v2 text for 2), so the previous release's anchor logger keeps verifying new rows.
- **Verification** (`verifyAuditChain`, Node hashing; restore uses the SQL twin
  `audit_log_chain_problem()`, same rules): v1 rows only before any v2 row, no salt/commitment,
  v1 hash matches or (values gone) the seal vouches; v2 hash, commitment when salted, no values
  without a salt; every `audit.chain.upgraded` matches the running seal (numeric `throughSeq`).
  New problems: `pii_mismatch`, `seal_mismatch`.
- **Backup and restore (KOBE-11):** rows are backed up and restored verbatim (salts included); the
  restore's in-transaction verification calls `audit_log_chain_problem()`, and the restore pauses
  the erasure for 24 h (`audit.pii_sweep_resume_at`) because holds are as of the backup (review L7;
  the CLI prints a warning). Backups taken before an erasure still hold those values (documented).
- **Job:** `AuditPiiSweeper` on every replica every 10 minutes; a transaction try-lock lets one
  replica sweep at a time. It seals once, then walks the log by `seq` from a stored position in
  pages of 5000 (≤ 100 a run), erases due rows, moves past held rows (no re-reads), and stops at
  the first row inside the period. A hold release (trigger) and v1 rows becoming erasable restart
  the walk once. `audit.pii_erased { rows, olderThanHours }` (system, counts only) per page that
  erased something.
- **Setting:** `install_settings['audit.pii_retention_hours']`, integer 1-8760 (zod at the API,
  clamped again in SQL), default 12; `PUT /v1/install/settings { auditPiiRetentionHours }`
  records `install.settings.updated` (`setting: audit_pii_retention_hours`).

## Design review of the chain change (before coding)

Adversary: a superuser or the owner with triggers disabled (the KOBE-15 threat model), and the
app role.

1. **Chain still verifies after erasure:** the v2 hash input has no IP, user agent or salt. ✔
2. **Edit while present:** changing `ip`/`user_agent` breaks the commitment (`pii_mismatch`);
   changing the commitment breaks the hash. Moving a (salt, ip, ua) triple to another row fails:
   the commitment binds the row id. ✔
3. **Hiding after erasure:** the salt goes with the values; brute force over IPv4 needs the salt.
   A commitment without salt (unsalted hash) was rejected for exactly that reason. ✔
4. **Fake erasure to skip a v1 hash check** (null the values of a v1 row, or pretend one never had
   any, then edit its target): the seal covers each v1 row's v2 view (target and commitment included). ✔
5. **Swap versions:** flipping `hash_version` changes which canonical text is hashed → mismatch;
   a v1 row after the upgrade event is flagged. ✔
6. **Early or targeted erasure by the app role:** the trigger refuses rows younger than the
   setting and held rows; lowering the setting is audited and bounded (≥ 1 h). A superuser can
   still erase early: that loses information but can't fake any other field; accepted and
   documented (the same actor could already rewrite rows; anchors are the defence).
7. **Old anchors:** stored v1 hashes are untouched, so heads logged before the upgrade still match
   (`--expect-audit-head` and the signed backup manifest keep working). ✔
8. **Whole-suffix rewrite:** unchanged from KOBE-15; only external anchors catch it. The seal
   lives in a chained v2 row, so anchors after the upgrade cover it. ✔
9. **Incremental verification from mid-v1 range** can't check the seal; erased v1 rows are then
   checked by links only. Full checks (`/integrity`, restore) start at seq 1. Accepted, documented.
10. **Race between a hold and an erasure or purge:** closed by the advisory lock (exclusive for
    approvals, shared for purges and erasure). ✔
11. **Restore order:** triggers disabled during the load, CHECK constraints still apply (salt
    format, salt ⇒ commitment, PII ⇒ salt); verification after the triggers are back. ✔
12. **Concurrent old-release writers during the migration:** the ALTERs lock the table; after
    commit every insert goes through the new trigger (v2). ✔

## Decisions

- **Hold events are install scope, and name neither the held user nor the reason.** The spec says
  nothing about legal hold in the team audit view (D10's banner is break-glass only). A hold is
  confidential by nature (break-glass's own legal-hold flag exists to keep the subject
  uninformed), and team admins may be the people held, so the team view shows nothing and no team
  admin is notified. Targets carry only `holdId` (and `selfApproved`), so a held install admin
  reading the install log learns nothing; the install console resolves the rest from the hold row. (docs/audit-log.md suggested `userId` in the target; left
  out for the same reason.)
- **A hold is invisible to the held user**, even an install admin (404 on list, detail and every
  action), as KOBE-16 does for break-glass legal holds. The held user can't approve, deny or
  release it (trigger too).
- **No notifications.** D18 asks for none; holds are confidential. Approvers see pending requests
  and release requests in the console.
- **No request lapse, no per-admin cap.** Unlike break-glass (a time-boxed read grant), a pending
  hold grants nothing; it waits until decided or withdrawn.
- **Releasing needs a second admin too** (brief + D18's "two-person rule as D10"); a single-admin
  install self-approves, flagged `release_self_approved`. The hold stays in force while a release
  is pending. A release request can be denied (another admin) or withdrawn (its requester); the
  trigger allows cancelling without checking who, since that keeps the hold in force.
- **`team_id` is required** (§5.4); a user hold covers that user's data in that team. The user need
  not be a current member (KOBE-28 keeps a removed member's volume 30 days).
- **`isUnderLegalHold(team)` without a user is true for any hold in the team** (conservative for
  team-level purges); `legalHoldsForTeam` exists to purge around user holds.
- **Delete guards on `threads` and `thread_entries` only.** `run_events` compaction (D18, 7 days)
  keeps the content in entries; other purgeable tables (files, artifacts, memory) don't exist yet:
  KOBE-18 adds guards for what it purges.
- **Audit erasure scope of a hold:** a team hold keeps rows recorded under the team; a user hold
  keeps every row the user is the actor of (any team, and install-level rows such as sign-ins).
  A team hold does not keep members' install-level rows (no membership lookup across RLS); place a
  user hold for that.
- **Erasure, not pseudonymization:** the values and the salt are nulled; the commitment stays.
  A keyed pseudonym would need a key in or near the database (rejected in KOBE-15 for the same
  reasons as a keyed chain).
- **Retention bounds 1-8760 h** (zod at the API, clamped again in SQL), default 12 h. A PUT records
  `install.settings.updated` for each setting it carries, as the route already did for 2FA.
- **A broken v1 chain is never sealed** (sealing would make the break undetectable once rows are
  erased). Round 1 made the migration refuse to upgrade; round 2 moved the check to the server so
  a broken chain can't block a release (the v1 rows then keep their IP addresses; runbook).
- **Column grants in the tenancy registry** (`columnGrants`), applied by the migration runner and
  pinned exactly by the catalog check. `has_table_privilege(app, 'audit_log', 'UPDATE')` stays
  false.
- **CLI restore** now verifies with `audit_log_chain_problem()`; the error names the problem kind
  (`hash_mismatch`, …) instead of a sentence.

## Review round 1 (security-review subagent; no CRITICAL/HIGH)

- **MEDIUM, a hold on the only other admin could never be placed** (the held admin counted as
  "a second admin" but can't approve): the held user no longer counts, in the trigger
  (`legal_hold_other_admin_exists(who, subject)`) and the server (`mayApproveOwn`); the requester
  places it alone, flagged. Tests in db and server.
- **MEDIUM, migration cost:** one UPDATE pass sets version, salt and commitment together (one row
  version per row); `LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE` first, so no row is appended
  between the v1 verification and the seal. (`ADD COLUMN … DEFAULT 2` is metadata-only on PG 11+;
  only the UPDATE rewrites.) Expected cost: one pass over `audit_log` while appends wait; v1 has no
  production installs yet.
- **MEDIUM-LOW, sweep cost with many held rows:** `audit_log_pii_held` is one indexed EXISTS
  (team-wide hold on the row's team, or any hold on its actor), same semantics.
- **LOW, held admin inferring a hold from the install log:** hold events now carry `holdId` only
  (plus `selfApproved`), no team or scope.
- **LOW, SQL/Node divergence on `throughSeq`:** SQL now requires a JSON number too.
- **LOW, docs:** dead tuples/WAL keep erased values until vacuum/archive expiry; rollback after the
  first sweep unsupported; purges record their audit event last (lock order) — in
  `docs/audit-log.md` and `packages/db/README.md`.
- Recorded, not changed: a pending hold suspends nothing (only an approved one does; D18 makes the
  hold an install-admin two-person act); approver ids are asserted by the app role (as for
  break-glass); a team hold has no subject, so an install admin who is a member of the held team
  can still act on it (D18 doesn't exclude them); `host(ip)` drops a netmask (Kobe stores host
  addresses only).

## Review round 2 (coordinator's independent DB review; chain design confirmed sound)

- **H1 lock window:** confirmed in drizzle (`pg-core/dialect.js` `migrate()`: one transaction for
  all pending migrations), so the first ADD COLUMN's lock lasts to COMMIT. Now nothing in KOBE-17's migrations is
  proportional to the log: nullable columns without defaults (v1 = NULL), `NOT VALID` constraints,
  no index (the sweep walks the primary key from a stored position instead of a partial index), no
  verification, no backfill, no seal (moved to the server). The redundant `LOCK TABLE` is gone.
  Test `audit-upgrade.db.test.ts` › "constant lock window": on a 100k-row log, no row version
  (`xmin`), table file (`relfilenode`) or index file changes and the seven constraints stay
  unvalidated; measured 128 ms for all three migrations.
- **H2 sweep cost:** no `held` count; held rows are passed once and not re-read (stored position);
  one replica at a time (`pg_try_advisory_xact_lock('kobe.audit.pii_sweep')`), tested.
- **M1:** `held` dropped from `audit.pii_erased`.
- **M2:** `threads_legal_hold_owner` (BEFORE UPDATE OF team_id, owner_user_id) refuses re-owning
  a held thread (KH001); tested (title updates and Trash still work).
- **M3:** v1 rows erasable only 24 h after the seal (trigger + sweep).
- **M4:** the migration no longer reads rows, so a broken chain can't block a release; the seal is
  refused and logged; runbook in docs/audit-log.md ("If the chain is broken"). No switch to seal a
  broken chain (it would hide the break once rows are erased).
- **L5:** BEFORE TRUNCATE guards on `threads` and `thread_entries` while any hold is active
  (owner included; the app role has no TRUNCATE); tested.
- **L7:** restore pauses the erasure 24 h and the CLI prints a warning to re-place holds placed
  after the backup; tested (restore-sql unit test, CLI db test).
- **L4:** constraint `audit_log_ip_host`: only host addresses (full mask) are stored, so
  `host(ip)` in the commitment loses nothing (`normalizeIp` already stored bare addresses).
- **Known risks, recorded (not changed):**
  - **L1 index churn:** erasure updates each row once (`ip`, `user_agent`, `pii_salt`); the
    indexed columns don't change, but non-HOT updates still add index entries; autovacuum cleans
    up. Documented.
  - **L2:** the app role can shorten retention (to ≥ 1 h; the setting change is audited) and a
    pending hold doesn't pause erasure (only an approved one does).
  - **L3:** the trigger checks the ids it is given (distinct, active admins), not who the caller
    is: a compromised app role could write another admin as approver (same as break-glass). The
    server binds the ids to the authenticated session. Wording in the legal_hold_guard migration and this ledger corrected.
  - **L6 lock ordering:** approvals take the legal-hold lock then the audit chain lock; purges must
    do the same (audit last), documented in `packages/db/README.md`; Postgres resolves a deadlock by
    aborting one side. A long purge transaction delays approvals (30 s lock timeout), hence short
    purge transactions.

## Review round 3 (coordinator re-review of f5e1ad5)

- **N1 forged seal (MEDIUM):** the append trigger now validates `audit.chain.upgraded`: system
  actor, no team, v1 rows exist, the v1 rows verify (seq, links, v1 hashes, no salt), `throughSeq`,
  `rows` and `seal` equal the values it recomputes (`audit_log_v1_seal()`, read before the chain
  lock, so other appends don't wait), and no such event exists yet (checked under the chain lock).
  So the app role can't forge, pre-empt, duplicate or use it to seal a broken chain, and the row is
  the real seal for every non-superuser writer: `sealAuditV1`'s "already sealed" and
  `audit_log_v1_erasable()` match it by shape too (`audit_log_is_seal`). Both verifiers take the
  first upgrade event as the seal and report a second as `extra_seal` (only reachable past the
  triggers). Tests: forged `{}`, wrong seal and non-system rows refused (real seal still written
  afterwards); a correct-content duplicate refused; a seal over a broken chain refused by the
  trigger; a smuggled second seal → `extra_seal` in Node and SQL. Cost: sealing reads the v1 rows
  once more inside the sealer's transaction (once per install).
- **N2 lost cursor reset (MEDIUM):** the release branch of `legal_holds_guard` takes the exclusive
  `kobe.legal_hold` lock before resetting `audit.pii_sweep_seq`; a sweep holds it shared while it
  reads and writes its position, so the reset always lands after. Race test: a release blocks on a
  sweep in flight, the sweep writes its position and commits, the release's reset wins (verified to
  fail without the lock).
- **LOW pause value:** `audit.pii_sweep_resume_at` is parsed strictly in Node (UTC ISO as `kobe
restore` writes it); anything else pauses nothing instead of making every sweep throw (test).
- **Known risk, recorded:** a compromised app role can stall the erasure through `install_settings`
  (a far-future `audit.pii_sweep_resume_at`, a position past the head, or a long retention): it
  holds INSERT/UPDATE there by design. Each only keeps data longer (privacy, not integrity); the
  retention change is audited, the other two keys aren't settings an admin can edit through the API.

## Merge with main (KOBE-37, #48)

Merged origin/main with `db:rebase`: KOBE-17's migrations are now `0032_legal_hold` (generated),
`0033_legal_hold_guard` and `0034_audit_pii_commitments` (custom), unchanged in content. Conflicts
(both sides added lines) resolved by keeping both: the approvals sweeper next to the audit PII
sweeper in `services/server/src/index.ts`, the `approval` and `audit` categories, and the
`docs/audit-log.md` tables (main's rows plus the KOBE-17 rows).

## Open questions (for Chris or the coordinator)

- **Pending holds** protect nothing until approved (erasure and purges continue meanwhile). Should a
  pending hold already suspend the IP erasure?

- **Backups keep IP addresses** taken before erasure for as long as backups are kept. Documented
  (keep backups no longer than the privacy period requires); a shorter backup retention or a
  backup-time erasure would be a KOBE-11 follow-up if wanted.
- **Superuser early erasure** is not detectable as such (it loses information, it can't forge).
  Acceptable?
- **Team hold vs members' sign-in IPs:** should a team hold also keep the install-level rows of
  the team's members? Currently no (see Decisions).
- **Hold notifications:** none, by confidentiality. Should other install admins be emailed when a
  hold or a release waits for them (as break-glass does)?

## Notes for KOBE-18 and KOBE-28

See `packages/db/README.md` ("Legal hold"). In each purge transaction: `lockLegalHolds(tx)` first,
skip held data (`isUnderLegalHold(tx, teamId, userId)`, `legalHoldsForTeam`, or
`WHERE NOT legal_hold_covers(team_id, owner_user_id)`), keep transactions short, treat SQLSTATE
`KH001` (`isLegalHoldViolation`) as "held". Deleting held `threads`/`thread_entries` rows fails in
Postgres. KOBE-28: check `isUnderLegalHold(tx, teamId, userId)` before deleting a retained volume
(and before marking it gone); a hold placed during the 30 days keeps the PVC. Add the same delete
guard to any new table you purge (`files`, `artifacts`, `memory_docs`, …).

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | db `legal-hold.db.test.ts` › held data survives purges: held user's thread and entries can't be deleted (KH001) while others' go; whole-team hold; Trash still allowed; released → purge works; an approval waits for a purge holding the shared lock and later purges see it. server `legal-hold.db.test.ts` › "refuses to delete the held team's threads until the hold is released"; consumer API tests (`isUnderLegalHold`, `legalHoldsForTeam`, `legal_hold_covers`); owner/team change of a held thread refused (M2); TRUNCATE refused while a hold is active (L5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ac-2 | db guard tests: pending start, self-approval refused while another admin exists, plain user / held user can't approve, single-admin self-approval (place and release) flagged, release only through a request approved by another admin, cancel keeps the hold, deny/withdraw rules, immutable request, no DELETE. server: same flows through `/v1/install/legal-hold` incl. 403 for non-admins, validation, invisibility to the held admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ac-3 | server: every step's audit row (actor, install scope, `holdId`/`teamId`/`scope`/`selfApproved`, IP), no subject id or reason in any target; none in the team audit view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ac-4 | db `audit-pii.db.test.ts` (14): salted commitments, caller-supplied values refused, erasure only past the period / not held / all three columns, owner bound too, both verifiers OK after erasure and detecting a changed or restored IP, an edit next to an erasure, a swapped commitment; sweep walks from its position, skips held rows without re-reading, restarts on release, one replica at a time, paused after a restore; setting clamped. db `audit-upgrade.db.test.ts` (10): constant lock window on 100k rows (no xmin/relfilenode/index change, constraints NOT VALID, 128 ms), v1 hashes unchanged and verifying, v1 not erasable before the seal, sealed once by the server, new rows v2, verifies after v1 erasure, edited/fake-erased v1 row → `seal_mismatch`, salted v1 row → `pii_mismatch`, v1 after v2 → `hash_mismatch`, broken chain upgrades but is never sealed, erased v1 row without seal refused, fresh install stays empty. server `audit-pii.db.test.ts` (4): setting bounds and audit, sweep erases / keeps held / counts only, release lets it go, integrity OK and API shows no IP. cli: restore pauses the erasure 24 h (unit + db), fixture has an erased row (db job in CI) |
| UI   | web `legal-hold-page.test.tsx` (4): request with user and reason, place + flagged self-approval shown, ask to release with reason, approve another's release, retention setting saved; `registry.test.ts` (READY ⇔ page)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| all  | `build`, `typecheck`, `lint` (except the pre-existing Helm 4 `@kobe/chart#lint`), `format:check`, `license:check` green; `pnpm test --concurrency=2` green; `test:db` db 438, server 490; `db:check` clean; `scripts/check-public-hygiene.sh` ok; PR #49 CI green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
