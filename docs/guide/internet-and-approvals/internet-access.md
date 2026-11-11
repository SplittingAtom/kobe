---
title: Internet access
summary: How the agent reaches the internet through Kobe's egress proxy, what the blocked-site card means, and how to request access to a website.
section: Internet access and approvals
order: 1
audience: member
---

The agent's sandbox has no direct internet connection. Every web request goes through Kobe's
egress proxy, which lets through only the websites your team has enabled. When the agent tries to
reach anything else, the request is blocked and you can ask for access from the conversation.

## How it works

Two lists decide which sites the agent can reach:

- The **egress ceiling**, kept by site admins: every site any team may use.
- Your **team's enabled domains**, kept by team admins: the sites from the ceiling your team
  actually uses.

A site is reachable only when it is on both. Patterns are either an exact host (`example.com`
matches only that host) or a wildcard (`*.example.com` matches its subdomains). Only HTTPS is
allowed, and addresses inside the organization's network are blocked unless a site admin has
marked a domain as internal.

Connector tools do not use this list: they go through the MCP proxy (see
[Connectors and apps](../connectors-and-apps.md)). Model calls do not use it either.

## When a site is blocked

The conversation shows a card: "Internet access to _domain_ was blocked by your team's egress …",
followed by who can allow it: "Your team admins can allow it." or "The site admins can allow it."
The agent also gets an error saying the domain is not enabled, so it can tell you and stop or try
another way. You can close the card with its close button.

## Request access

Press **Request access** on the card. Kobe notifies the right people ("Access requested: … were
notified. Kobe tells you when they decide."):

- If the site is already in the ceiling, your **team admins** decide.
- If it is not, the **site admins** decide; approving adds it to the ceiling and enables it for your
  team in one step.

You are told when they decide. Once approved, ask the agent to try again. You can have one pending
request per site.

## For admins: decide from the card

Team admins and site admins see the same card with **Allow** choices: the exact host (the default)
or a wildcard of its parent domain (`*.parent`), never broader. Site admins also get **Internal
(same cluster)** for a site served inside the organization's own cluster. Then **Approve** or
**Deny**. A team admin can approve only sites already in the ceiling; both can deny. Requests also
appear in the team console's **Egress** page (**Access requests**) and the site console's **Egress
ceiling** page.

## Tips

- Installing Python or npm packages needs the package index (for example `pypi.org` and
  `files.pythonhosted.org`) to be enabled.
- If a site works in your browser but not for the agent, it is almost always the egress list.
- A skill that lists hosts in its `kobe.skill.yaml` does not get access by doing so.

## Related

- [Approvals](approvals.md)
- [Team admin overview](../admin/team-admin.md)
