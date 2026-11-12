# KOBE-628: SSO-3 — OIDC sign-in

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commit on `kobe-628-sso-signin`, not pushed)
- **Branch / worktree:** `kobe-628-sso-signin` in `../Kobe-wt628` (from group branch `kobe-sso` at
  e6f20a4c: KOBE-625 migrations, KOBE-626 providers, KOBE-627 mapping engine)
- **Depends on:** KOBE-626, KOBE-627. Unblocks SSO-4 (KOBE-629 MFA trust), SSO-5 (KOBE-630
  linking), SSO-9 (KOBE-633 CI IdP).

## What landed

- **Plugin** `auth/sso-plugin.ts` (`kobe-sso`, always registered; registered before `auditPlugin`):
  `GET /api/auth/sso/providers` (enabled providers, slug + display name; Helm providers without a
  mounted Secret hidden), `GET /api/auth/sso/start/:slug?returnTo=`,
  `GET /api/auth/sso/callback/:slug`. Kill switch off (or no SSO runtime) → all three 404.
- **Flow** `sso/oidc-flow.ts` on `openid-client` 6.8.8: discovery through KOBE-626's validated
  `discoverProvider` (now also returns the metadata), cached 1 h per issuer; JWKS cache kept across
  sign-ins (`get/setJwksCache`); `enableNonRepudiationChecks` (signature verified against JWKS, not
  only TLS); `id_token_signed_response_alg` = RS256/ES256 ∩ advertised; clock tolerance 60 s;
  client auth basic (post when basic is not advertised); Entra `prompt=select_account`.
- **Kobe's own claim checks** `sso/claims.ts` (repeated after the library on purpose): `alg`
  RS256/ES256 only, `iss` exact, Entra `tid`, `aud`/`azp`, `nonce`, `exp`/`iat`/`nbf`/`auth_time`
  (≤ 10 min) with 60 s skew, subject from `subject_claim`, overage detection.
- **State** `sso/state.ts`: flow `{slug, providerId, state, nonce, PKCE verifier, returnTo, exp}`
  sealed AES-256-GCM into an HttpOnly, SameSite=Lax, 10-minute cookie (`__Host-kobe-sso` on https,
  `kobe-sso` on http); key HKDF-derived from the auth secret. SHA-256 of `state` stored in
  `verifications` (`kobe:sso-state:` prefix, 10 min) and **consumed with one DELETE … RETURNING**
  at the callback (single use); the cookie is cleared on every callback.
- **Identity** `sso/sign-in.ts`: linked → that user (deactivated → `deactivated`); unlinked with a
  matching local email → `link_required` (never linked); new → user only when JIT is on **and**
  the mappings yield ≥ 1 team (`no_access` otherwise), identity `linked_via: jit`, audited
  `identity.sso.link.created`. `applyIdpAccessAndFollowUp` runs at every sign-in (actor = the
  user); left with no team and no site role → `no_access`.
- **Overage** (`_claim_names.groups` / `hasgroups`): provider with a live SCIM token and a linked
  user → their `scim_group_members` external ids are the values; otherwise `groups_overage`.
- **Session**: prior session of the browser deleted, `internalAdapter.createSession` (deactivation
  hook + trigger apply), `session_sso_contexts {provider, mfa_satisfied: false, amr, acr,
auth_time}`, `setSessionCookie`; insert failure deletes the session again.
- **Audit**: `auth.sign_in.succeeded {method: sso}`; refusals via the aggregated
  `auth.sign_in.failed {method: sso, reason, userId?}` (`AuthAttemptAudit` method type gained
  `sso`). No claim, token or email in audit or logs (logs carry the error name only).
- **Rate limits** (Better Auth custom rules, Postgres): `/sso/start/*` and `/sso/callback/*`
  20/min per IP.
- **Reset guard** (`auth.ts`): no reset email for a user without a `credential` account (JIT/SCIM
  users), so a mailbox can't outlive the IdP (§6, SSO9). Done here because SSO-3 is the first
  ticket that creates such users; SSO-5 owns the rest of §6.
- **Web**: `components/auth/sso-sign-in.tsx` ("Sign in with <name>" link per provider, hidden on
  404), `lib/sso-errors.ts` (plain message per `sso_error`), sign-in page shows both.
- **Mock IdP** `testing/mock-oidc.ts` (jose 6.2.12 added as a server devDependency: MIT, already in
  THIRD_PARTY_LICENSES via openid-client; no new package): discovery, JWKS, test-driven
  `authorize()`/`deny()`, token endpoint (client secret, redirect URI, single-use code, PKCE S256),
  RS256/ES256, modes `alg_none`, `hs256_client_secret`, `foreign_key`, claim `overrides`, `iss`
  parameter, `down`; `routeMockOidc(...)` serves several. Reusable by SSO-4/5/8.

## Decisions / deviations

- **State sealed under an auth-secret-derived key, not the envelope** (§5.3 names the envelope):
  the envelope is optional and Helm providers work without it. Same properties (AEAD, own purpose).
  `state` is random (stored as a digest), not "a hash of the cookie": equivalent binding, plus a
  server-side single-use record.
- **HS\* is never accepted** (no opt-in): spec §5.4 says "never `none` or HS\*".
- **`require_2fa` on → SSO refused `mfa_missing`** until SSO-4 evaluates `mfa_rule`, so no SSO
  session can reach TOTP enrolment (SSO7). `mfa_satisfied` is always false for now. SSO-4: replace
  the check in `sso-plugin.ts` (search "SSO-4") and set `mfa_satisfied`.
- **`users.email_verified`** for JIT users follows the token (`email_verified`; Entra `xms_edov`)
  instead of always true (§5.5): it is a hint, never proof, and Kobe uses it for nothing else.
- Extra failure codes beside §5.7: `email_missing`, `provider_unavailable`, `idp_unreachable`,
  `idp_error` (IdP answered with an error), `sign_in_failed` (unexpected server error).
- Not done: `max_session_hours` (Better Auth's session refresh would extend an override; needs a
  `requireSession` check, SSO-4 or follow-up); email-domain discovery on the sign-in page (§15 out
  of scope); `/sso/link/*` (SSO-5).

## Guide pages SSO-10 (KOBE-634) must update

- `docs/guide/getting-started.md` — "Sign in": the "Sign in with <provider>" button(s); what each
  refusal message means (no access → ask the admin; account exists → sign in locally, linking is
  SSO-5); local sign-in still works.
- `docs/guide/reference/troubleshooting.md` — every `sso_error`: `no_access`, `link_required`,
  `deactivated`, `mfa_missing` (until SSO-4: any site requiring 2FA), `groups_overage` (app roles
  or "groups assigned to the application", or SCIM), `tenant_mismatch`, `email_missing`,
  `state_invalid`, `token_invalid`, `idp_error`, `idp_unreachable`, `provider_unavailable`.
- `docs/guide/admin/site-admin.md` (Single sign-on) — JIT only with a mapping; break-glass: local
  Owner/admin sign-in never contacts the IdP; kill switch hides the buttons.
- `docs/install.md` — redirect URI `https://<kobe>/api/auth/sso/callback/<slug>`; server egress to
  the IdP (discovery, JWKS, token endpoint).

None changed here (spec §18 assigns the SSO guide pages to SSO-10).

## Evidence (acceptance criteria → tests)

`services/server/src/sso-sign-in.db.test.ts` (37 tests, mock IdP):

- tampered state param, tampered cookie, other browser, replayed callback + cookie, cookie on
  another provider → `state_invalid`;
- wrong `nonce`, `aud`, `iss`, `tid`, expired `exp`, stale `auth_time`, `alg: none`, HS256 with
  the client secret, foreign signing key, wrong RFC 9207 `iss` → refused, no session, no user;
- unmapped identity → `no_access`, no user; linked person with no remaining access → `no_access`;
- `returnTo=//evil`, `https://evil`, `/\evil`, `/%2F%2Fevil` → `/`;
- deactivated user → `deactivated`, no new session;
- existing email → `link_required`, no link, no session;
- JIT user, identity, managed membership and `session_sso_contexts` (amr, acr, auth_time) written;
- break-glass: Owner password + passkey and a local user sign in with both IdPs down, zero IdP
  requests;
- overage refused without SCIM, served from SCIM memberships with it; 2FA site → `mfa_missing`;
  rate limit 21st start → 429; kill switch → 404 on all routes; no reset mail for a JIT user.

Unit: `sso/claims.test.ts`, `sso/state.test.ts`, `sso/return-to.test.ts`; web:
`apps/web/components/auth/sso-sign-in.test.tsx`.

## Later changes

The security review fixes in [KOBE-sso-review1](KOBE-sso-review1.md) changed parts of this ticket (address source and verification, SSO9 guard, kill switch sessions, SCIM externalId and reactivation, setup Owner flag).
