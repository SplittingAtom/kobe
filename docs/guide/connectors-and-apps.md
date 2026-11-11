---
title: Connectors and apps
summary: How MCP connectors give the agent tools, how to add your own key for a connector, turn connectors on or off per conversation, and use app cards in answers.
section: Connectors and apps
order: 1
audience: member
---

Connectors link Kobe to other systems (a ticket tracker, a data platform, an internal API) through
the Model Context Protocol (MCP). Each connector gives the agent a set of tools. Some connectors
also bring apps: small interactive views that appear in the conversation. This page explains how to
use both.

## Where connectors come from

A site admin registers a connector in the **Connector registry**. Team admins then enable it for
the team in the team console's **Connectors** page and choose which of its tools the team may use:
**Read-only tools**, **All tools** or **Chosen tools**. You see the connectors your team enables.

The agent never holds the connector's credentials. Its calls go through Kobe's MCP proxy, which
adds the credential on the way out, checks the call against your team's rules and records it.

## Add your own key

Some connectors act as you, with your own account. Open **Profile → My connectors** (**My
connector keys**, `/me/connectors`):

- A connector that needs your key shows **No key added**; press **Add key**, paste your **API
  key** and save. Kobe stores it encrypted, uses it only for your runs and never shows it again.
- **Replace key** and **Remove key** change or delete it.
- "Provided by your organization: you need no key of your own." means a site-wide key is used.

Until you add a key, your runs cannot use that connector ("Your runs can't use it until you add
one."). An app that is missing only your key shows **Add your key**, linking to this page.

## Turn connectors on or off for a conversation

In the composer, **+** → **Connectors** lists your connectors in this workspace. Each working one
has a checkbox for this conversation only (on by default). In a conversation not started yet, the
choice applies once you send the first message. A connector that is not working shows a red cross
and the reason, with a link to fix it where there is one.

## Connector tool calls and approvals

Connector tools are marked by the system that provides them as reading or changing data. By
default Kobe asks you before a connector tool that changes something runs; read-only tools run
without asking. Your team's rules can ask more often, and a tool whose definition changed since a
site admin approved it is turned off until it is approved again. See
[Approvals](internet-and-approvals/approvals.md).

## Apps in answers

Some connector tools return an app: an interactive card (a table explorer, a picker, a chart)
rendered right in the answer. Apps run in a locked-down frame and can only talk to Kobe, which
checks every call they make like any other tool call.

- **Show response.** When an answer includes an app, Kobe shows only the app card. Everything else
  in that answer (the text, reasoning steps, other tool cards, the "Used skill" line) is behind a
  collapsed **Show response** toggle under the card; open it to read it in its original order.
  Approval cards, problems and blocked-site cards are never hidden. **Copy** still copies the
  answer's text.
- **Launch an app yourself** from the composer's **+** menu; the card says "You opened _app_ from
  _connector_".
- **Where it opens.** A site admin decides whether an app opens in the conversation, in the
  artifact column ("Opened in the side column", with **Show app**) or in the rail's **Apps** tab
  as a picker. A picker in the rail fills in your message draft but never sends it for you.

## Related

- [Approvals](internet-and-approvals/approvals.md)
- [Team admin overview](admin/team-admin.md)
