# KOBE-sso-review1: security review fixes on the SSO group (KOBE-625..628, 631)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commits on `kobe-sso-review1`, not pushed)
- **Branch / worktree:** `kobe-sso-review1` in `../Kobe-wtssofix`, from group branch `kobe-sso` at
  `fea8610f`
- **Spec:** `docs/specs/sso-oidc-scim.md` updated in §4, §5, §6, §9, §10, §12, §13 and §16 (new
  decision **SSO11**, confirmed by Chris 2026-11-11)

## Fixes (tests first; each finding has a failing test that now passes)

| #   | Sev    | Fix                                                                                                                                                                                                                                                                                                                                                                                        | Tests                                                                              |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | HIGH   | `sso/claims.ts`: Entra takes `email` only with `xms_edov: true`, else the UPN (`upn`, `preferred_username`); a UPN is verified only in `allowed_email_domains`; generic needs `email_verified === true`. SCIM: verified only for an Entra `userName` in those domains (create and re-address). `/v1/me/invites` list/accept/decline and `acceptTeamInvite` require `users.email_verified`. | `sso/claims.test.ts`, `sso-sign-in.db.test.ts` (nOAuth invites), `scim.db.test.ts` |
| 2   | HIGH   | SCIM `externalId` immutable once set: PATCH/PUT with another value → `400 mutability`; same value (any case for Entra GUIDs) is no change.                                                                                                                                                                                                                                                 | `scim.db.test.ts` (site Admin, SSO session kept)                                   |
| 3   | HIGH   | SSO9: `auth.ts` `before` hook refuses passkey registration (`generate-register-options`, `verify-registration`, `register`), `/change-password` and `/two-factor/enable` with `403 SSO_ONLY_ACCOUNT` for users without a `credential` account.                                                                                                                                             | `sso-sign-in.db.test.ts`                                                           |
| 4   | MEDIUM | Self take-over refused (`403 cannot_take_over_self`) in `routes/team.ts`; Team console hides the button on your own row.                                                                                                                                                                                                                                                                   | `sso-access.db.test.ts`, `apps/web/components/admin/sso-mappings.test.tsx`         |
| 5   | MEDIUM | `updateProvider` refuses issuer/tenant/subject-claim changes while identities exist (`409 identity_settings_locked`); Helm seed leaves such a provider as it is (`locked`, logged at start).                                                                                                                                                                                               | `site-sso.db.test.ts`                                                              |
| 6   | MEDIUM | Kill switch: `requireSession` refuses sessions with a `session_sso_contexts` row while `auth.sso.enabled` is false; start-up deletes them (`endSsoSessionsWhenOff`). Local sessions unaffected.                                                                                                                                                                                            | `sso-sign-in.db.test.ts`                                                           |
| 7   | LOW    | Mapping routes (`/v1/site/sso/mappings`, provider mappings) and `/v1/team/sso-mappings` answer 404 with the kill switch.                                                                                                                                                                                                                                                                   | `site-sso.db.test.ts`                                                              |
| 8   | LOW    | Durable `users.setup_owner` (set by `createUserWithPassword(recordSetup)`), backfilled by 0212 from `identity.setup.completed`, else the current Owner; `isProtected` reads it.                                                                                                                                                                                                            | `scim.db.test.ts`, `packages/db/src/sso-review-upgrade.db.test.ts`                 |
| 9a  | LOW    | `max_session_hours`: new SSO session's expiry capped; `requireSession` ends it once the hours since `sessions.created_at` passed (Better Auth's refresh can't extend it).                                                                                                                                                                                                                  | `sso-sign-in.db.test.ts`                                                           |
| 9b  | LOW    | `no_access` and `link_required` reach the browser as `not_allowed` (`browserSsoError`); audit keeps the reason. Web message updated.                                                                                                                                                                                                                                                       | `sso-sign-in.db.test.ts`, `apps/web/components/auth/sso-sign-in.test.tsx`          |
| 9c  | LOW    | `OidcClients` caches a failed discovery 60 s per provider (`DISCOVERY_FAILURE_TTL_MS`).                                                                                                                                                                                                                                                                                                    | `sso/oidc-flow.test.ts`                                                            |
| 10  | —      | **SSO11**: `users.deactivated_via` (`admin` or `scim:<provider>`); SCIM reactivates only users its provider deactivated, else 403 + `identity.scim.reactivation_refused`. An admin deactivating a SCIM-deactivated user takes it over. Pre-0212 deactivations backfilled `admin`.                                                                                                          | `scim.db.test.ts`, upgrade test                                                    |

## Migration

`0212_sso_review.sql`: `users.deactivated_via` (CHECK `admin` or `scim:<uuid>`), `users.setup_owner`
(bool, default false); backfills as above. New audit event `identity.scim.reactivation_refused`
(`events.ts`, `docs/audit-log.md`).

## Re-review follow-ups

- **A:** `delegationBacked` takes `{ ssoEnabled }`: an SSO-backed session backs a Kobe MCP
  delegation only while SSO is on and within `max_session_hours` (from its `created_at`). Trigger
  `sessions_cap_sso_expiry` (0212) caps every `expires_at` update, so Better Auth's get-session
  refresh can't outlive the cap. Tests: `kobe-mcp.db.test.ts`, `sso-sign-in.db.test.ts`.
- **B:** SCIM reactivation re-checks `deactivated_via` and updates in one transaction on the
  `FOR UPDATE`-locked user row (`reactivateUserIfVia`); race test in `scim.db.test.ts`.
- **C:** partial unique index `users_setup_owner` (amended into 0212, not shipped); test in
  `scim.db.test.ts`.

## Notes and limits

- An unverified generic-OIDC `email` is still stored as the JIT user's address (needed to sign in);
  it can't match invitations, but it does occupy that address (a mapped identity is required).
- The Entra UPN rule depends on admins listing the tenant's verified domains in
  `allowed_email_domains`; with none listed, SSO users' addresses stay unverified (no invitations).
- Guide pages: `docs/guide` has no SSO pages yet (SSO-10, KOBE-634); the `not_allowed` code and the
  SSO9 refusal go there with it.

## Verification

See the final report of this ticket for the run results (build, typecheck, lint, format:check, web
tests touched, server unit, server test:db, other packages' test:db, drizzle-kit check, db:check,
hygiene, site wording).
