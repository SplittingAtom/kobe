---
title: Getting started
summary: How to sign in to Kobe, pick a workspace and have your first conversation with an agent.
section: Getting started
order: 1
audience: member
---

Kobe is your organization's own place to work with AI agents. Each conversation runs an agent in a
private, isolated sandbox that can read and write your files, run code, use the tools your team
connects, and ask you before it does anything that needs your say-so. This page gets you from the
sign-in screen to your first answer.

## Sign in

Open your organization's Kobe address and use one of the options on **Sign in to Kobe** (your site
may show its own name instead of Kobe):

- **Sign in with _your organization_** (for example "Sign in with Contoso"), if your site uses
  single sign-on: you sign in on your organization's page and come back signed in. See
  [Signing in with your organization](getting-started/single-sign-on.md), also for linking it to
  an account you already have;
- **Sign in with a passkey**, if you have saved one, or
- your **Email** and **Password**, then **Sign in**.

If your account has two-factor sign-in turned on, Kobe then asks for your **Authenticator code**
(six digits) and **Verify**. Forgot your password? Use **Forgot your password?** on the sign-in
page and follow the link Kobe emails you.

There is no open sign-up. You join through an invitation, or through your organization's sign-in
when your organization has given you access to Kobe. With an invitation: the link in the invitation email opens
**Join Kobe**, where you choose a password and press **Create account**. If the page says
**Invitation not valid**, ask whoever invited you to send a new one.

## Pick your workspace

A **workspace** is where a team works: its people, conversations, projects, agents and settings.
Most people belong to one. If you belong to several, the **Workspace** switcher at the top of the
rail shows the current one with your role (for example "Member"); open it and pick another from
**Your workspaces**. Only one workspace is active at a time, and everything you see (threads,
files, agents, memory) belongs to it. If Kobe says "You are not in any team yet", ask an admin to
add you. See [Workspaces, My files and projects](files/workspaces-and-projects.md).

## Have your first conversation

1. Press **New conversation** at the top of the rail (or Ctrl+Shift+O, Cmd+Shift+O on a Mac).
2. Type what you want in the message box at the bottom and press **Enter**. Shift+Enter adds a new
   line.
3. The agent answers as it works. Tool calls (reading a file, running a command, calling a
   connector) appear as cards in the answer; open one to see what it did.
4. If the agent needs your permission, an approval card ("Approval needed to run …") appears
   with **Allow** and **Deny**. See [Approvals](internet-and-approvals/approvals.md).
5. Press **Stop** (Ctrl+. or Cmd+.) to stop a run at any time.

The first message of the day can take a little longer: Kobe wakes your sandbox, which sleeps when
you are away. Your files are kept while it sleeps.

## Good first things to try

- Attach a spreadsheet with **+** → **Attach files** and ask for a summary and a chart.
- Ask the agent to write a short note to a file in **My files**, then open it from the Files panel.
- Pick another model or thinking level in the composer's toolbar. See [Models](models.md).
- Press Ctrl+K (Cmd+K) to search actions, threads and files.

## Where to go next

- [The Kobe screen](getting-started/layout.md): the rail, the conversation and the artifact column.
- [Writing messages](chat/composer.md): slash commands, attachments and mentions.
- [The Threads panel](chat/threads-panel.md): finding, filing and exporting conversations.
- [Glossary](glossary.md): the words Kobe uses.
