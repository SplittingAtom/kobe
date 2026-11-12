# KOBE-631: SSO-7 — SCIM 2.0 Users and tokens

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commit on `kobe-631-scim-users`, not pushed)
- **Branch / worktree:** `kobe-631-scim-users` in `../Kobe-wt631` (from group branch `kobe-sso` at
  `e6f20a4c`: KOBE-625 tables, KOBE-626 providers, KOBE-627 mapping engine)
- **Depends on:** KOBE-626. Unblocks SSO-8 (KOBE-632, Groups) and SSO-9's SCIM client.

## What landed

- **Migration** `0211_sso_scim_user_name.sql`: `sso_identities.scim_user_name` (nullable, ≤ 256,
  unique per provider ignoring case). SCIM `userName` need not be an address (Microsoft's validator
  sends `Test_User_<guid>`), and `GET ?filter=userName eq` must find it again.
- **Tokens** `sso/scim-tokens.ts`, console routes `routes/site-scim-tokens.ts`
  (`site.users.manage`, kill switch 404, `no-store`):

  | Route                                                         | Does                                |
  | ------------------------------------------------------------- | ----------------------------------- |
  | `GET /v1/site/sso/providers/:id/scim`                         | Tenant URL + tokens (prefix, dates) |
  | `POST /v1/site/sso/providers/:id/scim/tokens`                 | create; token in this response only |
  | `POST /v1/site/sso/providers/:id/scim/tokens/:tokenId/rotate` | second token beside a live one      |
  | `POST /v1/site/sso/providers/:id/scim/tokens/:tokenId/revoke` | final (trigger from KOBE-625)       |

  `kobe_scim_` + base64url(32 bytes); stored as SHA-256 hex + 14-char prefix; at most two live
  (409 `too_many_tokens`, provider row locked). Auth compares the presented hash constant-time
  against the live tokens **of the URL's provider only** (other provider, revoked, malformed,
  unknown slug: same 401 + `WWW-Authenticate`); `last_used_at` set per request by a conditional
  update (a concurrent revocation wins). Audit `identity.scim.token.created|revoked {providerId,
credentialId}`, never the token.

- **SCIM** `routes/scim.ts`, mounted at `/v1/scim/v2` **before** the session API: no cookie is read,
  no CSRF surface; a catch-all SCIM 404 keeps unknown paths (Groups, `/Me`, `/Bulk`) from falling
  through to `requireSession`. Discovery `ServiceProviderConfig` (patch, filter max 200; bulk, sort,
  etag, changePassword false; `oauthbearertoken`), `ResourceTypes` (User only), `Schemas`.
  `Users`: GET list (`userName eq`, case-insensitive; `externalId eq`; `id eq`; anything else 400
  `invalidFilter`, never a full listing), `startIndex`/`count` (default 100, max 200), GET by id,
  POST, PUT, PATCH, DELETE. Store `sso/scim/users.ts`; input `sso/scim/user-input.ts`.
- **Limits:** 600 req/min per token (Postgres `rate_limits`, 429 + `Retry-After`); 30 failed
  authentications/min per client address; body ≤ 64 KiB (413); body type `application/scim+json`
  or `application/json` (415); responses always `application/scim+json`, `no-store`; errors RFC
  7644 (`schemas`, `status` string, `scimType`, `detail`).
- **Kill switch:** `auth.sso.enabled: false` → every SCIM and token route 404. A **turned-off
  provider** answers 403 to its (valid) token.
- **Audit:** SCIM requests run as the system actor (`auditSystemContext`, new in
  `audit/context.ts`); events carry `credentialId`: `identity.scim.user.created|updated|
deactivated|reactivated`, `identity.sso.link.created {method: scim}`, `identity.sso.link.removed
{by: scim}`, `identity.scim.deactivation_refused`; the shared path adds `identity.user.
deactivated|reactivated` (actor system).
- **Console:** Site console → Single sign-on → a provider's **SCIM** button opens
  `components/admin/site/sso-scim.tsx`: Tenant URL, tokens (prefix, created, last used, status),
  Create token, Rotate (while < 2 live), Revoke (confirm). A new token is shown once with Copy/Hide.

## Entra quirks covered (`user-input.test.ts`, `scim.db.test.ts`)

`op` in any case; path-less ops whose `value` is an object of attribute paths; `active` as
`"True"`/`"False"`; `emails[type eq "work"].value` (and `primary eq true`); `emails` arrays (work,
else primary, else first); `name.*` paths and `name` objects; core-schema URN prefixes; the
enterprise extension, `roles` (SSO-8) and every other attribute accepted and ignored; the random
`userName eq` probe answers an empty list; soft delete via `active: false` then `DELETE`.

## Decisions

- **Deactivation is the console's path:** `deactivateUser`/`reactivateUser` (sessions and
  verifications deleted in the same transaction, egress told, invitations revoked) then
  `deps.lifecycle.emit` (schedules, shares, projects, sandboxes, catalog maintainers, offboarding).
  Both functions gained an optional `inTx` hook so SCIM's audit rows and DELETE's unlink commit in
  the same transaction. There is no connector-grant deactivation hook today (grants are refused by
  `requireSession`/deactivated checks), so none is called.
- **Protected users (SSO8, SSO10):** the Owner, any site Admin, and the setup Owner (the
  `identity.setup.completed` audit row, so a transfer doesn't drop the protection). A PATCH/PUT that
  changes their `active`, or a DELETE, changes nothing and answers 403 with a detail pointing to the
  Site console; their SSO sessions **from this provider** end (local ones stay: break-glass), and
  `identity.scim.deactivation_refused` is recorded. Reactivating them by SCIM is refused too.
- **Never re-address a local account:** `users.email` follows `userName` (when an address, else
  the work email) only for users **without** a local password and without a site role; otherwise
  the IdP could send a break-glass account's reset mail elsewhere. The SCIM `userName` still
  updates.
- **`externalId` required** (400 otherwise, with the attribute-mapping hint); for Entra it must be
  a GUID (lowercased). POST on an address an unlinked user owns → 409 `uniqueness` pointing to
  admin-expected linking; never linked on email (§6).
- **DELETE** = deactivate + unlink (a later GET is 404); the user row stays.
- **PUT without `active`** leaves activation as it is; POST without it creates an active user.
- **Name:** Kobe keeps one name: `displayName`, else `name.formatted`, else given + family; a PATCH
  of one name part alone keeps the name.
- **No team access from SCIM yet:** created users have no memberships until SSO-8's groups or an SSO
  sign-in mapping gives them some (spec §7/§10); the engine is not called here.
- **Password reset guard (§6, SSO9):** `mailResetLink` sends nothing to a user without a
  `credential` account and drops the unsent token (`auth/reset-links.ts` `hasLocalPassword`).
  SSO-5 (KOBE-630) lists this guard too: it is in place, nothing more needed there.

## Spec deviations / open points

- A turned-off provider refuses SCIM (403); the spec is silent. Turning a provider off now stops
  everything it does.
- The Site console banner for a refused deactivation (§10 "Q3 recommendation") is not built: the
  refusal is audited; the banner fits SSO-10's console/guide pass (or a small follow-up).
- `identity.scim.user.updated` has no field list (schema has ids only).

## Guide pages SSO-10 (KOBE-634) must update

- `docs/guide/admin/site-admin.md` (Single sign-on section): SCIM provisioning — the Tenant URL,
  Create token (shown once), Rotate (two live at most) and Revoke, last used, provider must be on;
  what SCIM changes (create, name, address for SSO-only users, deactivate/reactivate, DELETE =
  deactivate + unlink); Owner/Admins/setup Owner never deactivated (403, audit
  `identity.scim.deactivation_refused`); provisioned users have no password; no team access until
  a mapping applies; after restoring a backup, rotate SCIM tokens (§14).
- `docs/guide/reference/troubleshooting.md`: SCIM 401 (wrong/revoked token or another provider's
  URL), 403 provider turned off / protected user, 404 kill switch, 409 `uniqueness` (address of an
  unlinked local user → expect an SSO link), 400 `externalId is required` (map objectId →
  externalId), 429.
- `docs/guide/glossary.md`: SCIM, SCIM token.
- `docs/install.md` (Entra app registration): provisioning mode Automatic, Tenant URL
  `https://<kobe>/v1/scim/v2/<slug>`, Secret Token, attribute mapping `externalId ← objectId`,
  inbound reachability from Entra's provisioning service.

None changed in this ticket (SSO-10 owns the SSO guide pages).

## Evidence

- ac-1 Entra sequence: `services/server/src/scim.db.test.ts` "Microsoft Entra's SCIM request
  sequence" (probe, validator create, duplicate 409, filters, PATCH multi/single-valued, path-less,
  active False/True, GET, DELETE).
- ac-2 sessions end in the same request: same test (`sessionExists` false right after the PATCH).
- ac-3 revoked token 401: "rotates: the old token works until it is revoked".
- ac-4 provider boundary: "accepts only the provider's own bearer token", PUT test (B can't see A).
- ac-5 site-role holder: "the site-role guard" (Owner, Admin, setup Owner).
- ac-6 no password / reset sends nothing: "SCIM-created users and local credentials".
- Units: `sso/scim/user-input.test.ts`; web: `apps/web/components/admin/site-sso-scim.test.tsx`.

## Later changes

The security review fixes in [KOBE-sso-review1](KOBE-sso-review1.md) changed parts of this ticket (address source and verification, SSO9 guard, kill switch sessions, SCIM externalId and reactivation, setup Owner flag).
