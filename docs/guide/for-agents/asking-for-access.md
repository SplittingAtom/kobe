---
title: Asking the user for access
summary: How an AI agent in a Kobe sandbox reaches the internet and connectors, what a blocked request looks like, and exactly what to tell the user when it needs access it does not have.
section: For agents
order: 4
audience: agent
---

Some things an agent in a Kobe sandbox cannot do on its own: reach a website the team has not
enabled, use a connector without the user's key, or change a project the user cannot edit. The
user or an admin can fix each of these. This page explains how the internet and connectors work
from inside the sandbox and what to tell the user, in words that match the Kobe interface.

## Internet

All HTTP and HTTPS traffic goes through Kobe's egress proxy (`HTTPS_PROXY` is set for shell
commands). Only HTTPS, only domains the team enabled, no IP addresses. A blocked request returns
HTTP 403 with a message such as `Kobe egress: <host> is not enabled for this team`. The user then
sees a blocked-site card with **Request access**. Do not retry or try other hosts to get around it.

Package installs (`pip install`, `npm install`) use the same proxy, so they need the package
index's hosts (for example `pypi.org` and `files.pythonhosted.org`) to be enabled. Model calls do
not go through your sandbox at all.

## Connectors

Connector tools are named `mcp__<server>__<tool>`, where `<server>` is the connector's name with
characters other than letters, digits and `_` replaced by `_`. They go through Kobe's MCP proxy,
which adds the credentials; you never see them. Tools marked read-only usually run at once; tools
that change data usually ask the user. A tool whose definition changed since a site admin approved
it is turned off. If a call fails because the user has no key, tell them to add it in **Profile →
My connectors**. The user may also have switched a connector off for this conversation (**+** →
**Connectors**).

## What to tell the user

When you need something you do not have, stop, say exactly what and why, and tell the user how to
get it. Use these labels; they match the interface.

| You need                            | Tell the user                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A blocked website                   | "Press **Request access** on the blocked-site card; your team admins (or site admins) decide." Name the host. |
| A tool call they denied             | Explain what it would have done; ask whether to try another way.                                              |
| To change project files             | They need to be an editor or owner and use **Check out to edit**, or accept your proposal.                    |
| A connector key                     | "Add your key in **Profile → My connectors**."                                                                |
| A connector or model the team lacks | "A team admin can enable it in the Team console."                                                             |
| Unattended runs to use a tool       | "A team admin can add a team allow rule."                                                                     |
| Memory                              | "A team admin can turn memory on in the Team console's **Memory** page."                                      |

Never ask the user to disable a safety setting for you, to paste credentials, or to approve
something you have not explained.

## Related

- [Working inside a Kobe sandbox](working-in-a-sandbox.md)
- [Internet access](../internet-and-approvals/internet-access.md)
