---
title: Approvals
summary: When Kobe asks before a tool call runs, how to allow or deny it, how remembered approvals work and where to revoke them.
section: Internet access and approvals
order: 2
audience: member
---

Kobe's server decides every tool call the agent makes. Some calls run at once, some are refused,
and some wait for you to say yes. This page explains the approval card, remembering an approval,
and how to take one back.

## When Kobe asks

Whether a call asks depends on the agent's approval mode and your team's rules:

- **Ask on write** (the usual mode): Kobe asks before the agent changes something outside its
  sandbox, such as a connector tool that writes, project memory, or a commit to a project. Work
  inside the sandbox (files in My files, shell commands, Python) runs without asking unless your
  team added a rule that asks.
- **Ask for every tool**: every call asks.
- **Auto (allow-listed tools only)**: nothing asks; a call that would ask is refused instead.
- Team and site **ask rules** make particular tools always ask, and **deny rules** refuse them.

Scheduled runs never ask either: a call that would need approval is skipped and reported on the
run.

## The approval card

The card reads "Approval needed to run _tool_" with a badge: **Reads data**, **Changes data** or
**Can delete or overwrite**. It shows "Exactly this input runs if you allow it:" with the input.
Press **Allow** or **Deny**. Only you, the conversation's owner, can decide; people you shared the
thread with cannot.

- Kobe signs the exact input you allowed, so only that call runs, once.
- An approval waits up to one hour, then expires and the run stops.
- Stopping the run expires its waiting approvals.
- After deciding, the card says "Denied. The tool did not run." or shows the result.

When several calls of one run wait, **Approve all waiting (N)** allows them together after a
confirmation (**Allow all N**). It is not offered when any of them could delete or overwrite,
writes project memory or commits to a project, or when your team turned it off.

## Remember an approval

Tick **Remember: allow _tool_** before pressing Allow, and pick how long under **Remember for**:
**this conversation**, **until end of today**, **this run only**, **for 1 day**, **for 30 days** or
**until revoked**. For file tools, **Only this path** limits it to that one file; for other tools it
can be limited to exactly this input. Your team may offer fewer choices.

A remembered approval:

- applies only to you, in this workspace, and only in conversations where you are present (never in
  scheduled or auto runs);
- never overrides a team or site deny or ask rule;
- cannot be made for tools that can delete or overwrite;
- for "this conversation" ends for good when the thread is archived, deleted or moved to another
  project.

A tool card allowed by one says "Allowed by your rule (_scope_)".

## Revoke a remembered approval

Open **Profile → My approvals** (`/me/approvals`). **Remembered approvals** lists yours in this
workspace; remove any of them, effective from the next call. Rules that no longer apply (for
example after your team tightened its limits) are marked "No longer applies" with the reason. The
page also sets your **Time zone**, used for "until end of today". Team admins can see and revoke
members' rules on the team console's **Policy** page; they see the tool and scope, not the content
of your private conversations.

## The file you are viewing

When you send a message with a file open, the agent cannot overwrite that file with its file tools
in any mode: it proposes the change for your review instead. See
[Editing files](../files/file-editor.md).

## Related

- [Internet access](internet-access.md)
- [Agents](../agents/agents.md): approval modes and Dangerous mode
