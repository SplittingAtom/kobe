---
title: Sharing, forks and the conversation tree
summary: How to share a thread with your project or team, fork it into a new thread, and move between versions and branches with the conversation tree.
section: Chat and threads
order: 3
audience: member
---

A thread is private to you until you share it. Inside a thread, every edit or regenerate starts a
new branch, and the conversation tree shows them all. A fork copies a thread up to a point into a
new thread of your own. This page explains all three.

## Share a thread

Choose **Share** in the thread's **⋯** menu in the Threads panel (or type `/share` in the
thread, or search for Share with Ctrl+K):

- **Only you**: private again.
- **Project members**: shown only when the thread is in a project. Everyone who can read the
  project can read the thread.
- **Everyone in the team**: every member of the workspace can read it.

Only the owner changes sharing. People you share with read the thread, including every branch, and
can fork it; they cannot write in it, approve its tool calls or see what its model was sent. They
see "This conversation is shared with you read-only." Files from your own My files are never named
to them (see [The Threads panel](threads-panel.md)).

If the agent used Kobe's admin tools in the thread, readers see that the tool ran and its summary,
but its result reads "Admin result hidden" unless they hold the same permission, in their forks
too. The agent's own answers are not hidden, so check what they say before sharing. See
[Admin from a conversation](../admin/admin-from-a-conversation.md).

## Fork a thread

**Fork to a new thread** on a message (or `/fork`) asks for a title, then **Fork** copies the
conversation up to that point into a new thread of yours, in the same project. Use it to try a
different direction without touching the original, or to continue a thread someone shared with
you. A fork of someone else's shared thread is private to you.

A fork shows a lineage strip at the top of the conversation: the original thread first, then each
fork down to the one on screen, every row a link. Where a thread has several forks you may open,
the row is a dropdown; a thread with forks of its own gets a **Forks** dropdown. Threads you cannot
open are not listed.

## Versions and branches

**Edit** on one of your messages, **Regenerate**, **Regenerate with…** and **Retry** each start a
new version at that point instead of overwriting. Arrows at the branch point ("Previous version",
"Next version", "Version 2 of 3") switch between them. **Continue from here** on any answer makes
your next message branch from that answer. **Compare versions** shows two answers to the same
prompt side by side.

## The conversation tree

Open it with the **Conversation tree** button in the conversation header, the "Forked here · N
branches" note, or the `/tree` address. It draws one row per turn with every branch visible, the
branch on screen highlighted and the current end (the leaf) marked. Badges show what a branch left
behind, such as files, memories or approval rules. Filter the tree with **Filter the tree**; move
with the arrow keys, Home and End.

Clicking a node shows that branch in the conversation without changing the thread: you are only
looking. A node's menu offers, where they apply:

- **Show in conversation** and **Make it current** (your next message continues there);
- **Make it current and carry a summary**: the agent summarises the branch you leave, and the
  summary goes into the new branch's context (you can give it a one-line focus);
- **Continue from here**, **Edit this message**, **Retry**;
- **Label…** and **Remove label**: names for points in the tree, which only people see, never the
  model;
- **Compare with…**, **Fork a new thread here** and **Copy text**.

Making a branch current warns when files changed on the branch you leave stay changed: files are
not rolled back. If a branch is longer than the model's window, Kobe says so; compact after
switching. Readers of a shared thread can browse every branch but cannot make one current, label
or summarise.

## Related

- [Writing messages](composer.md)
- [The Threads panel](threads-panel.md)
