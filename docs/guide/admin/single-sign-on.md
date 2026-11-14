---
title: Single sign-on
summary: How site admins connect Microsoft Entra ID or another OpenID Connect provider, map app roles or groups to teams, trust the provider's multi-factor authentication, provision accounts with SCIM and keep a break-glass sign-in.
section: Site admin
order: 2
audience: admin
---

With single sign-on, people sign in with your organization's account (**Sign in with
_provider_**) instead of a Kobe password. Local sign-in with passwords and passkeys keeps working
beside it. Kobe works with Microsoft Entra ID and any other OpenID Connect provider; the
registration on the provider's side is in the installation guide (`docs/install.md`, "Single
sign-on").

Everything here is in the **Site console** under **People**: **Single sign-on** (providers and
SCIM) and **SSO access mappings**. If neither page shows, single sign-on is switched off for the
whole site (see [Switching it off](#switching-it-off)).

## Providers

**Add provider** asks for:

- **Kind**: **Microsoft Entra ID** or **Other OpenID Connect provider**.
- **Display name**: what the sign-in button says ("Sign in with Contoso").
- **Slug**: a short name in the provider's addresses. It can't change later.
- **Directory (tenant) ID** for Entra, or the exact **Issuer** for another provider. A provider
  that admits any organization (`common`, `organizations`, `consumers`) is refused.
- **Client ID** and **Client secret** from the app registration. The secret is stored encrypted
  and never shown again (the list says **Set**); enter a new one to replace it.
- **Access from**: **App roles (recommended)** or **Groups**.

The form shows the **redirect URI** to paste into the app registration:
`https://<your Kobe address>/api/auth/sso/callback/<slug>`. **Test discovery** checks the
provider before you save, and saving runs the same checks. Each check is listed as passed or
failed: the issuer belongs to one tenant, its address is allowed, the discovery document was
fetched and names the same issuer, the authorization code flow and PKCE are supported, and the
endpoints are allowed. **Test** on a saved provider runs them again.

A new provider is **Off**. Add its access mappings first, then **Turn on**: the sign-in page then
shows its button. **Turn off** hides the button and ends every session signed in with it at once;
local sessions are unaffected. **Delete** works only while nobody has signed in with the provider;
afterwards turn it off instead. Once someone is linked, its tenant, issuer and subject can't change
either; add a new provider for a new tenant.

A provider marked **Set in Helm values** is declared in the chart. It is read-only here except for
its access mappings; change it in the values. A few settings have no field in the form yet and
are set in the values (or by the API): the tenant's **verified email domains**, the MFA rule, a
**maximum session length** for SSO sessions, and whether accounts are created at first sign-in.

## Access mappings

Nobody gets a Kobe account through single sign-on unless an access mapping lets them in. A mapping
says: people whose token carries this **app role or group** are in this **team** with this **team
role** (Member, Contributor or Team admin).

- **App roles are recommended.** Define them in the app registration (for example
  `Kobe.Member.Research`) and assign people or groups to them. A token then carries only the
  roles of that person. With **Groups**, use the group's object ID and have Entra send only the
  groups assigned to the application: a person in more than 200 groups gets a token without the
  list, and Kobe refuses that sign-in.
- **The highest role wins** when several mappings match the same team.
- **Team roles only.** A mapping never makes anyone a site admin or Owner; site roles stay in
  **Site roles**.
- **Memberships made by hand win.** A membership someone was invited to, or that a site admin or
  team admin added or took over, is never changed by a mapping, even when the mapping would give
  more. The conflict is recorded in the audit log (`identity.sso.mapping_conflict`).
- **The last team admin stays.** If a mapping would remove or demote a team's last active team
  admin, Kobe keeps the membership, records a conflict and tries again at the next change.
- **When it applies.** At each person's next sign-in (and at once for people SCIM provisions).
  Someone whose roles no longer match loses the memberships the provider gave them; if that leaves
  them with no team and no site role, their sign-in is refused.

Memberships a mapping made show **Managed by _provider_** in the Team console and in **Teams →
Manage members**. Team admins can't change or remove them there: they **Take over** a membership,
after which the provider never touches it again. Removing the person from the app role or group
at the provider is the way to take their access away. Team admins see the mappings that target
their team, read-only, under **Show access mappings** in the Team console.

## Signing in, linking and the break-glass account

- **First sign-in.** A person with a mapped app role or group and no Kobe account gets one at
  their first sign-in. Accounts made this way have no Kobe password or passkey and can't add one:
  they sign in only through the provider, so disabling them at the provider can't be outlived by a
  local password. A password-reset request for them sends nothing.
- **Someone who already has an account** with the same address is never linked by address alone.
  They are told to sign in with their Kobe password or passkey within 10 minutes and then confirm
  the link (see [Signing in with your organization](../getting-started/single-sign-on.md)).
- **Expect SSO link** (Users → a row's **Single sign-on**): for migrations, the person's next
  sign-in from the chosen provider links on its own when the provider vouches for their address
  and it lies in one of the provider's verified domains (once, within 14 days). The Owner and the
  setup Owner are never linked this way.
- **Unlink** (Users → **Single sign-on**, or the person in **Profile → Sign-in methods**) ends the
  sessions signed in with that provider. An account's only way to sign in can't be unlinked.
- **Break-glass.** The Owner created when Kobe was set up always keeps local sign-in: no single
  sign-on step links it away, removes its password or passkey, or deactivates it. Local sign-in
  never contacts the provider, so it works while the provider is down. Keep that account's
  password or passkey somewhere safe.

## Multi-factor authentication

Kobe trusts the provider's multi-factor authentication. With **Settings → Require two-factor
authentication for everyone** on, a single sign-on sign-in counts only when the provider proved MFA; otherwise
it is refused with "did not include multi-factor authentication". SSO users are not asked for a
Kobe authenticator code, and a session whose sign-in did not prove MFA can't add a passkey,
password or authenticator app.

For **Microsoft Entra ID** the proof is a Conditional Access **authentication context** (Kobe asks
for `c1`): create the context and a Conditional Access policy that requires MFA for it. This
**needs Entra ID P1** (Conditional Access). Without it, no Entra sign-in proves MFA, so leave
**Require two-factor authentication** off while people sign in with Entra, or they are all
refused. Other providers prove MFA with the `amr` claim (for example `mfa`, `otp`, `hwk`).
When you turn the setting on, every SSO session whose sign-in did not prove MFA is refused from
its next request.

## SCIM provisioning

With SCIM, the provider creates Kobe accounts before people first sign in, keeps their names (and,
for SSO-only accounts, addresses) current, and deactivates them when they are unassigned or
blocked. **SCIM** on a provider's row shows:

- the **Tenant URL** to paste into the provider (`https://<your Kobe address>/v1/scim/v2/<slug>`);
- **Create token**: the token is shown once; copy it into the provider's Secret Token field;
- the tokens with when they were created and **Last used**. **Rotate** adds a second token while
  the old one keeps working (at most two), so you can switch the provider over, then **Revoke** the
  old one. Revoking stops it at once and can't be undone.

Provisioning works only while the provider is turned on. What SCIM does:

- **Creates** accounts (no password; team access only once a mapping applies at sign-in). In
  Entra, map **objectId** to **externalId**: Kobe refuses a user without it.
- **Deactivates** an account when the provider says so: every session ends at once, the person is
  signed out in the browser. Deleting the user at the provider
  deactivates and unlinks them; Kobe never deletes accounts. The memories that follow the person
  across workspaces are kept until a site admin purges them (Site console › Users › **Purge
  memories**); their own memories in each workspace go 30 days later. See
  [Memory](../memory.md#how-long-memories-are-kept).
- **Reactivates** only accounts SCIM itself deactivated. Someone a site admin deactivated stays
  deactivated until a site admin reactivates them (`identity.scim.reactivation_refused`). A
  reactivated account finds its memories unchanged; a new account the provider creates instead
  of the old one (just-in-time) starts with none.
- **Never deactivates the Owner, a site Admin or the setup Owner.** It ends their SSO sessions,
  refuses the request and records it (`identity.scim.deactivation_refused`); deactivate them in
  **Users** if you mean to.
- An address that belongs to an unlinked local account is refused: use **Expect SSO link** for that
  person.

Group provisioning is not available yet; team access comes from the app roles or groups in the
sign-in token. After restoring an older backup, rotate every SCIM token (a token revoked since the
backup would work again).

## Switching it off

- **One provider:** **Turn off** (sessions signed in with it end at once).
- **The whole site:** the installation's `auth.sso.enabled: false` (the kill switch) hides every
  provider, button and console page, refuses SCIM and ends every session signed in through single
  sign-on. Local sign-in keeps working; nothing in the database changes, so switching it back on
  restores the providers as they were.

Every change here (providers, mappings, links, tokens, SCIM changes, take-overs) is in the
**Audit log**; failed SSO sign-ins are there with their precise reason (`auth.sign_in.failed`,
method `sso`). For the messages people see, see
[Troubleshooting](../reference/troubleshooting.md#single-sign-on).
