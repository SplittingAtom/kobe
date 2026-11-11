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

## Account

**I forgot my password.** Use **Forgot your password?** on the sign-in page.

**I see the wrong workspace's threads.** Switch with the **Workspace** switcher at the top of the
rail.

## Related

- [Glossary](../glossary.md)
- [Getting started](../getting-started.md)
