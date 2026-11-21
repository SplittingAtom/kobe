# KOBE-731: auth/session.ts requireSession: one path for the shared checks of delegated and cookie sessions

- **Status:** in review (group 59)
- **Branch / worktree:** `group-59-server-helpers` in `../Kobe-g59`
- **Depends on:** KOBE-703 (same branch)

## Plan

Review CODE-22. Security path: same queries decide the same outcomes, same bodies and statuses.

## Decisions

- `requireSession` picks `delegatedSession(deps, delegation)` or `cookieSession(deps, headers)`;
  both return one discriminated outcome (`ok` with user, session id and site role, or a refusal
  with status and body), and the middleware writes it once. One `UNAUTHENTICATED` body (was written
  out five times), one `twoFactorRefusal(canEnrol)`.
- Cookie path: unchanged queries and order (session, account re-read, revoke on deactivation, SSO
  kill switch, `max_session_hours` delete, 2FA). Refusal for 2FA: SSO session without MFA proof ->
  `mfa_missing`; local session without TOTP -> `two_factor_enrollment_required`
  (`twoFactorRefusal(!sso)`), as before.
- Delegated path: `delegationBacking(db, d, {ssoEnabled})` (kobe-mcp/delegation-live.ts) answers
  both questions in one query: `backed` and `withMfaProof`. `delegationBacked` stays (used by its
  db tests) and returns one of the two.

## Equivalence (delegated, site requires 2FA)

Before: `A = delegationBacked(ssoMfaProof: false)`; if not A -> 401; then if require_2fa,
`B = delegationBacked(ssoMfaProof: true)`; if not B -> 403 (enrolment when the person has no TOTP
and a local password, else `mfa_missing`).
The old SQL was one `EXISTS (sessions s WHERE L AND (NOT p OR M))` with `p` = ssoMfaProof, where
`L` is the live-backing predicate (person, not expired, created before the run, SSO session only
while SSO is on and within `max_session_hours`) and `M` the MFA-proof CASE. With `p` false the
filter is `L`, with `p` true it is `L AND M`.
After: one statement over the same `runs r JOIN threads t` row (same team, run, thread, owner and
status filters) selecting `EXISTS (... WHERE L) AS ok` and `EXISTS (... WHERE L AND M) AS ok_mfa`,
with `L` and `M` the same SQL text as before. So `ok = A` and `ok_mfa = B` for the same database
state; when the run row is missing both are false, as both old calls were. The decisions are taken
in the same order (deactivated/missing person -> 401, `!ok` -> 401, require_2fa and `!ok_mfa` ->
403 with the same `canEnrol` rule), so every outcome is the same. The only difference: both facts
come from one snapshot instead of two transactions a moment apart, and the MFA fact is read even
when 2FA is not required (inside the same query: no extra round trip). One query per request
instead of two on the 2FA-required path.

## Docs

No user-facing change: no `docs/guide` update needed.

## Evidence (acceptance criteria → test or command output)

- ac-1: `grep -c '"unauthenticated"' services/server/src/auth/session.ts` = 1; `delegationBacking`
  is the only backing query in `requireSession`; `kobe-mcp.db.test.ts` asserts it returns both
  answers matching `delegationBacked` across the SSO/TOTP states (assertions added, none removed).
- ac-2: see results below.
- Results: auth, kobe-mcp (5 files), sso-access, sso-sign-in, invites, audit db tests 10 files /
  289 tests passed; `pnpm verify` green; server db suite 268 files / 3312 tests passed.
