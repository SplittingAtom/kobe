---
title: Admin from a conversation
summary: How team and site admins let agents read and change Kobe's settings from a conversation through the built-in Kobe connector, with an approval card for every change, audit "via agent" and what stays console-only.
section: Team admin
order: 2
audience: admin
---

Kobe ships a built-in connector called **Kobe**. Its docs tools let every agent read this guide;
its admin tools let an agent do Team console and Site console work for the person in the
conversation, such as "make Ana a contributor" or "show me this month's usage by model". This page
explains how to turn the admin tools on, what they can do and how Kobe keeps them safe.

## What the agent acts as

The agent acts as **the person who owns the conversation**, with exactly their permissions: their
team role, their site role and grants such as Skill reviewer, never more. Each admin tool runs the
same server code as its console page, so the agent cannot do anything that person could not do in
the console. A member gets no team tools, a contributor only the skill installs list, and a team
admin all of the team tools; site tools need a site role (or the Skill reviewer grant for the
review tools). If someone loses a role,
their next call already reflects it.

Teammates viewing a shared thread never act through it: only the conversation's owner is the
person, and only they can approve.

## Turn it on

Admin tools are off until two admins turn them on. The docs tools are on everywhere unless a site
admin switches the whole connector off.

1. **Site console → Settings → Kobe connector** (site admins): **Off** (no Kobe connector, not
   even the docs tools), **Docs only** (the default) or **Docs and admin tools**.
2. **Team console → Connectors → Kobe** (team admins), once the site allows admin tools:
   **Docs only** (the default), **Read** (the agent may read the team's settings as the person) or
   **Read and write** (it may also change them, each change approved first). While the site is at
   Docs only, the card says so and admin tools stay off whatever the team chooses. Site tools
   follow the team's level too: a site admin gets them only in a team at Read (reads only) or
   Read and write.

The agent must also use Kobe: the gallery agent Kobe does (it uses every connector), and in the
agent creator you can add **kobe** to an agent's connectors. Neither switch can be changed from a
conversation: the agent cannot raise its own access.

In the composer, **+** → **Connectors** shows the Kobe row with no checkbox ("Docs always on")
and a line saying which admin tools you have in this team.

## What the agent can do

Reads run without asking. Every change asks first (see below).

| Area                    | From a conversation                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Members and invitations | List members, change a role, remove a member; list, send and revoke invitations.              |
| Connectors              | List the team's connectors, change a connector's exposure, disable one.                       |
| Skills                  | List installs and the review queue; approve, request changes or reject a version.             |
| Models and budgets      | Read and change the team's models, team budget and member budgets.                            |
| Memory                  | Read and change the team's memory switches.                                                   |
| Egress                  | List domains and access requests; enable or disable a domain; decide a request.               |
| Agents and schedules    | List the team's agents and schedules; suspend or resume an agent, pause or resume a schedule. |
| Usage and audit         | Read usage and the team audit log, page by page.                                              |

With a site role, the agent can also work on the Site console: list, deactivate and reactivate
users; list and create teams; site invitations; the model catalog (labels, prices, limits);
connector status; the egress ceiling and site access requests; the skill blocklist; Skill reviewer
grants; branding; the site budget; usage and the audit log. A Skill reviewer can claim, comment on
and decide registry reviews.

Results are compact and paged (at most 50 rows a call). Audit reads through the agent never
include IP addresses or user agents, and no tool ever returns a secret such as a connector key or
an injected header value.

## What stays in the consoles

There is no tool for high-consequence or two-person actions. The agent can explain them and link
to the console page, but you do them yourself:

- break-glass access, ownership transfer, site roles, legal hold, retention and every deletion;
- registering or editing connectors (they need a probe with an admin's key), model providers and
  keys, adding catalog models;
- egress injected headers, and disabling a domain that has them (their values would be lost);
- the site switch, the team's Kobe level, sign-in and two-factor settings, isolation, backups and
  audit forwarding.

## Every change asks, every time

An admin change shows an **Admin change** approval card to the conversation's owner. It names the
scope ("Team _name_" or "Whole site"), a summary Kobe builds from the input (with people's names,
never the model's words, for example `Change the role of member "Ana Lee": Member → Contributor`),
a before → after table, and the exact input. Press **Allow** or **Deny**.

- The card asks in every approval mode, Dangerous included. It is never remembered, never part of
  **Approve all waiting**, and has no Remember controls.
- In scheduled and auto runs nobody can approve, so admin changes are refused there.
- The change carries its before-state. If the setting changed between the card and your Allow, Kobe
  changes nothing and the agent is told `changed_since_approval`; it should read again and ask
  for a new approval.
- Each person may make up to 60 admin reads a minute and 30 admin changes an hour (site defaults).

Read the summary and the before → after rows before you allow. Content the agent reads (a file, a
web page, a connector result, a teammate's message) can try to steer it into asking for a change
you did not intend: the card is where you catch that.

## Audit: "via agent"

Each change records the console's own audit event (for example a role change), with you as the
actor and **via agent** beneath, plus the run and tool call. The Team and Site audit views link
**open the thread** for viewers who may read that thread. The tool call itself is recorded as a
connector call as well.

## Shared threads hide admin results

A thread that used admin tools can still be shared. Teammates see that an admin tool ran and its
summary, but its result reads "Admin result hidden" unless they hold the same permission now. The
same applies to their forks of the thread. The owner always sees everything.

The redaction covers tool results only. The agent's own answers, and the summaries Kobe writes
when it compacts a long thread or a branch, may restate what a tool returned; those are not
hidden and are copied into a reader's fork. Before you share a thread where the agent read
sensitive settings, check what its answers say.

## Related

- [Team admin overview](team-admin.md)
- [Site admin overview](site-admin.md)
- [Approvals](../internet-and-approvals/approvals.md)
- [Connectors and apps](../connectors-and-apps.md)
- [Sharing, forks and the conversation tree](../chat/sharing-and-branches.md)
