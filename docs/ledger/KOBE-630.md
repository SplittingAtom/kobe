# KOBE-630: SSO-5 — account linking (local proof, admin-expected links, unlink)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commits on `kobe-630-sso-linking`, not pushed)
- **Branch / worktree:** `kobe-630-sso-linking` in `../Kobe-wt630`, from group branch `kobe-sso`
  at `e551da08`
- **Depends on:** KOBE-628 (sign-in), KOBE-629 (MFA), KOBE-631 (reset guard), KOBE-sso-review1.
- **Spec:** `docs/specs/sso-oidc-scim.md` §6, §9, §12; SSO4, SSO9, SSO10.

## What landed

- **Migration (own commit) `0215_sso_link_expectations`**: `sso_link_expectations (provider_id,
user_id)` PK, `created_by`, `created_at`, `expires_at > created_at`; cascades with provider and
  user. Site-wide in the identity registry (no team content, like `sso_identities`), so no RLS and
  no probe fixture; app role gets ALL (single use = DELETE). Backed up (configuration).
  Upgrade test `packages/db/src/sso-link-expectations-upgrade.db.test.ts`.
- **`sso/linking.ts`**: `expectLink` / `withdrawExpectation` / `linkExpected` /
  `linkByLocalProof` / `listLinks` / `listExpectations` / `unlinkIdentity`. Every write in one
  transaction on the `FOR UPDATE`-locked user row, refusals before any write, audit in the same
  transaction.
- **Local proof**: `resolveSsoUser` (`sso/sign-in.ts`) returns `linkIntent` for an unlinked
  identity with an address, for `link_required` **and** `no_access` (so the cookie doesn't tell
  whether the address has an account, review 9b). The callback seals
  `{providerId, subject, email, nonce, exp}` into `__Host-kobe-sso-link` (HttpOnly, Lax, 10 min,
  AES-GCM, own HKDF purpose; `sso/link-intent.ts`) and records the nonce digest in
  `verifications` (`kobe:sso-link:`), consumed by one DELETE … RETURNING (single use).
  `auth/sso-link-plugin.ts` (registered after `twoFactor` and `passkey`, before `auditPlugin`):
  after a **completed** local sign-in (`/sign-in/email` without TOTP, `/two-factor/verify-totp`
  or `/verify-backup-code` without a prior session, `/passkey/verify-authentication`) the cookie is
  cleared and the intent spent; link (`local_proof`) only when the signed-in user's address equals
  the intent's, the provider is enabled and neither key is linked. A failed attempt or a pending
  TOTP challenge keeps the intent; a different user discards it; a link error never fails the
  sign-in (logged by error name). An SSO sign-in that succeeds clears the cookie.
- **Admin-expected link**: in `resolveSsoUser`, an unlinked identity whose address belongs to a
  user links (`admin_expected`) only with an unexpired expectation **and** `emailVerified` **and**
  the address's domain in `allowed_email_domains`; the expectation is deleted in the link's
  transaction. Otherwise `link_required` as before.
- **Unlink**: deletes the identity and the user's sessions made through that provider
  (`session_sso_contexts` join), audited `identity.sso.link.removed {by, sessionsEnded}`. Refused
  `409 last_sign_in_method` when the user has no password, no passkey and no other link.
- **Routes**: `/v1/site/sso/users/:userId/links` (GET), `.../link-expectations/:providerId` (PUT,
  DELETE), `.../links/:providerId` (DELETE) — `site.users.manage`, only the Owner acts on
  Admins/Owner, 404 with the kill switch (`routes/site-sso-links.ts`). `/v1/me/sso/links` (GET),
  `/v1/me/sso/links/:providerId` (DELETE) (`routes/me-sso-links.ts`).
- **SSO10 guard** (`auth.ts`): from an SSO session of the setup Owner, `/passkey/delete-passkey`
  and `/unlink-account` → `403 SETUP_OWNER_LOCAL_ONLY`.
- **Audit**: new `identity.sso.link_expectation.withdrawn {providerId, userId}`; optional
  `sessionsEnded` on `identity.sso.link.removed` (`events.ts`, `docs/audit-log.md`).
- **Web**: Me → **Sign-in methods** (`/me/sign-in-methods`, profile menu; list + Unlink, "not set
  up" on 404); Site console → Users → **Single sign-on** per row (only while the providers list
  loads): links (Unlink), expectations (Withdraw), **Expect SSO link** (provider select). The
  `not_allowed` sign-in message now says how to link (sign in locally within 10 minutes).
- **Guide**: `getting-started/layout.md` (profile menu), `admin/site-admin.md` (Users bullet).
- No new dependency.

## Decisions

- **"(Entra) `xms_edov: true`" read as "a verified address"** (`VerifiedIdentity.emailVerified`):
  since review finding 1, an Entra address is the email only with `xms_edov`, else the UPN, which
  counts as verified only inside `allowed_email_domains` (tenant-controlled, not user-editable).
  Requiring the raw `xms_edov` would make expected links impossible for UPN-only tenants. Generic
  OIDC needs `email_verified === true`.
- **Expectations refused for the setup Owner and the current Owner** (`409 protected_user`),
  re-checked at link time: the break-glass identity links only by its own local proof (SSO10).
  Linking it by local proof is allowed: SSO9/SSO10 keep its local password/passkey.
- **Link intent for `no_access` too** (unlinked, has an address): uniform with `link_required`.
  Harmless when no user has the address; invitation acceptance is not a local-proof path.
- **A link survives a later `no_access`**: an expected or proven link whose mapping gives no team
  stays; the SSO sign-in is refused until a mapping applies (local sign-in unaffected).
- **No `/sso/link/*` route**: the proof is the ordinary local sign-in (its own rate limits:
  Better Auth's sign-in limits); the spec's `/sso/link/*` 5/min limit has no endpoint to apply to.
- **Admin unlink obeys "only way to sign in" too** (deactivate instead); Admins act on themselves
  and Users, the Owner on everyone (as with deactivation).
- Password-reset guard (ac-4) was already in place (KOBE-628/631); covered by existing tests.

## Open questions (for Chris or the coordinator)

- Should a site Admin (not only the Owner) also be excluded from expected links? Today only the
  Owner may set one for an Admin.
- Kill switch: a pending intent is discarded (never linked) while `auth.sso.enabled` is false; not
  covered by its own test (same middleware as the other SSO routes).

## Guide pages SSO-10 (KOBE-634) must update

- `docs/guide/getting-started.md` — "Sign in": linking an existing account (sign in with your
  organization, then within 10 minutes with your password/passkey); Me → Sign-in methods.
- `docs/guide/admin/site-admin.md` (Single sign-on) — expected links (verified domain, 14 days,
  single use, Owner excluded), unlink (ends that provider's sessions; never the only sign-in
  method), break-glass: the setup Owner's passkey/password can't be removed from an SSO session.
- `docs/guide/reference/troubleshooting.md` — `not_allowed` (includes "link required"),
  `last_sign_in_method`, `domain_not_verified`, `protected_user`, `already_linked`,
  `SETUP_OWNER_LOCAL_ONLY`.
- `docs/guide/glossary.md` — linked sign-in, expected link.

## Evidence (acceptance criteria → tests)

`services/server/src/sso-linking.db.test.ts` (16 tests, mock IdP):

- **ac-1** "ac-1: the same email never links on its own" (Entra email with `xms_edov`, twice; no
  link, no session); expected link with an unverified generic email → no link.
- **ac-2** "ac-2: a different local user signing in discards the intent…" (cookie cleared, no
  link; replaying the spent cookie with the right user links nothing); forged cookie → nothing.
- **ac-3** "ac-3: an expectation needs the user's domain among the provider's verified domains"
  (409, no row, no audit); verified sign-in links once (audited, consumed, second identity
  refused, `already_linked`); expired expectation → no link.
- **ac-4** `sso-sign-in.db.test.ts` "sends no password-reset link to a user made by SSO"; a linked
  local user still gets one (`sso-linking` local-proof test).
- **ac-5 (SSO9)** local-proof test: linked local user keeps password sign-in and may add a passkey
  from a local session; non-MFA SSO session → `SSO_MFA_REQUIRED` (KOBE-629); SSO-made user can't
  unlink its only method; existing `SSO_ONLY_ACCOUNT` tests unchanged.
- **ac-6 (SSO10)** expectation for the setup Owner → `protected_user`; setup Owner linked by local
  proof keeps password + passkey; its SSO session can't delete the passkey or unlink the credential
  account (`SETUP_OWNER_LOCAL_ONLY`); unlinking leaves password sign-in working.
- Also: TOTP step and passkey sign-in as proof; unlink from Me and Site console (sessions ended,
  local session kept, audit `by`/`sessionsEnded`); withdraw (audited); Admin can't act on Admin.
- Web: `components/me/my-sign-in-methods.test.tsx`, `components/admin/site-pages.test.tsx`
  (Single sign-on section), `components/shell/shell.test.tsx` (menu link).
