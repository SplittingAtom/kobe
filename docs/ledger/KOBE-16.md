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
- **Guard trigger `break_glass_grants_guard` (migration 0017, SECURITY INVOKER):** inserts start
  `pending` from an active install admin, with DB-stamped times; the request (team, scope, reason,
  duration, legal hold) is immutable; transitions pending→approved|denied|revoked|expired and
  approved→revoked|expired only. On approval: approver is an active install admin and not the
  subject; approver = requester only when no other active install admin exists (then
  `self_approved`); the DB sets `starts_at = now()`, `expires_at = now() + duration`. Denial by the
  requester is refused (they withdraw = revoke). Expiry only after the deadline/window.
- **`readWithBreakGlass(db, {grantId, adminId, request}, read)` in `@kobe/db`:** one transaction
  per read: (1) `SELECT … FOR SHARE` the grant with `status = approved`, inside its window, for this
  admin, who must still be an active install admin; (2) only then `set_config('kobe.team_id')`;
  (3) `audit()` `governance.break_glass.read` (the only write); (4) `SET LOCAL
transaction_read_only = on`; (5) the read, narrowed to the scope (team / one owner / one thread).
  The transaction is never handed out; the read kinds (thread list, thread, entries) are the whole
  surface. Out-of-scope → `not_found`, rollback (audit row gone: nothing was read). A revocation
  waits for an in-flight read (share lock) and applies to the next one.
- **Server:** `break-glass/store.ts` (request, approve, deny, revoke with the row locked
  `FOR UPDATE`; expiry sweep with `SKIP LOCKED`; audit last), `notify.ts`, `sweeper.ts` (every
  minute on every replica, started in `index.ts`), routes `install-break-glass.ts` and
  `team-break-glass.ts`. Permission `install.break_glass.approve` (admin) added next to the
  existing `install.break_glass.request`.
- **Audit taxonomy:** `governance.break_glass.{requested,approved,denied,revoked,expired,read}`,
  all team scope (category `governance`). Targets are ids/enums/booleans; the reason is never
  logged (it stays in the grant row).
- **Web:** install section `break-glass` flipped to READY (request form, grants table with
  approve/deny/withdraw/revoke, read-only reader with threads and entries); new team section
  `break-glass` ("Break-glass access", `team.audit.read`) with one banner per active grant and the
  history. `BreakGlassBanners` is exported for the team audit page when someone builds it.

## Decisions

- **Self-approval follows D10, not a blanket ban:** the brief said "no self-approval"; the spec
  says single-admin installs self-approve and are flagged. Refused (403 `self_approval_forbidden`,
  and in the trigger) whenever another active Owner/Admin exists; allowed and flagged otherwise.
  One person holding two accounts is out of scope (can't be detected); noted for Chris.
- **Enforcement shape:** the spec says "a row that RLS policies honor". Adding grant-aware policies
  to every team table would break the catalog rule "exactly one canonical team policy" and touch
  every area's tables. Instead the grant is checked in the same transaction before `kobe.team_id`
  is set, the canonical RLS then confines reads to the team, Postgres read-only mode forbids
  writes, and the scope narrowing is applied by the closed reader. Same guarantees for the content
  that exists today (threads, entries); later content tables (files, memory, artifacts) add read
  kinds to `readWithBreakGlass`.
- **Audit before read, then read-only:** Postgres can't turn a read-only transaction back to
  read-write, so the audit row is written before switching to read-only. The audit chain lock is
  therefore held during the read; reads are bounded (≤ 100 threads / 200 entries, 10 s statement
  timeout).
- **Pending requests lapse after 24 h** (request TTL) and are recorded as `expired`
  (`wasActive: false`).
- **Who can revoke:** any install admin (including the requester, which is a withdrawal while
  pending). Team admins can't revoke (the investigation may concern them); they are notified.
- **Notifications (email; Kobe has no in-app notification centre yet):** request → other install
  admins; approval and revocation/expiry of an active grant → team admins of the team, install
  admins, subject user unless legal hold; denial/withdrawal/lapse → requester. The acting person
  isn't mailed; under legal hold the subject is excluded from every list (also if they are a team
  or install admin). In-app: the team console's "Break-glass access" page (banner) and the team
  audit view (`governance.break_glass.*`). Mails are sent after commit, best effort, errors logged.
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
- **Out-of-scope reads aren't audited** (they return 404 and roll back); only reads that returned
  content leave a row.

## Open questions (for Chris or the coordinator)

- **Legal hold vs. team audit view:** audit targets keep `subjectUserId` / `threadId` even under
  legal hold (evidence first), and the team audit view shows them to team admins, who may include
  the subject. Hide them under legal hold (install log only), or accept?
- **Two accounts, one person:** the two-person rule can't detect one human with two admin accounts.
  Out of scope; a policy/onboarding matter.
- **Reason visibility:** team admins see the reason (not under legal hold). OK?
- **Denied attempts:** refused reads (inactive grant, out of scope) aren't audited. Add a
  `governance.break_glass.read_refused` event if wanted.
- **Overview test:** `overview.test.tsx` now uses the legal-hold placeholder (KOBE-17); KOBE-17 will
  need to switch it to another placeholder.

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | server `break-glass.db.test.ts` › requesting: pending request audited under the team (no reason in the target), validation (one narrowing, member subject, ≤ 24 h, reason ≥ 10), non-admins 403 on every route                                                                                                                                                                                                                              |
| ac-2 | server › two-person approval: self-approval refused (403, still pending, no approval row), second admin activates with a DB-set 30-min window, single-admin self-approval flagged in grant, audit and email, denial rules; db › guard trigger: non-admin requester, skip-approval insert, self-approval, plain-user/subject approver, lapsed request, immutable request and forward-only transitions, no DELETE, single-admin self-approval |
| ac-3 | server › ending a grant: revocation applies to the next request (403 `grant_not_active`, status revoked); expiry ends access without the sweep, two concurrent sweeps record `expired` once (system actor) and notify; approve-vs-revoke race ×6 always ends revoked with a consistent audit trail; demoted requester refused; db › "re-checks on every read", "makes a concurrent revocation wait for an in-flight read"                   |
| ac-4 | server › "offers no write" (POST/PATCH/DELETE on read paths 404), "never opens the normal team routes" (active team 403, `/v1/threads/{id}` 409, `/v1/team/audit` 409 for the investigator), "usable only by the requester"                                                                                                                                                                                                                 |
| ac-5 | `packages/db/src/break-glass.db.test.ts` (20 tests): grant verified in the read transaction, scopes, other team unreachable by id, inactive grants refused and not audited; trigger tests above; catalog test classifies the table and its grants                                                                                                                                                                                           |
| ac-6 | server › "reads the team's threads and entries … audits every read in the team view" (three reads → three `governance.break_glass.read` rows under the team, actor = investigator; `/v1/team/audit` shows them to the team admin; banner via `/v1/team/break-glass`; other team sees nothing); db › audit row with team id, actor and IP; out-of-scope reads leave no row                                                                   |
| ac-7 | server › approval mails alice (team admin), the requester and bob (subject), not dave (other team), carol or the approver; request mails only other install admins; legal hold: subject not mailed, team email shows "restricted (legal hold)" without the reason; revocation, expiry and denial mails                                                                                                                                      |
| ac-8 | `apps/web/components/admin/break-glass-pages.test.tsx` (8 tests): request body, approve refusal rendered, self-approval note and flag, reader (threads → entries, no write calls), revoked grant error, team banner with `X-Kobe-Team`, legal hold restricted; `registry.test.ts` (READY ⇔ page)                                                                                                                                            |
| all  | `pnpm build typecheck format:check` green; `lint` green except the pre-existing `@kobe/chart#lint` (Helm 4); `pnpm test --concurrency=2` green; `test:db` db 234, server 293 green; `license:check` fails locally on `vitest@5.0.3 Unknown` (lockfile untouched by this branch); cli `test:db` needs `pg_dump` (not installed locally; CI runs it); `scripts/check-public-hygiene.sh` ok                                                    |
