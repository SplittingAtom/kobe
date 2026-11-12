# KOBE-629: SSO-4 — trust the IdP's MFA (amr/acr/acrs) for `require_2fa`

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commit on `kobe-629-sso-mfa`, not pushed)
- **Branch / worktree:** `kobe-629-sso-mfa` in `../Kobe-wt629`, from group branch `kobe-sso` at
  `14b1b40b`
- **Depends on:** KOBE-628 (sign-in, `session_sso_contexts`), KOBE-sso-review1.
- **Spec:** `docs/specs/sso-oidc-scim.md` §8, SSO3, SSO7, §17 SSO-4.

## What landed

- **`sso/mfa.ts`** (pure): `mfaProven(kind, rule, {amr, acr, acrs})`: any `amr_any` value, or `acr`
  in `acr_any` (exact), or (Entra only) an `acrs` value in `acrs_any`. Empty rule proves nothing.
  `acrsClaimsParameter(kind, rule)`: `{"id_token":{"acrs":{"essential":true,"value":"c1"}}}`
  (`values: [...]` for several), Entra with contexts only.
- **`sso/claims.ts`**: `VerifiedIdentity.acrs` (array or single string; strings ≤ 64 chars, ≤ 32).
- **`sso/oidc-flow.ts`** `authorizationUrl`: adds the `claims` parameter (Entra preset → `c1`).
- **`auth/sso-plugin.ts`** callback: replaces KOBE-628's blanket `mfa_missing`; evaluates the
  provider's `mfa_rule`; not proven + `require_2fa` → `mfa_missing` **before** any user, link or
  session is made; otherwise `session_sso_contexts.mfa_satisfied` = the result.
- **`auth/session.ts`** `requireSession` with `require_2fa`: an SSO session passes only with
  `mfa_satisfied`; else `403 {code: "mfa_missing"}` with a Conditional Access message (never
  `two_factor_enrollment_required`, so the person is never sent to TOTP enrolment). Local sessions
  unchanged (enrolled TOTP). Delegations (Kobe MCP admin tools): a person without TOTP passes only
  when a backing session proved MFA (`delegationBacked(..., {ssoMfaProof: true})`).
- **`auth/auth.ts`** before hook: `/two-factor/enable`, `/get-totp-uri`, `/verify-totp`,
  `/generate-backup-codes` → `403 SSO_MFA_REQUIRED` from an SSO session without MFA proof (any
  site setting). SSO-only accounts still get `SSO_ONLY_ACCOUNT` first (SSO9). The TOTP sign-in
  challenge has no session, so local sign-in is unaffected.
- **Web**: Site settings hint for "Require two-factor authentication" mentions the SSO rule. The
  sign-in page's `mfa_missing` message (KOBE-628) already points at Conditional Access.
- No migration, no new dependency, no new audit event (refusal stays
  `auth.sign_in.failed {method: sso, reason: mfa_missing}`).

## Decisions

- **SSO session: only its own MFA proof counts.** §8 writes "`two_factor_enabled OR` session
  `mfa_satisfied`". For a _local_ session `two_factor_enabled` stands for "this sign-in passed
  TOTP"; an SSO session never passes Kobe TOTP (SSO7, no fallback), so a linked local user's
  enrolled TOTP does not make their non-MFA SSO session pass. Such a session can only exist if
  `require_2fa` was turned on after the sign-in; it gets `mfa_missing` (sign in again).
  Delegations can't tell which session backs them (no session id on the run), so there it is
  `two_factor_enabled OR` a live pre-run SSO session with `mfa_satisfied`.
- **`acrs` is read and requested only for `kind: entra`** ("(Entra)" in §8); a generic provider
  uses `amr`/`acr`.
- **Enrolment refusal also covers `verify-totp` and backup codes**: `verify-totp` with a session
  is how Better Auth confirms a pending secret, and backup codes are a second factor too.
- Entra preset kept as is (`amr_any` default + `acrs_any: ["c1"]`) until the real-tenant check.
- `kobe_totp_fallback` (§8 opt-in) not built: SSO7 says no fallback.

## Verify on the real tenant (coordinator, after deploy to gate1)

Prerequisites in Entra (tenant on gate1): Conditional Access → Authentication contexts → create
**c1** ("Kobe MFA", published to apps); a CA policy targeting authentication context c1 (all users
or the test group) with grant **Require multifactor authentication**. Free tier: CA needs Entra ID
P1; if the tenant has none, record that and check only steps 4-6.

1. Start SSO from gate1's sign-in page; the `login.microsoftonline.com/.../authorize` URL carries
   `claims={"id_token":{"acrs":{"essential":true,"value":"c1"}}}` (browser devtools).
2. Entra prompts for MFA even if the account signed in recently with a password only.
3. In `session_sso_contexts` for the new session: `mfa_satisfied = true`; note what `amr`/`acr`
   hold (Entra v2.0 often omits `amr`). If `mfa_satisfied` is false, decode the ID token claims
   (temporary debug, never logged in prod) for `acrs`: adjust the Entra preset (§8 says SSO-4 may).
4. Site settings → turn on **Require two-factor authentication**. MFA-proven SSO user: Kobe works
   (no TOTP prompt, `/v1/me` 200).
5. Disable the c1 policy (or remove the user from it), sign in again: refused, sign-in page shows
   "did not include multi-factor authentication … Conditional Access"; no new session row.
6. With `require_2fa` off and a non-MFA SSO session of a **linked local** user (needs SSO-5 linking
   or an `sso_identities` row inserted by hand): Settings → set up authenticator → 403
   `SSO_MFA_REQUIRED`. Turn `require_2fa` on while that session lives: next request 403
   `mfa_missing`.
7. Local Owner sign-in (password + TOTP/passkey) still works with `require_2fa` on (break-glass).

Record the outcome (and any preset change) in this ledger.

## Guide pages for SSO-10 (KOBE-634)

- `docs/guide/admin/site-admin.md` — Single sign-on section: the provider's MFA rule, the Entra
  authentication context c1 + CA policy setup, what `require_2fa` means for SSO users. (The
  Settings bullet got one sentence here.)
- `docs/guide/reference/troubleshooting.md` — `mfa_missing` at sign-in (now: only when the IdP did
  not prove MFA and the site requires 2FA, not "any site requiring 2FA"); `mfa_missing` 403 for a
  live session after `require_2fa` was turned on; `SSO_MFA_REQUIRED` when setting up an
  authenticator app from an SSO session.
- `docs/guide/getting-started.md` — SSO users on a 2FA site are not asked for an authenticator
  code; MFA happens at the organization's sign-in.
- `docs/install.md` / Entra setup — authentication context, CA policy (Entra ID P1).

## Open questions

- Does the gate1 tenant have Entra ID P1 (Conditional Access)? Without it the `c1` context can't
  be enforced and no Entra sign-in proves MFA, so `require_2fa` on gate1 would refuse all SSO.

## Evidence (acceptance criteria → tests)

- **ac-1** `sso-sign-in.db.test.ts` "ac-1: an MFA-proving sign-in (Entra acrs c1) passes
  require_2fa…" and "ac-1: an amr value in the rule proves MFA too (generic provider)"; JIT test
  now records `mfa_satisfied: true`; start test asserts the `claims` parameter.
- **ac-2** "ac-2: a non-proving sign-in is refused with mfa_missing" (Entra `acr` only, Entra
  wrong context, generic with `acrs`): no user, no session; "a non-proving sign-in is allowed while
  2FA is not required…" covers the live-session 403 `mfa_missing` with the Conditional Access text.
- **ac-3** "ac-3: a linked local user's non-MFA SSO session cannot enrol TOTP or backup codes":
  four endpoints 403 `SSO_MFA_REQUIRED`, no secret stored; the MFA-proving session can enrol.
- Delegation: `kobe-mcp.db.test.ts` "KOBE-629: under require_2fa a delegation without TOTP…".
- Unit: `sso/mfa.test.ts` (rule + `claims` parameter), `sso/claims.test.ts` (`acrs` parsing).
