# Kobe — Single sign-on with OIDC (Entra ID) and SCIM provisioning

Status: **decisions SSO1–SSO5 by Chris 2026-11-11 (§16); open questions Q1–Q5 to answer before
tickets** (SSO-1..SSO-10 in §17). Requested by Chris, 2026-11-11. Written against main `0694c325`.

Request (Chris, 2026-11-11): "I would like to add the ability to federate user identity with an
OIDC or SAML auth provider like Azure Entra."

This lifts the deferral of single sign-on in product spec **D7**. The rest of D7 stands unchanged:
invitations, email + password, passkeys with user verification, TOTP, the site's "require 2FA"
switch, deactivation that ends every session at once, and Better Auth embedded in the server.

## 1. Today

- **Better Auth 1.7.14 embedded** (`services/server/src/auth/auth.ts`, spec D7): email + password
  with `disableSignUp: true` (invite-only), plugins `kobe-invitation` (`invitation-plugin.ts`:
  `/invitation/lookup`, `/invitation/accept`, which creates the user and sets the session cookie),
  `twoFactor` (TOTP, secrets sealed with the auth secret), `passkey` (user verification required,
  enforced again in a `before` hook), `jwt` (5-minute tokens carrying `sid`), and `auditPlugin`
  last. Sessions live in Postgres with the cookie cache off, so every request looks them up and
  revocation is immediate. Rate limits are stored in Postgres (`rate_limits`) and shared by
  replicas. Verification values are stored hashed.
- **Session guards.** A `databaseHooks.session.create.before` hook refuses a session for a
  deactivated user, and a trigger on `sessions` backs it up against races. `requireSession`
  (`auth/session.ts`) re-reads `users.deactivated_at` and `site_roles` on every request, and when
  the site setting `require_2fa` is on it returns `two_factor_enrollment_required` unless
  `users.two_factor_enabled` (an enrolled TOTP factor) is true. Passkeys do not satisfy that check.
- **Identity tables** (`packages/db/src/schema/auth.ts`, tenancy domain `identity`): `users`
  (deactivated, never deleted: no `DELETE` grant), `sessions`, `accounts` (Better Auth's columns
  for `access_token`, `refresh_token` and `id_token`, all unused today), `verifications`,
  `passkeys`, `two_factors`, `jwks`, `site_roles` (one Owner, any number of Admins),
  `site_settings`, `session_active_teams`. `team_members` is a **team table** under RLS with
  `role` (`member`, `contributor`, `team_admin`) and `added_via` (`NULL`, or
  `skill_reviewer_grant` for rows Kobe manages itself).
- **Membership rules** (`services/server/src/teams/members.ts`): a team always keeps one active
  team admin (`last_team_admin`). Removing a member pauses their schedules in that team.
  Deactivation (`users/deactivation.ts`) marks the user, deletes their sessions and verifications
  in one transaction, closes their egress tunnels and revokes the invitations they sent. It keeps
  their memberships, so reactivation restores them.
- **Roles** (`authz/permissions.ts`, spec D8): site roles never grant team permissions. Site admins
  reach team content only through break-glass.
- **Kobe's OAuth client** for connectors (`connectors/oauth/*`): discovery that refuses an issuer
  mismatch or a server without PKCE S256, PKCE, `state` sealed with the install envelope (KOBE-107)
  and bound to (team, user, connector), and an SSRF guard (`connectors/url-policy.ts`).
- **Secrets at rest**: connector grants and site keys are sealed with the envelope key
  (`<release>-envelope-key`). `docs/backup-restore.md` already warns that a sign-in provider that
  stored OAuth tokens in `accounts` would put them in the dump as plain text.
- **Outgoing TLS**: `server.extraCaBundle` (KOBE-182) mounts a private CA and sets
  `NODE_EXTRA_CA_CERTS`. Its comment already names "an OIDC issuer". No NetworkPolicy restricts
  the server's own egress; the policies on the server are ingress-only.
- **Audit**: `auth.sign_in.succeeded|failed` take a `method` from `SIGN_IN_METHODS`. Identity
  events include `identity.user.deactivated`.
- **UI**: `apps/web/app/sign-in/page.tsx` (passkey, or email + password then TOTP). Site console
  pages `users-page.tsx`, `invites-page.tsx`, `roles-page.tsx`, `settings-page.tsx`.

## 2. Proposal in one paragraph

A Site admin registers one or more **OIDC identity providers** (Entra ID first), in the Site
console or in Helm values. The client secret is sealed with the envelope key. The sign-in page gets
a **"Sign in with &lt;provider&gt;"** button, which runs an authorization-code flow with PKCE,
`state` and `nonce`, verifies the ID token against a tenant-specific issuer, and creates an
ordinary Kobe session. Who may sign in, and with which access, comes from **mappings** from the
token's app roles (recommended) or groups to Kobe teams and team roles. They apply at every SSO
sign-in and on every SCIM change. An identity with no mapped value gets no account. An SSO sign-in
whose token proves MFA satisfies Kobe's 2FA requirement. One that doesn't prove MFA is refused
(SSO3). Local sign-in keeps working beside SSO. An existing local account is linked only with
proof: its owner signs in locally in the same flow, or an admin marks the link as expected
(SSO4). A **SCIM 2.0** endpoint per provider lets Entra create, update and deactivate users and
push group memberships into the same mappings (SSO5). Deactivation through SCIM ends every
session at once. Kobe stores no IdP access, refresh or ID tokens.

## 3. Library choice (recommended: first-party flow on `openid-client`)

| Option                                   | Fit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@better-auth/sso` 1.7.14 (MIT)          | Peer `better-auth ^1.7.14`, so it would fit the version. Against it: it pulls `samlify`, `@xmldom/xmldom` and `fast-xml-parser` even when only OIDC is used. It stores `clientSecret` in plain text in its own `ssoProvider` row, where Kobe seals secrets with the envelope. Its OIDC callback sends no `nonce` and doesn't check one. It exposes `/sso/register` to signed-in users (it would have to be disabled). Its provisioning is shaped around the `organization` plugin, which Kobe does not use. Its `email_verified` trust is a global switch the authors themselves discourage. |
| `@better-auth/scim` (MIT)                | Keeps its own `scimGroup`/`scimGroupMember` model and hard-deletes on `DELETE`. Kobe never deletes users, needs memberships to go through `withTeam()` and `teams/members.ts` (last-admin rule, schedule pause), and maps groups to its own teams.                                                                                                                                                                                                                                                                                                                                           |
| `genericOAuth` (better-auth core)        | Generic OAuth 2.0 sign-in. Its ID token checks and account linking follow Better Auth's global `accountLinking` options. It writes tokens into `accounts`. It has no hook for a refusal decided by mapping before the user exists, and no per-session MFA record.                                                                                                                                                                                                                                                                                                                            |
| **First-party, `openid-client` 6 (MIT)** | `openid-client` 6.8.8 (with `jose` and `oauth4webapi`) is **already in the server's dependency tree** (via `@kubernetes/client-node`) and in `THIRD_PARTY_LICENSES.md`. It does discovery, PKCE, `state`/`nonce`, `iss` (RFC 9207), ID token validation with JWKS rotation, and `client_secret_basic`/`private_key_jwt`. A small Better Auth plugin (`kobe-sso`, the same shape as `kobe-invitation`) runs the flow on `/api/auth/sso/*`, so it shares Better Auth's origin checks, Postgres rate limits, `setSessionCookie` and session hooks.                                              |

**Recommendation: first-party** (about 400 lines of flow code plus the mapping engine), with
`openid-client` promoted to a direct dependency of `@kobe/server`. Run `pnpm licenses:update` to
refresh the "where" column. The licence is MIT, so no new row is pending. The SCIM server is
first-party Hono routes. Entra uses a small subset of SCIM, and the rules above need Kobe's own
membership code.

## 4. Provider configuration

**Table `sso_providers`** (site-wide, `identity` domain): `id`, `slug` (URL-safe, unique),
`display_name`, `kind` (`entra` | `oidc`), `issuer`, `client_id`, `client_secret_sealed`
(envelope context `kind: "sso_client_secret"`, `recordId: id`), `tenant_id` (Entra, required),
`subject_claim` (Entra preset `oid`; generic `sub`), `access_claim` (`roles` | `groups`),
`mfa_rule` (jsonb, §8), `allowed_email_domains` (text[], used only for linking, §6),
`jit_provisioning` (bool, default true), `enabled`, `managed_by` (`console` | `helm`), `created_by`,
timestamps.

- **Site console → People → Single sign-on** (`site.users.manage`): list, add, edit,
  enable/disable, delete (only when no identity is linked; otherwise disable). The add form asks for
  kind, display name, tenant ID (Entra) or issuer (generic), client ID and client secret. The secret
  is write-only and shown as "set" afterwards. The form also shows **the redirect URI to paste into
  the app registration**: `https://<kobe>/api/auth/sso/callback/<slug>`. Saving runs discovery
  (§5) and refuses on failure with the reason (unreachable, issuer mismatch, no S256, tenant
  mismatch).
- **Helm values** for configuration as code, `auth.sso`:
  ```yaml
  auth:
    sso:
      enabled: true # false = kill switch: every provider is hidden and refused
      allowedInternalCidrs: [] # on-prem IdPs on private addresses (SSRF guard, §11)
      providers: [] # [{slug, displayName, kind, tenantId|issuer, clientId,
      #  clientSecretSecret: {name, key}, accessClaim, mfaRule}]
  ```
  Helm-managed providers are upserted at server start (`managed_by: helm`). The console shows them
  read-only, except for their mappings. Their secret is read from the named Secret and never
  copied into the database.
- Console-entered secrets need the envelope (`envelope.keySecret`, KOBE-107). Without it the form
  is refused, the same way connector site keys are. Envelope rotation re-seals provider secrets
  with the other sealed records.
- `private_key_jwt` (certificate credentials, which Entra prefers) is supported by `openid-client`.
  It is **out of scope for v1**, a candidate follow-up.

## 5. Sign-in flow

1. **Discovery.** Entra: the issuer is `https://login.microsoftonline.com/<tenant_id>/v2.0`, built
   from the tenant ID. Generic: the configured issuer. The server fetches
   `/.well-known/openid-configuration` and requires `issuer` to equal the configured value exactly,
   `code` in `response_types_supported`, `S256` in `code_challenge_methods_supported` (or absent
   for Entra, which supports it without advertising it: the Entra preset assumes S256), and https
   endpoints that pass the SSRF guard. Results are cached for 1 hour. JWKS is refetched on an
   unknown `kid`, at most once a minute.
2. **Tenant restriction.** A provider whose issuer or authority is `common`, `organizations` or
   `consumers` is refused at save time. The ID token's `iss` must equal the tenant issuer and its
   `tid` must equal `tenant_id`. A multi-tenant app registration therefore still admits only the
   configured tenant.
3. **Start** `GET /api/auth/sso/start/<slug>?returnTo=<path>`. `returnTo` must be a relative path
   on Kobe's origin (`/`, not `//` or `/\`); anything else becomes `/`. The server generates a
   PKCE verifier, `state` and `nonce`, seals `{slug, verifier, nonce, returnTo, linkIntent?, exp}`
   with the envelope (`kind: "sso_state"`) into a `__Host-kobe-sso` cookie (HttpOnly, Secure,
   SameSite=Lax, 10 minutes), sends `state` as a hash of that cookie, and redirects with
   `response_type=code`, `scope=openid profile email`, `prompt=select_account` (Entra) and the
   S256 challenge.
4. **Callback** `GET /api/auth/sso/callback/<slug>`. The server opens the cookie (and deletes it),
   compares `state`, checks `iss` when the response carries it (RFC 9207), and exchanges the code
   with the verifier. It validates the ID token: signature from JWKS (RS256/ES256 only, never
   `none` or HS\*), `iss`, `aud == client_id`, `azp` when present, `nonce`, `exp`/`iat`/`nbf` with
   **60 seconds of clock tolerance**, and `auth_time` no older than 10 minutes when present. Claims
   come only from the validated ID token. The UserInfo endpoint is not used: Entra's is Microsoft
   Graph and carries neither groups nor roles.
5. **Identity.** Key = (`provider_id`, the value of `subject_claim`). For Entra that is `oid`,
   which is stable across apps in the tenant and matches SCIM `externalId` (§10). Lookup in
   `sso_identities`:
   - **Found** → that user. If deactivated: refused (`ACCOUNT_DEACTIVATED`).
   - **Not found, a local user has the same email** → never auto-linked. Linking follows §6.
   - **Not found, no such user** → if `jit_provisioning` and the mapping (§7) yields at least one
     team, create the user (`email_verified` true, name from `name`) and the identity
     (`linked_via: jit`). Otherwise refuse: "Your organization has not given you access to Kobe."
     This is the only way round invite-only, and only for identities the IdP's mappings admit.
6. **Mapping** (§7) applies, then **MFA** (§8) is judged. Then a Better Auth session is created
   through `internalAdapter.createSession`, so the deactivation hook and trigger apply. The server
   writes `session_sso_contexts` and sets the cookie with `setSessionCookie`. The `twoFactor`
   plugin is not involved: §8 decides the second factor.
7. Audit `auth.sign_in.succeeded {method: "sso"}` (new `SIGN_IN_METHODS` value) or
   `auth.sign_in.failed {method: "sso", reason}`, with reasons `state_invalid`, `token_invalid`,
   `tenant_mismatch`, `no_access`, `mfa_missing`, `link_required`, `deactivated`,
   `groups_overage`. Failures redirect to `/sign-in?sso_error=<code>` with a plain message. They
   never show token contents.

Rate limits (Postgres, per IP): `/sso/start/*` 20/min, `/sso/callback/*` 20/min,
`/sso/link/*` 5/min.

## 6. Account linking (SSO4)

**Table `sso_identities`**: `provider_id`, `subject`, `user_id`, `linked_via` (`jit` |
`local_proof` | `admin_expected` | `scim`), `email_at_link`, `linked_at`, `last_sign_in_at`.
Unique (`provider_id`, `subject`) and (`provider_id`, `user_id`). Links are kept in Kobe's own
table, not in Better Auth's `accounts`. Better Auth's `/unlink-account` and account-listing
endpoints therefore never see them, and no IdP token is ever stored.

Email is **not** proof of identity. Entra's `email` claim is mutable by tenant users and is
unverified unless the optional claim `xms_edov` says so (the "nOAuth" class of takeover). Kobe
never links, and never matches SCIM users, on email alone. Linking needs one of two proofs:

- **Local proof (recommended default).** The callback finds an unlinked identity whose email
  (`email`, or `preferred_username` for Entra) matches a local user. Kobe shows "An account with
  this address exists. Sign in with your Kobe password or passkey to link it". The sealed
  `linkIntent` (provider, subject, email, 10 minutes) travels with the flow. The user then completes
  a normal local sign-in, including TOTP when enrolled, as the same user. Kobe writes the link
  (`local_proof`) and signs in. A different local user signing in consumes and discards the intent.
- **Admin-expected link** (for migrations). On Site console → Users → a user → **Expect SSO
  link**, an admin names a provider. The next SSO sign-in from that provider whose email matches
  **and** whose email domain is in `allowed_email_domains` **and** (Entra) has `xms_edov: true`
  links automatically (`admin_expected`, single use, expires in 14 days). The expectation and the
  link are audited.
- **Unlink**: the user in **Me → Sign-in methods**, or an admin. Unlinking ends that user's
  sessions created through the provider. A user can't unlink their only way to sign in.

**Local credentials of SSO-provisioned users.** A user created by JIT or SCIM has no credential
account. A password-reset request for them sends nothing: a `before` hook on
`/request-password-reset` checks for a `credential` account. Without it, Better Auth's
`/reset-password` would create a password, and anyone controlling the mailbox could get round the
IdP. Whether such a user may add a passkey or password while signed in is **Q4**. The
recommendation is no in v1, so an IdP-side disable can't be outlived by a local credential when
SCIM is off.

**Break-glass.** Local sign-in never depends on the IdP. Discovery, JWKS and the token endpoint are
contacted only by the SSO routes. The Owner and Admins can always sign in locally. Mappings never
change site roles (Q1). `auth.sso.enabled: false` turns every provider off without a database
change.

## 7. Group and app-role mapping (SSO2)

**Table `sso_access_mappings`** (site-wide, references `teams`, so it needs a `teamReferencing`
entry: "site configuration naming teams, no team content"): `provider_id`, `claim_value`
(an app-role value or a group object ID), `team_id`, `role` (`member` | `contributor` |
`team_admin`), `created_by`, timestamps. Unique (`provider_id`, `claim_value`, `team_id`).
Edited in Site console → Single sign-on → provider → **Access mappings**
(`site.users.manage`). A team admin sees the mappings that target their team, read-only.

**Recommended claim: app roles.** In the Entra enterprise app, define app roles (for example
`kobe.research.member`, `kobe.research.admin`) and assign groups to them. The `roles` claim then
carries only the roles assigned to the user, never hits the groups overage, and doubles as Entra's
"assignment required" gate. With `access_claim: groups`, the guide tells admins to emit only
**"Groups assigned to the application"** (`groupMembershipClaims: ApplicationGroup`). When a token
still carries an overage (`_claim_names.groups`, or `hasgroups`), Kobe does **not** call Graph
(that would need extra API permissions and a secret with directory read). Instead:

- if SCIM is enabled for the provider, Kobe uses the user's SCIM group memberships (§10);
- otherwise it refuses the sign-in with `groups_overage`, and the console shows the fix (app roles
  or the group filter).

**Applying** (`applyIdpAccess(userId, providerId, claimValues)`, one function shared by sign-in and
SCIM):

1. Desired = for each team, the **highest** role among the mappings matched by the user's values.
2. Kobe-managed rows are `team_members.added_via = 'idp:<provider_id>'` (the check constraint is
   extended to allow it). Teams desired but without a row get a row. Managed rows whose role
   differs are updated. Managed rows not desired are removed through `teams/members.ts` (schedules
   pause as with any removal). Each team is written in its own `withTeam()` transaction.
3. **Manual rows win.** A row with `added_via IS NULL`, made by an invitation or an admin, is never
   changed or removed by a mapping, even when the mapping would grant more. Kobe records a
   conflict instead (`identity.sso.mapping_conflict`, shown on the provider page). Recommendation
   for **Q5**: in the Team console, a team admin can't change the role of a managed row or remove
   it; the row shows "Managed by &lt;provider&gt;". **Take over** turns the row manual (audited),
   after which the IdP no longer manages it. Removing the user from the group is the IdP-side way.
4. **Last team admin.** If removing or downgrading a managed row would leave a team without an
   active team admin, Kobe keeps the row, records `mapping_conflict (last_team_admin)` and retries
   on the next change.
5. **No access.** A new identity with no matched value gets no account (§5). An existing user whose
   values match nothing loses their managed rows. The sign-in is refused (`no_access`) if they are
   left with no team membership and no site role. Manual memberships and site roles keep working.
6. Site roles: **not mapped in v1** (recommendation for **Q1**). If Chris wants it: Admin only,
   never Owner, behind an Owner-only site setting that is off by default, with every grant and
   revocation audited and mailed to the Owner.

A mapping change in the console re-applies to users who are already linked: SCIM-known users at
once, others at their next sign-in. The console says which.

## 8. MFA trust (SSO3)

`mfa_rule` per provider: `{ amr_any: ["mfa", "hwk", "swk", "fido", "otp", "sc"], acr_any: [],
acrs_any: [] }`. The token satisfies it when any listed `amr` value (RFC 8176) is present, or `acr`
matches, or (Entra) the `acrs` claim contains a listed authentication context ID. Entra v2.0 ID
tokens do not reliably carry `amr`. The Entra preset therefore defaults to `acrs_any: ["c1"]`:
the admin creates a Conditional Access **authentication context** that requires MFA, and Kobe
requests it with the `claims` parameter (`{"id_token":{"acrs":{"essential":true,"value":"c1"}}}`).
SSO-4 verifies this against a real tenant and adjusts the preset if needed.

- Proven → `session_sso_contexts.mfa_satisfied = true`. `requireSession` accepts
  `two_factor_enabled OR session mfa_satisfied` for `require_2fa`.
- **Not proven, site requires 2FA → refused** (`mfa_missing`, "Your organization's sign-in did not
  include multi-factor authentication") — recommended default (**Q2**). Opt-in per provider,
  `kobe_totp_fallback`: a user who **already** has Kobe TOTP enrolled gets the usual TOTP
  challenge, and the session is created only after it. Never in either mode: enrolling a new Kobe
  TOTP from an SSO session without MFA. That would let a stolen IdP password mint a second factor.
- Not proven, site does not require 2FA → allowed, with `mfa_satisfied = false` recorded.

## 9. Sessions and revocation

- SSO sessions are ordinary Better Auth sessions (Postgres, looked up per request, same lifetime
  setting) plus a row in **`session_sso_contexts`** (`session_id` PK, `ON DELETE CASCADE` like
  `session_active_teams`; `provider_id`, `mfa_satisfied`, `amr`, `acr`, `auth_time`).
- Kobe keeps no refresh token, so a session never silently outlives the IdP's view. Optional
  `max_session_hours` per provider ends SSO sessions earlier than local ones.
- Revocation is immediate: SCIM `active: false` or `DELETE` → `deactivateUser` (sessions deleted
  in the same transaction). Provider disabled or deleted, or identity unlinked → that provider's
  sessions deleted (via `session_sso_contexts`). A mapping removal takes effect on the next request
  through the per-request membership check in `requireTeam`.
- Signing out of Kobe doesn't sign out of Entra. OIDC back-channel and front-channel logout are
  out of scope (§15).

## 10. SCIM 2.0 (SSO5)

Base URL per provider: `https://<kobe>/v1/scim/v2/<slug>` (the existing `/v1` ingress path to the
server). Shown in the console with the token.

- **Tokens**: `scim_tokens` (`id`, `provider_id`, `token_hash` SHA-256, `prefix` for display,
  `created_by`, `created_at`, `last_used_at`, `revoked_at`). The token is 32 random bytes,
  `kobe_scim_` + base64url, shown once. **Rotate** issues a new token while the old one keeps
  working until it is revoked (at most two live). Comparison is constant-time on the hash. A token
  works only for its provider's URL. Rate limit 600 requests/min per token.
- **Endpoints**: `ServiceProviderConfig` (patch true, filter true max 200, bulk false, sort false,
  etag false, `authenticationSchemes: oauthbearertoken`), `Schemas`, `ResourceTypes`;
  `Users`: `GET` (filter `userName eq`, `externalId eq`, `startIndex`/`count`), `GET /:id`,
  `POST`, `PATCH`, `PUT`, `DELETE`; `Groups`: `GET` (filter `displayName eq`, `externalId eq`,
  `excludedAttributes=members`), `GET /:id`, `POST`, `PATCH`, `DELETE`. Errors use the SCIM error
  schema (`409 uniqueness`, `400 invalidFilter|invalidValue`, `404`).
- **Users**: `userName` = sign-in name (UPN) → `users.email` when it is an address. `externalId`
  must be the Entra `objectId` (the guide gives the attribute-mapping change), and it creates or
  matches `sso_identities(provider, externalId)` (`linked_via: scim`). `name.formatted`/
  `displayName` → `users.name`. `active`. `POST` for an email that already belongs to an unlinked
  local user → `409 uniqueness` with a detail pointing to admin-expected linking. Never silent
  linking (§6).
- **Entra quirks handled**: PATCH `op` in any case (`Replace`, `Add`); path-less `value` objects;
  `active` as the string `"False"`; `emails[type eq "work"].value` paths; the remove-member form
  `members[value eq "<id>"]`; a probing `GET /Users?filter=userName eq "<random>"` that must answer
  an empty list; soft delete via `active: false`, then a later `DELETE`.
- **Deactivation**: `active: false` → `deactivateUser` (sessions, verifications and egress tunnels
  end at once), audited with `actor: scim`. `active: true` → `reactivateUser`. `DELETE` →
  deactivate and unlink. Kobe never deletes users. Users with a site role are **not deactivated by
  SCIM** (recommendation for **Q3**): their SSO sessions are deleted, the request is recorded, and
  the Site console shows a banner for an admin to decide. A compromised IdP can't lock out the
  break-glass accounts.
- **Groups**: `scim_groups` (`provider_id`, `id`, `external_id` = Entra objectId, `display_name`)
  and `scim_group_members` (`group_id`, `user_id`), both site-wide. Every member change re-runs
  `applyIdpAccess` for the affected users, with `claim_value = external_id`. This is how overage
  users (§7) and users who never signed in get their teams. Deleting a group removes the managed
  rows it produced. App roles via SCIM (`roles` attribute, `AppRoleAssignmentsComplex`) feed the
  same function when `access_claim: roles`.

## 11. Network, egress and private CA

The server pod calls the IdP directly: discovery, JWKS and the token endpoint. The egress proxy
serves sandboxes, not the server. These URLs pass the connectors' SSRF guard (https, no private,
loopback or link-local address unless listed in `auth.sso.allowedInternalCidrs`, redirects
re-checked). An on-premises IdP with a private CA uses the existing `server.extraCaBundle`. Entra
needs outbound HTTPS from the server pod to `login.microsoftonline.com`. `docs/install.md` says so
for installs that restrict node egress. SCIM is inbound only: Entra's provisioning service must
reach Kobe's public URL. For installs not reachable from the internet, the guide names
Microsoft's on-premises provisioning agent as the customer's choice (out of Kobe's scope).

## 12. Audit

New events (`packages/db/src/audit/events.ts`, site scope): `identity.sso.provider.created|updated|
deleted|enabled|disabled`, `identity.sso.mapping.created|deleted`, `identity.sso.mapping_conflict
{teamId, reason}`, `identity.sso.link.created {method}` / `.removed`, `identity.sso.link_expected`,
`identity.scim.token.created|revoked`, `identity.scim.user.created|updated|deactivated|reactivated`,
`identity.scim.group.created|updated|deleted`, `identity.scim.deactivation_refused {userId}`, and
team-scope `team.member.added|role_changed|removed` with `via: "idp"`. `auth.sign_in.*` gain
method `sso`. SCIM requests carry the actor kind `system` with `{scimTokenId}`. Target allowlists
contain ids and codes only, never claims, tokens or email bodies.

## 13. Threat model

| Threat                                | Mitigation                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IdP compromise                        | Damage is bounded by mappings: team roles only, no site roles (Q1). SCIM can't deactivate site-role holders (Q3). Local break-glass sign-in. Kill switch `auth.sso.enabled: false`. Every SSO change is audited. |
| Token replay / code injection         | PKCE S256, sealed single-use `state` cookie, `nonce` checked, `iss` parameter (RFC 9207), 60 s skew, `auth_time` bound, ID token only accepted from the token endpoint over TLS.                                 |
| Token from another tenant (`common`)  | Tenant-specific issuer only; `iss` and `tid` must match; `common`/`organizations`/`consumers` refused at save.                                                                                                   |
| Account takeover via unverified email | Identity keyed on (`provider`, `oid`/`sub`), never email. Linking needs local proof or an admin expectation plus verified domain (`xms_edov`). No password reset for accounts without a credential.              |
| Mapping escalation                    | Only `site.users.manage` edits mappings. The highest mapped role is capped at `team_admin`. Manual rows are untouched. A team admin can't edit managed rows. Conflicts are surfaced.                             |
| SCIM token leak                       | Hashed at rest, shown once, per provider, rotatable and revocable, rate-limited, `last_used_at` shown. A leaked token can't touch site roles or deactivate admins, and creates users only via mapped groups.     |
| Open redirect                         | `returnTo` relative-path only; error redirects go to fixed pages.                                                                                                                                                |
| Login CSRF / session fixation         | `state` tied to the browser cookie; a new session id at every sign-in; the existing session is replaced.                                                                                                         |
| SSRF via discovery                    | URL policy and allowed CIDRs; only Site admins configure providers.                                                                                                                                              |
| Secret disclosure                     | Client secret sealed (envelope) or held in a Kubernetes Secret (Helm); never returned by the API; no IdP tokens stored.                                                                                          |

## 14. Backup and restore

The new tables are in the dump except `session_sso_contexts` (excluded like `sessions`).
`client_secret_sealed` needs `<release>-envelope-key`; Helm-managed secrets live in the referenced
Secret, which backups don't hold. SCIM token hashes are restored as they were at backup time:
after restoring an older backup, **rotate the SCIM tokens** (a token revoked since then would work
again). Update `docs/backup-restore.md`: the row "OAuth tokens in `accounts` (if SSO is added)"
becomes "SSO: Kobe stores no IdP tokens; client secrets sealed under the envelope key; SCIM tokens
as hashes".

## 15. Out of scope

SAML (possible later spec, SSO1); SSO-only enforcement and disabling local sign-in (SSO4);
`private_key_jwt`/certificate credentials (follow-up); IdP-initiated sign-in; OIDC back-channel or
front-channel logout and RP-initiated logout; Microsoft Graph calls; mapping to site roles (unless
Q1 says yes); email-first discovery (domain → provider) on the sign-in page; SCIM bulk, sort, ETags
and `/Me`; per-team providers.

## 16. Decisions (Chris, 2026-11-11) and open questions

- **SSO0 (D7)**: the deferral of SSO in D7 is lifted. Everything else in D7 stands.
- **SSO1 Protocol**: OIDC only (Entra ID via OIDC). SAML out of scope.
- **SSO2 Provisioning**: app-role or group claims map to Kobe teams and team roles, applied at every
  SSO sign-in and by SCIM. No mapped value → no account (§7). App roles recommended. Groups overage
  is handled by SCIM memberships or refused, never by Graph.
- **SSO3 MFA**: Kobe trusts the IdP's MFA (`amr`/`acr`/`acrs`). A proving sign-in satisfies
  `require_2fa`. A non-proving one is refused when 2FA is required (§8).
- **SSO4 Allow both**: SSO and local sign-in coexist. Linking needs local proof or an
  admin-expected link. Local site admins are the break-glass path.
- **SSO5 SCIM**: SCIM 2.0 Users and Groups per provider, hashed rotatable bearer token, deactivation
  revokes sessions at once.

Open questions for Chris:

- **Q1** May a mapping grant a **site role**? Recommendation: no in v1. If yes: Admin only, behind
  an Owner switch that is off by default.
- **Q2** MFA not proven while 2FA is required: **refuse** (recommended), or allow the opt-in Kobe
  TOTP fallback for users who already enrolled?
- **Q3** SCIM deactivation of a **site-role holder**: recommended to refuse it (SSO sessions end,
  console banner). Or deactivate like anyone else?
- **Q4** May **SSO-provisioned users add local credentials** (passkey or password)? Recommendation:
  no in v1.
- **Q5** Manual vs IdP-managed membership: **manual wins, managed rows locked with "Take over"**
  (recommended), or IdP always wins?

## 17. Tickets

Two lanes after the migration. Lane A is OIDC (SSO-2 → 3 → 4 → 5); lane B is mapping and SCIM
(SSO-6 → 7 → 8). SSO-3 also needs SSO-6. SSO-9 and SSO-10 come last. Licence: `openid-client`
becomes a direct dependency (MIT, already inventoried; run `pnpm licenses:update`). The mock IdP
runs from an existing Node image with Kobe's own code, so it needs no new inventory row.
Choosing Keycloak instead would need an `inventory.yaml` row (Apache-2.0, test-only).

- **SSO-1 Migrations** (alone): `sso_providers`, `sso_identities`, `sso_access_mappings`,
  `session_sso_contexts`, `scim_tokens`, `scim_groups`, `scim_group_members`; `team_members`
  `added_via` check extended to `idp:<uuid>`; tenancy entries in `tenancy/identity.ts`
  (`teamReferencing` reason for mappings; least-privilege grants: `scim_tokens` no DELETE); backup
  exclusion of `session_sso_contexts`; audit event schemas. AC: migration up on a copy of the gate
  schema; cross-team probe suite green; grants match the registry; backup test shows the exclusion.
- **SSO-2 Provider configuration** (1): `/v1/site/sso/providers` CRUD, envelope sealing,
  discovery validation (tenant, issuer, S256, SSRF guard, allowed CIDRs), Helm `auth.sso` values,
  schema, start-up upsert and kill switch; Site console page. AC: `common` refused; issuer
  mismatch refused; secret never returned; Helm provider read-only in console; `enabled: false`
  hides all.
- **SSO-6 Mapping engine** (1): `applyIdpAccess`, mapping CRUD and console section, managed-row
  rules (highest role, manual wins, last admin, removals through `teams/members.ts`), Team console
  "Managed by" and Take over, conflict audit. AC: each rule in §7 has a db test; removal pauses
  schedules; team admin can't edit a managed row; Take over turns it manual.
- **SSO-3 OIDC sign-in** (2, 6): `kobe-sso` Better Auth plugin (start, callback), `openid-client`,
  state/nonce/PKCE cookie, ID token checks, JIT rule, overage handling, session creation, sign-in
  buttons, error page codes, rate limits, audit `method: sso`. AC: tampered or replayed `state`,
  wrong `nonce`, wrong `aud`/`iss`/`tid`, expired token and `alg: none` all refused (tests against
  the mock IdP); unmapped identity gets no user; `returnTo=//evil` lands on `/`; deactivated user
  refused.
- **SSO-4 MFA trust** (3): `mfa_rule` evaluation, the `claims` request for `acrs`, `requireSession`
  change, refusal, optional TOTP fallback, no TOTP enrolment from a non-MFA session; verify the
  Entra preset on a real tenant. AC: MFA-proving session passes `require_2fa`; non-proving refused;
  fallback asks TOTP only for enrolled users; enrolment endpoint refused for such a session.
- **SSO-5 Account linking** (3): link-required flow with local proof, admin-expected link (console),
  unlink (Me and admin), sessions of an unlinked identity revoked, password-reset guard for accounts
  without a credential. AC: same email never auto-links; a different local user doesn't link;
  expectation needs a verified domain; reset for an SSO-only user sends nothing.
- **SSO-7 SCIM Users and tokens** (2): token create/rotate/revoke (console, hashed),
  `/v1/scim/v2/<slug>` discovery endpoints, Users with Entra PATCH quirks and filters,
  deactivation and reactivation, site-role guard, rate limit, audit. AC: Microsoft's documented
  Entra request sequence for Users passes; `active: false` ends sessions in the same request;
  revoked token gets 401; site-role holder not deactivated.
- **SSO-8 SCIM Groups** (6, 7): Groups endpoints, member PATCH forms, `applyIdpAccess` on changes,
  overage users served from SCIM memberships, group delete. AC: add/remove member changes team rows;
  group delete removes managed rows; overage sign-in succeeds with SCIM memberships.
- **SSO-9 CI test IdP** (3, 8): a mock Entra-like OIDC provider in `e2e/` (Node + `jose`: tenant
  issuer, `oid`/`tid`, `roles`/`groups`, overage, `acrs`, bad-token modes) and a SCIM client that
  replays Entra's request sequences; deployed in k3d with no internet; an `e2e/gate-sso.sh` run in
  `e2e.yml`. AC: runs offline in k3d; covers sign-in, JIT, refusal, MFA, deactivation via SCIM.
- **SSO-10 Browser spec, guide and docs** (all): Playwright spec (SSO button, link flow, managed
  row in Team console, SCIM deactivation logs the browser out); guide pages (§18); `docs/install.md`
  (Entra app registration, redirect URI, app roles, optional claims `xms_edov`, auth context, SCIM
  attribute mapping `externalId ← objectId`, egress); `docs/backup-restore.md`. AC: spec green on
  gate1 against the mock IdP; site wording and hygiene checks pass; install steps reviewed against a
  real Entra tenant.

## 18. Guide updates (CLAUDE.md: every change is evaluated for `docs/guide`)

- `docs/guide/getting-started.md` — "Sign in": the "Sign in with &lt;your organization&gt;" button,
  linking an existing account, and what "no access" means.
- `docs/guide/admin/site-admin.md` — new "Single sign-on" section: providers, access mappings, MFA
  rule, SCIM tokens, expected links, the deactivation banner, break-glass.
- `docs/guide/admin/team-admin.md` — members managed by the identity provider, Take over.
- `docs/guide/reference/troubleshooting.md` — each `sso_error` code and its fix (overage, MFA
  missing, link required, tenant mismatch).
- `docs/guide/glossary.md` — single sign-on, identity provider, SCIM, access mapping, managed member.
