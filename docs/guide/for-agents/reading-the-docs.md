---
title: How AI agents should read these docs
summary: How an AI agent reads Kobe's documentation, through the kobe connector's docs tools inside a sandbox or as llms.txt, llms-full.txt and one Markdown file per page outside Kobe.
section: For agents
order: 1
audience: agent
---

This page is for AI agents and the tools that feed them: agents running inside a Kobe sandbox,
assistants answering questions about Kobe from outside, and crawlers building a knowledge base.
The same guide people read in Kobe's docs viewer is served as plain Markdown so you can read it
without parsing HTML.

## Inside a Kobe sandbox: the kobe connector's docs tools

Every agent in Kobe has the built-in **kobe** connector with four docs tools, whatever connectors
the agent itself lists. They hold no one's data, never ask for approval and work in every run,
scheduled runs included. Pi names them `mcp__kobe__<tool>` (on some sites the connector is
called `kobe-builtin`).

| Tool          | What it returns                                                                       |
| ------------- | ------------------------------------------------------------------------------------- |
| `docs_index`  | The index, exactly as `/llms.txt` below.                                              |
| `docs_page`   | One page as Markdown, by its slug (for example `memory` or `admin/team-admin`).       |
| `docs_search` | Pages whose titles, summaries or headings match a query, ranked, with slugs and URLs. |
| `docs_full`   | Every page in one text, as `/llms-full.txt`, or only one section's pages.             |

The **kobe-guide** skill, which Kobe installs in every team, says how to use them: for any
question about using or administering Kobe, start with `docs_index`, read the pages that fit with
`docs_page` (or find them with `docs_search`), answer from the guide rather than from memory, and
cite the pages' URLs. Do not fetch the docs over the internet from a sandbox: the docs tools are
the source and need no internet access.

When someone asks you to change something in Kobe, use the kobe connector's admin tools only if
they are listed for you. They act as that person, with their permissions, and every change shows
them an approval card first.

## Outside Kobe: llms.txt and Markdown pages

All paths are on the same address as the Kobe site itself.

| Path              | What it is                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/llms.txt`       | The index, in the llms.txt format: one line per page with its title, link and one-sentence summary, grouped by section.         |
| `/llms-full.txt`  | Every page's full text in one file, in section order.                                                                           |
| `/docs/<slug>.md` | One page as Markdown. The slug is the page's path, for example `/docs/memory.md` or `/docs/for-agents/working-in-a-sandbox.md`. |
| `/docs/<slug>`    | The same page for people, in the Docs panel over the conversation.                                                              |

## How to use them

1. **Start with the index** (`docs_index`, or `/llms.txt`). Each line's summary says what question
   the page answers. Pick the pages that match the user's question.
2. **Read only what you need**, one page at a time (`docs_page`, or `/docs/<slug>.md`). Prefer this
   over the full text when your context is limited.
3. **Use the full text** (`docs_full`, or `/llms-full.txt`) when you need the whole picture at
   once, for example to answer many questions in a row.
4. **Follow the links.** Links between pages are absolute links to the pages' `.md` files; with
   the docs tools, pass the part after `/docs/` to `docs_page`.

Each page starts with its title as a heading and its one-sentence summary as a quote. Pages for
admins describe settings only team or site admins can change: when you answer a member, say that
an admin has to do it rather than telling them to do it.

## What the docs cover and what they do not

The guide describes what Kobe does for its users: conversations, files, projects, agents, skills,
connectors, memory, internet access, approvals, models and administration. It does not describe a
particular organization's setup: which models, connectors, websites or skills your site enables,
its budgets or its policy rules. Those differ per site and per team. When a question depends on
them, say so and suggest the user checks with their team admin, or look at what your own tools and
context show you.

If something on screen contradicts the docs, trust the screen and say the docs may be out of date.

## If you are running inside a Kobe sandbox

Read [Working inside a Kobe sandbox](working-in-a-sandbox.md) first: it says what your tools can
and cannot do and how to ask the user for access. [Concepts for agents](concepts.md) maps Kobe's
words to your tools and paths.
