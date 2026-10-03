# KOBE-16: Break-glass (two-person, time-boxed, notified)

- **Status:** in review
- **Branch / worktree:** `kobe-16-break-glass` in `../Kobe-wt16`
- **Depends on:** KOBE-15, KOBE-14, KOBE-13, KOBE-20, KOBE-34, KOBE-33, KOBE-8 (all merged)

## Acceptance criteria (derived from spec D8, D10, §5.4, §6.1, U13, Gate 2; Hadron unreachable)

1. **ac-1 Request:** an install Admin or the Owner requests read access to one team, optionally one
   user or one thread, with a written reason, a duration (1 h default, 24 h max) and an optional
   legal-hold flag.
2. **ac-2 Two-person approval:** a second Admin or the Owner approves; self-approval is refused
   while another active install admin exists; a single-admin install self-approves and the grant
   is flagged (D10).
3. **ac-3 Time box and revocation:** access starts at approval and ends at `expires_at` without any
   job; any install admin can revoke; both are re-checked on every request.
4. **ac-4 Read-only, own routes only:** team content is read only through
   `/v1/install/break-glass/{id}/threads…` (GET), never through normal team routes; no write,
   impersonation or connector use.
5. **ac-5 Enforced in the data layer:** the grant is verified inside the read's transaction before
   the team context is set; the two-person rule and transitions hold in Postgres.
6. **ac-6 Every read audited** under the team's id, visible in the team's audit view; the team view
   shows a banner for active grants.
7. **ac-7 Notifications:** team admins of the team and install admins (email; no in-app centre
   exists), the subject user unless legal hold.
8. **ac-8 Consoles:** install page (request, approve/deny/revoke, reader) and team page (banner,
   history) through the KOBE-20 registry.

## Design

- **Table `break_glass_grants` (install-wide, §5.4 †, confirmed against D6/D10):** a request must
  exist before any team context and be visible to every install admin who may approve it; it holds
  ids and the requester's reason, never team content. Registered in `tenancy/identity.ts` with
  grants SELECT/INSERT/UPDATE (never deleted: it is the record behind the audit events) and a
  team-referencing reason. Columns per §5.4 plus `status`, `duration_minutes`, `self_approved`,
  `request_expires_at`, `decided_at/by`, `ended_at`. Check constraints: one narrowing at most,
  subject ≠ requester, `(approver = requester) = self_approved`, window ≤ 24 h.
- **Guard trigger `break_glass_grants_guard` (migration `*_break_glass_guard.sql`, 0022 after the latest rebase; SECURITY INVOKER):** inserts start
  `pending` from an active install admin, with DB-stamped times; the request (team, scope, reason,
  duration, legal hold) is immutable; transitions pending→approved|denied|revoked|expired and
  approved→revoked|expired only. On approval: approver is an active install admin and not the
  subject; approver = requester only when no other active install admin exists (then
  `self_approved`); the DB sets `starts_at = now()`, `expires_at = now() + duration`. Denial by the
  requester is refused (they withdraw = revoke). Expiry only after the deadline/window.
- **RLS read path (D10: "a row that RLS policies honor only while unexpired, for the named admin,
  read-only"):** function `break_glass_active_grant()` (SECURITY INVOKER) returns the grant named
  by the transaction-local `kobe.break_glass_grant`, only if it is approved, `starts_at <= now() <
expires_at`, requested by `kobe.break_glass_actor`, who is still an active install admin.
  `break_glass_read` policies, **FOR SELECT only**, on the tables in `BREAK_GLASS_READABLE_TABLES`
  (`threads`, `thread_entries`) match that grant's team and scope (owner for user grants, id for
  thread grants; entries follow their thread). There is no INSERT/UPDATE/DELETE policy for a grant,
  and break-glass never sets `kobe.team_id`, so the canonical team policy (unchanged) matches
  nothing: writes are impossible. The sub-selects are uncorrelated init plans (one grant lookup
  per query); normal team queries pay one empty lookup on these two tables.
- **`readWithBreakGlass(db, {grantId, adminId, request}, read)` in `@kobe/db`:** one transaction
  per read: (1) sets the two settings; (2) `SELECT … FOR SHARE` the grant (approved, in window,
  this admin, active install admin) for a clear error and to make a revocation wait for the read;
  (3) `audit()` `governance.break_glass.read` (the only write); (4) `SET LOCAL
transaction_read_only = on`; (5) the read, filtered by RLS and again by the query. The
  transaction is never handed out. Out-of-scope → `not_found`, rollback (no audit row).
- **Catalog check and probe suite:** every team table has the canonical policy; the readable ones
  also exactly one `break_glass_read` (cmd SELECT, no WITH CHECK). The probe suite, under an
  approved grant for team A, checks every team table: readable ones show only team A's rows,
  others nothing, another actor naming the grant sees nothing, inserts are RLS violations, updates
  and deletes touch 0 rows, and a revoked grant shows nothing.
- **Admin-set lock:** "is there a second active admin?" is serialized: the approval branch of the
  guard takes `pg_advisory_xact_lock('kobe.install_admin_set')` and share-locks the other active
  admins' `install_roles`/`users` rows; statement triggers on `install_roles` (any change) and on
  `users` (`UPDATE OF deactivated_at`) take the same lock. A self-approval racing a promotion or
  reactivation therefore sees it (test).
- **Durable notifications:** `break_glass_notifications` (install-wide outbox, one row per
  recipient, ids only). Rows are written in the grant's transaction (`enqueueNotifications`, before
  the audit row, which records `recipients` and, for events that reach the team, `teamAdmins`).
  Delivery (`deliverBreakGlassNotifications`) runs right after commit and from the sweep on every
  replica: rows are claimed with a 5-min lease (`SKIP LOCKED`), sent, marked `sent`; a failure
  backs off (2^n min, ≤ 60) up to 8 attempts, then `failed` + `governance.break_glass.notification_failed`
  (system) + an error log. A deactivated recipient is `skipped`. Expiry runs one grant per
  transaction (each needs its own team context to find team admins).
- **Limits:** at most 3 open requests per admin (advisory lock per admin; 429 `too_many_pending`);
  120 reads per admin per minute across replicas (`rate_limits`; 429 `rate_limited`). Revocation
  outranks reads: 30 s lock timeout (reads: 5 s) and up to 3 retries of a busy audit chain; a test
  revokes during 30 concurrent reads.
- **Server:** `break-glass/store.ts` (request, approve, deny, revoke with the row locked
  `FOR UPDATE`; expiry; audit last), `outbox.ts`, `notify.ts` (message text), `sweeper.ts`
  (every minute, started in `index.ts`), routes `install-break-glass.ts` and
  `team-break-glass.ts`. Permission `install.break_glass.approve` (admin) added next to
  `install.break_glass.request`. The approval response carries `notified` and `warnings`
  (`no_team_admin_notified` when no active team admin could be told; approval is still allowed).
- **Audit taxonomy:** `governance.break_glass.{requested,approved,denied,revoked,expired,read}`,
  all team scope (category `governance`). Targets are ids/enums/booleans; the reason is never
  logged (it stays in the grant row).
- **Web:** install section `break-glass` flipped to READY (request form, grants table with
  approve/deny/withdraw/revoke, read-only reader with threads and entries); new team section
  `break-glass` ("Break-glass access", `team.audit.read`) with one banner per active grant and the
  history; team section `audit` flipped to READY: the team audit view (`/v1/team/audit`, newest
  first, load more) with `BreakGlassBanners` for every active grant on top (in-app notice, D10).

## Decisions

- **Self-approval follows D10, not a blanket ban:** the brief said "no self-approval"; the spec
  says single-admin installs self-approve and are flagged. Refused (403 `self_approval_forbidden`,
  and in the trigger) whenever another **active** Owner/Admin exists (coordinator: "when one
  exists" means an active one; an Owner plus a deactivated Admin must still be able to act); allowed
  and flagged otherwise. Consequence: an Owner could deactivate the only other admin, self-approve
  and reactivate them. Every step is audited (`identity.user.deactivated`, the flagged approval);
  accepted. One person holding two accounts is out of scope (can't be detected).
- **Enforcement in RLS (D10), plus a closed reader:** see Design. The app-side grant check stays
  for clear errors and for the share lock that orders revocation after in-flight reads.
- **Audit before read, then read-only:** Postgres can't turn a read-only transaction back to
  read-write, so the audit row is written before switching to read-only. The audit chain lock is
  therefore held during the read; reads are bounded (≤ 100 threads / 200 entries, 10 s statement
  timeout).
- **Pending requests lapse after 24 h** (request TTL) and are recorded as `expired`
  (`wasActive: false`).
- **Who can revoke:** any install admin (including the requester, which is a withdrawal while
  pending). Team admins can't revoke (the investigation may concern them); they are notified.
- **Notifications:** email through the durable outbox (see Design); in-app: the team audit view's
  banner and the team console's "Break-glass access" page (Kobe has no notification centre yet).
  Request → other active install admins (never the subject); approval and revocation/expiry of an
  active grant → active team admins of the team, active install admins, subject unless legal hold;
  denial/withdrawal/lapse → requester. The acting person isn't mailed; under legal hold the subject
  is in no list.
- **Expiry is checked per statement** (`statement_timestamp()` in `break_glass_active_grant()`): a
  long transaction loses access at `expires_at`, and a transaction sees an approval that committed
  after it began. A read held up past expiry (e.g. waiting for the audit chain) passes the app-side
  check but its query returns nothing (tests in the probe suite and the reader suite).
- **The settings are self-asserted by the app role.** `kobe.break_glass_grant` /
  `kobe.break_glass_actor` are ordinary transaction-local settings any app-role connection can
  set. The policies limit the blast radius (only an approved, unexpired grant whose requester is
  that active install admin; only its team and scope; SELECT only), but they don't authenticate the
  admin, and they don't guarantee an audit row: those come from `readWithBreakGlass()` (session
  user as actor, audit before read). Code that sets the settings elsewhere bypasses the audit.
- **Approver deactivation doesn't end a grant:** the approval was valid when given (D10 is silent).
  Requester deactivation or demotion does end access at the next read. Revisit if Chris wants
  approver loss to revoke.
- **Subject decisions answer 404 under legal hold** (approve/deny/revoke by the subject of a hidden
  hold = `grant_not_found`, same as GET); outside a hold the subject gets 403.
- **Legal hold on the team side:** the team page and team-admin emails hide the reason, subject
  and thread ("restricted (legal hold)"); that access happened, by whom and for how long is always
  shown.
- **Reads mirror the thread API** (snake_case `thread_id`, `entries`, keyset cursor, offloaded
  payloads never echoed); grant management is camelCase like the other install routes. The web
  casing layer now treats `payload` as opaque (Pi entries stay verbatim).
- **A thread-scoped request doesn't check that the thread exists** (that would let install admins
  probe thread ids of a team without a grant); a grant for an unknown id simply reads nothing. A
  user-scoped request does check membership (rosters are metadata install admins already read).
- **Trash included:** break-glass reads include threads in Trash (investigations need them).
- **Out-of-scope and refused reads aren't audited** (they return 404/403 and roll back); only reads
  that returned content leave a row.

## Review round 1 (security-review subagent; resolved)

- **HIGH, legal hold in the team audit view:** under a legal hold, `requested`/`approved` targets
  leave out `subjectUserId` and `threadId`, and `read` events leave out `threadId` (the grant row,
  resolved by `grantId` in the install console, keeps them). Test: legal-hold events carry neither.
- **HIGH, subject who is an install admin:** a legal-hold grant is invisible to its subject in the
  install list and detail (404); the subject can't deny or revoke any request about them (store
  403 `subject_cannot_decide`, and the trigger); the subject is never mailed a `requested` notice.
- **MEDIUM, manufacturing "sole admin":** first changed to count deactivated admins; reverted on
  the coordinator's review (D10 counts active admins). Races are closed by the admin-set lock.
- **LOW, cursor overflow:** the reader's cursor accepts at most 17 non-negative digits.
- Not changed: refused reads aren't audited (open question below); `decided_by` is set by the
  server from the session (the trigger can't know the session user).

## Coordinator review (PR #34), addressed

1. **Durable notifications:** outbox in the grant's transaction, delivered with retry by the sweep
   (all events, expiry and revocation included); recipient counts in every target; zero active team
   admins still approves, with `warnings: [no_team_admin_notified]` and `teamAdmins: 0` in the
   audit; banners mounted in the team audit view (now READY).
2. **Limits:** 3 open requests per admin; 120 reads per admin per minute; revocation outranks reads
   (30 s lock wait, retry on a busy audit chain), tested under 30 concurrent reads.
3. **RLS (D10):** SELECT-only `break_glass_read` policies honoring the active grant for the named
   admin; canonical policy unchanged; catalog check and probe suite extended. No reason found that
   would make it unsafe.
4. **Active admins only** decide "a second approver exists"; races closed by the admin-set lock.
5. **Subject 404** on decisions under legal hold; legal-hold note shown to approvers (row and
   confirmation); overrun-by-statement-timeout and approver-deactivation choices recorded above.
6. **Tests added:** trigger refuses deactivated and demoted approvers; a read rolls back with no
   data and no audit row when the audit write fails; legal-hold read events omit the thread id; a
   failed send stays pending and the sweep retries it (and a final failure is audited); Origin check
   on POST routes; a read in flight at expiry finishes and the next is refused; a self-approval
   racing a promotion waits and is refused.

## Coordinator DB review (PR #34), status

- **MEDIUM statement_timestamp():** done (function, catalog pin, probe tests for the 2-s long
  transaction and for an approval committed after BEGIN; the reader test now expects an empty
  result for a read held past expiry).
- **MEDIUM exact pin:** the catalog check compares each `break_glass_read` USING clause exactly
  (whitespace-normalized), its role targeting and the function body; the probe suite adds
  user-scope and thread-scope grants on `threads`/`thread_entries`, and an expired window with
  forged settings.
- **LOW:** settings self-asserted (above); outbox comments say at-least-once; per-admin request
  limit (10 per hour, 429 `request_rate_limited`).
- **HIGH performance (PERMISSIVE policy ORs with the team policy): resolved by decision.** The
  dedicated-role approach was blocked: the role can't be provisioned in time on bundled-Postgres
  upgrades (the pre-upgrade migration runs before Helm applies the Cluster's managed roles; the
  owner has no CREATEROLE), test databases need per-database role names (so policies couldn't
  live in a static migration), and `verifyRoles`/the catalog check forbid app-role memberships.
  **Chris chose: keep the RLS design (no dedicated role) and state `team_id` explicitly in every
  query on `threads` / `thread_entries`.** RLS-only queries pay the cost by design.
  - Audit of every query on the two tables (repository, `thread-search`, event-stream reads,
    sandbox-wire ingest/mirroring/restore/run-state/commands/policy-check from KOBE-24,
    break-glass reads, restore SQL): all already filter on `team_id` (directly, via
    `readableBy`/`inScope`, or by joining on `team_id` from a team-filtered `runs` row). The thread
    list now also states it inline rather than only inside its `scope` expression.
  - Measured:
    - coordinator: `count(*)` on `thread_entries` 1.3 → 355 ms; RLS-only point lookup
      0.02 → 1.6 ms
    - here, 200 teams × 500 entries, no explicit filter: `count(*)` 0.08 → 5.3 ms (index
      lost); point lookup on `threads` 0.04 → 0.48 ms (index scan → bitmap)
    - `threads-plans` data (300 teams × 20 threads × 10 entries, analyzed): Postgres picks a
      BitmapOr with both arms bounded by team, RLS-only `count(*)` 1.2 ms vs explicit 0.55 ms;
      the break-glass arm's grant lookup costs 0.2-2 ms when it runs
    - with the explicit filter every hot path is an index scan entered by the team value
      (test)
  - Guards:
    - `services/server/src/team-filter.test.ts`: static scan of both packages; fails on a query
      without a team predicate; opt-out `team-filter-ok: <reason>`
    - `services/server/src/threads-plans.db.test.ts`: EXPLAIN of the captured hot-path SQL as
      the app role over 300 teams; no seq scans; team-leading indexes entered by an explicit
      team; a self-test proves an RLS-only lookup fails it
    - documented in `packages/db/README.md` and `docs/parallel-work.md`

## Open questions (for Chris or the coordinator)

- **Two accounts, one person:** the two-person rule can't detect one human with two admin accounts.
  Out of scope; a policy/onboarding matter.
- **Reason visibility:** team admins see the reason (not under legal hold). OK?
- **Denied attempts:** refused reads (inactive grant, out of scope) aren't audited. Add a
  `governance.break_glass.read_refused` event if wanted.
- **Overview test:** `overview.test.tsx` now uses the legal-hold placeholder (KOBE-17); KOBE-17 will
  need to switch it to another placeholder.

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | server `break-glass.db.test.ts` › requesting: pending request audited under the team (no reason in the target), validation (one narrowing, member subject, ≤ 24 h, reason ≥ 10), non-admins 403 on every route                                                                                                                                                                                                                                                         |
| ac-2 | server › two-person approval: self-approval refused (403, still pending, no approval row), second admin activates with a DB-set 30-min window, single-admin self-approval flagged in grant, audit and email, denial rules; db › guard trigger: non-admin requester, skip-approval insert, self-approval, plain-user/subject approver, lapsed request, immutable request and forward-only transitions, no DELETE, single-admin self-approval                            |
| ac-3 | server › ending a grant: revocation applies to the next request (403 `grant_not_active`, status revoked); expiry ends access without the sweep, two concurrent sweeps record `expired` once (system actor) and notify; approve-vs-revoke race ×6 always ends revoked with a consistent audit trail; demoted requester refused; db › "re-checks on every read", "makes a concurrent revocation wait for an in-flight read"                                              |
| ac-4 | server › "offers no write" (POST/PATCH/DELETE on read paths 404), "never opens the normal team routes" (active team 403, `/v1/threads/{id}` 409, `/v1/team/audit` 409 for the investigator), "usable only by the requester"                                                                                                                                                                                                                                            |
| ac-5 | `packages/db/src/break-glass.db.test.ts` (20 tests): grant verified in the read transaction, scopes, other team unreachable by id, inactive grants refused and not audited; trigger tests above; catalog test classifies the table and its grants                                                                                                                                                                                                                      |
| ac-6 | server › "reads the team's threads and entries … audits every read in the team view" (three reads → three `governance.break_glass.read` rows under the team, actor = investigator; `/v1/team/audit` shows them to the team admin; banner via `/v1/team/break-glass`; other team sees nothing); db › audit row with team id, actor and IP; out-of-scope reads leave no row                                                                                              |
| ac-7 | server › durable notifications and limits (outbox retry, final failure audited, zero-team-admin warning, Origin, pending cap, read rate limit, revoke under read flood); approval mails alice (team admin), the requester and bob (subject), not dave (other team), carol or the approver; request mails only other install admins; legal hold: subject not mailed, team email shows "restricted (legal hold)" without the reason; revocation, expiry and denial mails |
| ac-8 | `apps/web/components/admin/break-glass-pages.test.tsx` (10 tests, incl. team audit view banner, legal-hold note, no-team-admin warning): request body, approve refusal rendered, self-approval note and flag, reader (threads → entries, no write calls), revoked grant error, team banner with `X-Kobe-Team`, legal hold restricted; `registry.test.ts` (READY ⇔ page)                                                                                                |
| all  | `pnpm build typecheck format:check` green; `lint` green except the pre-existing `@kobe/chart#lint` (Helm 4); `pnpm test --concurrency=2` green; `test:db` db 269 (incl. break-glass probe and catalog), server 301 green; `license:check` fails locally on `vitest@5.0.3 Unknown` (lockfile untouched by this branch); cli `test:db` needs `pg_dump` (not installed locally; CI runs it); `scripts/check-public-hygiene.sh` ok                                         |
