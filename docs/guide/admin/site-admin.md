---
title: Site admin overview
summary: What site admins do and where each setting lives in the Site console (people, grants such as Site memory steward, teams, models, connectors, egress ceiling, policy floor, appearance, audit and backups).
section: Site admin
order: 1
audience: admin
---

Site admins run one Kobe site for the whole organization: they invite people, create teams, connect
model providers and connectors, set the limits every team works within, and look after branding,
audit and backups. This page is a map of the **Site console** (`/admin/site`), opened from **Site
console** in the top bar.

## Site roles

There are three site roles: **Owner**, **Admin** and **User**. Owners and Admins are site admins and
can use every Site console page. Only the Owner grants or removes Admin and transfers ownership.
Site admins cannot read a team's conversations or files; when they must, they use break-glass
access, which is time-boxed, read-only, audited and shown to the team.

## People

- **Users**: everyone with a Kobe account: site role, two-factor status, deactivate and reactivate.
  With single sign-on on, **Single sign-on** on a row shows the person's linked organization
  sign-ins (**Unlink**) and **Expect SSO link**: their next sign-in from the chosen provider links
  automatically when its verified address matches theirs and lies in one of the provider's
  verified domains (once, within 14 days). The Owner and Admins link only by signing in themselves.
- **Single sign-on** and **SSO access mappings**: let people sign in with Microsoft Entra ID or
  another OpenID Connect provider, decide which app roles or groups give which team role, and
  create SCIM tokens so the provider provisions and deactivates accounts. See
  [Single sign-on](single-sign-on.md).
- **Invitations**: invite people by email; resend or revoke open invitations.
- **Site roles**: who is Owner and who are Admins, and two grants that sit beside the roles and
  are given and taken by Site admins (audited as `identity.site_grant.granted` and `.revoked`):
  - **Skill reviewers** review Skill Registry submissions.
  - **Site memory stewards** curate Site memory: they add, edit, archive and pin the facts and
    conventions every workspace sees, and accept or dismiss the proposals team admins send to
    the Site. They can't make an item Policy or change memory switches, and the grant gives no other Site
    right (no Site console pages). Site admins can already do all of this, so only users are
    offered. **Take Site memory steward** ends it after a confirmation; what they saved stays.

## Teams and agents

- **Teams**: create teams (workspaces) with their first team admin and rename them. **Manage
  members** opens a team's members: name, email, team role, how they joined (invitation, site
  admin, or "Managed by _provider_" for single sign-on) and whether the account is active. From
  there you can:
  - **Add existing users** without an invitation: search by name or email, tick one or several,
    choose a team role (Member, Contributor or Team admin) and **Add**. They are in the team at
    once and are told in Kobe (and by email); a pending invitation of theirs to the team is
    withdrawn. Deactivated users and accounts whose email address isn't verified (for example a
    single sign-on account whose provider didn't vouch for the address) can't be added: invite
    those people instead.
  - **Change a team role** or **Remove** a member, with the same rules and effects as the Team
    console: a team always keeps one active team admin; a removed member's schedules there pause,
    their sandbox is cleaned up and their shared threads go private.
  - **Take over** a membership the identity provider manages: it can't be changed or removed
    until you do, and the identity provider stops managing it from then on.

  You can't add yourself or change your own membership here: site admins reach team content only
  through break-glass. Site roles never change here. Every change is in the team's own audit log
  under your name, marked as made by a site admin, and the team's admins are told in Kobe (and by
  email) each time.

- **Gallery agents**: the site's agents on the Agents page's Site tab: edit, compare with the
  repository, reset, evaluate, export, approve proposals.
- **Skill Registry**, **Skill reviews** and **Skill tags**: the registry's rules and judge, the
  review queue for submitted skills, and topic tags and site default skills.

## Models and connectors

- **Models and providers**: provider keys and the model catalog with aliases. Teams choose from
  this catalog.
- **Connector registry**: register MCP servers teams may enable, their credentials (a site key or
  each member's own key), pinned tools, and where their apps open (in the conversation, the
  artifact column or the rail). Select a connector's name to open its details at the side: server
  URL, authentication and whose key it uses (never the key itself), status and when Kobe last
  checked it for changes, which teams enabled it and with what exposure, its app templates
  (`ui://`) with their approval and where each opens, and every tool under **Read only** or
  **Write** with its description, risk hints (destructive, idempotent, open world), inputs, whether
  it is pinned or awaiting approval, and an **MCP-UI** badge when it opens an app. The details are
  read-only; **Review**, **Re-probe**, **Enable**/**Disable** and **Site key** stay in the row.
  Escape or **Close** returns to the list.

## Safety

- **Egress ceiling**: the domains any team may enable, with presets; site-scope access requests;
  marking a domain internal (same cluster). See [Internet access](../internet-and-approvals/internet-access.md).
- **Policy floor**: site-wide deny and ask rules, the minimum approval mode every team inherits,
  and remember limits.
- **Skill blocklist**: skill content that never loads anywhere on the site.

## Governance

- **Audit log**: the site-wide, append-only audit log.
- **Usage and spend**: spend by team, user, agent and model, and the site budget every team's
  spend counts against.
- **Retention maximum**: the longest retention any team may choose.
- **Legal hold**: suspend purges for a team or user (needs two people).
- **Break-glass**: request and approve time-boxed, read-only, audited access to one team.

## System

- **Appearance**: the site name, logo, dark logo, favicon and style preset. See
  [Appearance](../appearance.md).
- **Settings**: site-wide settings such as required two-factor authentication (local accounts
  enrol an authenticator app; a single sign-on sign-in counts only when the identity provider
  proved multi-factor authentication, for Microsoft Entra through a Conditional Access
  authentication context, and is refused otherwise; see
  [Single sign-on](single-sign-on.md#multi-factor-authentication)), and the site's
  memory switches and settings: **Allow memory** (the master switch: off means no notes, no
  memories and no Site Policy anywhere; it is the only switch that stops Policy), project notes, memories, **Portable preferences**, **Learn from this chat**
  and **Members may propose to the Site**, each also needing the workspace's own switch; the
  **learning model** (used by workspaces without their own, where enabled; learning never falls back
  to another model or the conversation's model), the context budget (4 to 16 KiB), scope limits, versions kept per memory,
  the stale threshold, the retention window and learning rate limits. Turning a switch off deletes
  nothing. See [Memory](../memory.md#switches-that-control-memory). The **Kobe connector** setting is **Off**, **Docs only** (the
  default) or **Docs and admin tools**; see below.
- **Isolation**: whether agents can run. Kobe refuses to run agents unless the cluster offers a
  gVisor or Kata sandbox runtime; this page shows the check and how to fix it.
- **Backup and restore**: how to back up and restore the site, and the last restore.
- **Audit forwarding**: whether audit events reach your security monitoring system.

## From a conversation

The built-in **Kobe** connector gives every agent the guide's docs tools. Its admin tools are off
until you choose **Docs and admin tools** under **Settings → Kobe connector**; each team admin then
chooses a level for their team (**Docs only**, **Read** or **Read and write**). In a team at Read
and write, a site admin can ask the agent to deactivate or reactivate a user, create a team, add
people to a team, change their team role or remove them, invite someone, update the model catalog, change a connector's status, edit the egress ceiling,
decide access requests, manage the skill blocklist and site grants (Skill reviewer, Site memory steward), change branding or
the site budget, and read usage and the audit log. Each change shows an **Admin change** card
("Whole site") first and is audited "via agent". Site roles, ownership, break-glass, legal hold,
retention, deletions, connector registration, provider keys and the site settings themselves stay
in the console. See [Admin from a conversation](admin-from-a-conversation.md).
