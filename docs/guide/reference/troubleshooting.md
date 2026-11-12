---
title: Troubleshooting and FAQ
summary: Answers to common problems and questions, such as a slow first answer, blocked websites, missing models, read-only files, lost drafts and stuck approvals.
section: Reference
order: 2
audience: member
---

Short answers to the questions people ask most, grouped by where the problem shows up. If none of
these fits, ask your team admin; they can see your team's settings and audit log.

## Conversations

**The first answer of the day takes a while.** Your sandbox sleeps when you are away. The first
message wakes it, which can take a little time; your files are kept.

**The agent seems stuck.** Look for an approval card waiting for you higher up in the answer. If
there is none, press **Stop** and send your message again, or **Retry** an interrupted answer.

**My message did not go out.** While the agent works, Enter queues your message until the run
ends. Use **Steer now** to pass it into the running agent instead.

**"The model hit its output limit here, so this reply is incomplete."** Ask the agent to continue,
or to write long results to a file.

**The conversation got slow or forgetful.** Long threads fill the model's context window. Check
the gauge under the composer and use **Compact now**, or start a new conversation and mention the
files you need.

**I can't type in a conversation.** It was shared with you read-only. Fork it (**Fork to a new
thread**) to continue in your own copy.

**I deleted a thread by mistake.** Open **Deleted** in the Threads panel and **Restore** it. Threads
in Trash are deleted for good after 30 days.

## Models and budgets

**"No models are enabled for your team yet."** A team admin needs to enable models in the team
console's **Models** page.

**Model calls are refused.** A team or member budget may be used up. Ask a team admin.

**I can't pick a thinking level.** The conversation's model has no thinking levels, or the agent
fixes its model.

## Files

**I can't save a file.** It is read-only: a project file you have not checked out, a project where
you are a reader, or an attachment under `uploads/`. Use **Save As** to save a copy in My files,
or **Check out to edit** if you are an editor.

**"Nothing was saved" when I pressed Save.** The file changed since you opened it. Choose
**Compare**, **Keep mine** or **Take theirs**. Nothing was overwritten.

**A file called `name.conflict-…` appeared.** You and the agent changed the same file at the same
time. Your version kept the name; the agent's version is in the conflict copy. Keep what you need
and delete the other.

**My unsaved changes are gone.** Drafts live in the browser tab; a full page reload loses them.
Save often.

**The agent changed a file I had open without asking.** The agent proposes instead of writing only
for the file you are viewing when you send the message, and only for its file tools. Keep the file
open while you ask, and ask it to propose changes.

**The kernel lost my variables.** It restarted, stopped after 30 idle minutes, or the sandbox went
to sleep. Run your setup cells again.

## Skills

**My skill never loads.** Every new version of a team skill needs a team admin's approval in
**Skill review** before any run uses it. A personal skill needs one too unless its scan says Pass.
Check also that the skill is switched on for you on the Skills page's **Mine** tab. See [Skills](../agents/skills.md)
(Why isn't my skill showing up?).

## Internet, connectors and approvals

**"Internet access to … was blocked".** The site is not enabled for your team. Press **Request
access**. See [Internet access](../internet-and-approvals/internet-access.md).

**A connector shows a red cross.** Open **+** → **Connectors** to read the reason. Often you need to
add your own key in **Profile → My connectors**.

**The agent says it has no admin tools.** Kobe's admin tools need all of these: a site admin chose
**Docs and admin tools** (Site console → Settings → Kobe connector), your team admin set the Kobe
card on the team console's **Connectors** page to **Read** or **Read and write** (changes need Read
and write), the agent uses the kobe connector (the gallery agent Kobe does; others must list
**kobe** among their connectors), and your role allows the action (members get none). Scheduled
and auto runs never make admin changes. **+** → **Connectors** shows which admin tools you have.
See [Admin from a conversation](../admin/admin-from-a-conversation.md).

**An admin change says "changed since approval".** The setting changed between the card and your
Allow, so nothing was changed. Ask the agent to read it again and approve the new card.

**An approval expired.** Approvals wait one hour. Send your message again and answer the card.

**My remembered approval did not apply.** Remembered approvals never apply to scheduled or auto
runs, never override your team's ask or deny rules, and end when their time runs out. Check
**Profile → My approvals**.

**My schedule skipped a step.** Scheduled runs cannot ask, so calls that need approval are
skipped. Ask a team admin for a team allow rule if the tool should run unattended.

## Memory

**The agent forgot something.** Check **My memory**: the note may not have been saved, or memory
may be switched off for your team. Ask the agent to "remember" it explicitly.

**The agent remembered something wrong.** Open **My memory**, edit or delete the file, or press
**Undo** on the **Memory updated** chip right after it was saved.

## Single sign-on

Messages on the sign-in page after **Sign in with _your organization_** (the address bar shows
`?sso_error=<code>`; administrators find the precise reason in the audit log as
`auth.sign_in.failed`, method `sso`). See
[Signing in with your organization](../getting-started/single-sign-on.md).

**"Your organization's sign-in can't be used for this site yet"** (`not_allowed`). Either your
organization gave you no app role or group that a site admin mapped to a team (ask your
administrator for access), or a Kobe account with your address exists: sign in below with its
password or passkey within 10 minutes and confirm the link. Administrators: the audit reason is
`no_access` or `link_required`.

**"This account is deactivated"** (`deactivated`). A site admin or your organization (through
SCIM) deactivated it. A site admin reactivates it in **Users**; SCIM reactivates only accounts SCIM
deactivated.

**"…did not include multi-factor authentication"** (`mfa_missing`). The site requires two-factor
authentication and the organization's sign-in did not prove MFA. For Microsoft Entra ID that
proof needs a Conditional Access authentication context (`c1`) with a policy that requires MFA,
which needs Entra ID P1 ([Single sign-on](../admin/single-sign-on.md#multi-factor-authentication)).
The same check refuses a running session (`mfa_missing`) after a site admin turns the requirement
on, and refuses adding a passkey, password or authenticator app from such a session
(`SSO_MFA_REQUIRED`).

**"…carried too many groups"** (`groups_overage`). The token named more than 200 groups, so Entra
left the list out. Administrators: map app roles instead, or have Entra send only "Groups
assigned to the application".

**"…came from a different organization"** (`tenant_mismatch`). The token's tenant (`tid`) or
issuer is not the one the provider is pinned to. Sign in with your work account of that
organization.

**"…did not include an email address"** (`email_missing`). Administrators: add the `email` and
`upn` optional claims (Entra), or the `email` scope and claim (other providers).

**"That sign-in link expired or was already used"** (`state_invalid`). The sign-in took more than
10 minutes, was finished in another browser, or the page was reloaded. Start again.

**"…could not be verified"** (`token_invalid`). The token's signature, audience, nonce or times
failed Kobe's checks (often a clock more than a minute off, or a sign-in older than 10 minutes).
Start again; administrators check the server's and the provider's clocks.

**"Sign-in was cancelled or refused…"** (`idp_error`). You cancelled, or the provider refused (for
example you are not assigned to the Kobe application).

**"…could not be reached"** (`idp_unreachable`). The server could not reach the provider.
Sign in with your password or passkey, or try later. Administrators: check the server's egress to
the provider (for Entra `login.microsoftonline.com` on 443).

**"That sign-in option is not available right now"** (`provider_unavailable`). The provider was
turned off or single sign-on is switched off for the site.

**I can't set a password or add a passkey** (`SSO_ONLY_ACCOUNT`). Your account was created by
your organization's sign-in; it signs in only through your organization.

**I can't unlink my organization sign-in** (`last_sign_in_method`). It is your only way to sign
in. Ask a site admin.

**Things site admins and team admins may see:**

- **Test discovery fails.** Each failed check says why: an issuer for any organization
  (`multi_tenant_issuer`), a document naming another issuer (`issuer_mismatch`), no PKCE S256
  (`no_pkce_s256`), a private or disallowed address (`address_not_allowed`: add the range to
  `auth.sso.allowedInternalCidrs` for an on-premises provider), a redirect (`redirect_refused`), or
  the document could not be fetched (`unreachable`).
- **"This provider is set in the chart's values"** (`managed_by_helm`): change it in the values.
  **"People have signed in with this provider…"** (`identities_linked`, `identity_settings_locked`):
  turn it off instead of deleting it; add a new provider for a new tenant or issuer.
- **"The identity provider manages this membership"** (`managed_by_idp`): **Take over** first, or
  change the person's app role or group at the provider. Your own managed membership is taken over
  by another team admin (`cannot_take_over_self`).
- **A mapping is refused** for a site role (`site_role_not_mappable`): mappings grant team roles
  only. **`mapping_conflict`** in the audit log: a mapping met a membership made by hand (which
  wins) or would remove a team's last team admin (kept, retried at the next change).
- **Expect SSO link is refused**: the address's domain is not one of the provider's verified
  domains (`domain_not_verified`), the person is the Owner or the setup Owner (`protected_user`: they
  link by signing in themselves), or they are already linked (`already_linked`). The setup Owner's
  password or passkey can't be removed from a single sign-on session (`SETUP_OWNER_LOCAL_ONLY`).
- **SCIM answers** (seen in the provider's provisioning logs): **401** wrong or revoked token, or a
  token of another provider's Tenant URL; **403** the provider is turned off, or the person is the
  Owner, a site Admin or the setup Owner (never deactivated by SCIM), or an admin deactivated them
  (SCIM can't reactivate); **404** single sign-on is switched off for the site; **409
  `uniqueness`** the address belongs to an unlinked local account (use **Expect SSO link**);
  **400 "externalId is required"** map objectId to externalId; **400 `mutability`** externalId
  can't change once set; **429** too many requests for the token.

## Account

**I forgot my password.** Use **Forgot your password?** on the sign-in page. If you sign in with
your organization's account and never had a Kobe password, there is none to reset: use **Sign in
with _your organization_**.

**I see the wrong workspace's threads.** Switch with the **Workspace** switcher at the top of the
rail.

## Related

- [Glossary](../glossary.md)
- [Getting started](../getting-started.md)
