---
title: How AI agents should read these docs
summary: Where an AI agent finds Kobe's documentation in machine-readable form (llms.txt, llms-full.txt and one Markdown file per page) and how to use it.
section: For agents
order: 1
audience: agent
---

This page is for AI agents and the tools that feed them: assistants answering questions about
Kobe, agents running inside a Kobe sandbox, and crawlers building a knowledge base. The same guide
people read in Kobe's docs viewer is served as plain Markdown so you can read it without parsing
HTML.

## Where to find the docs

All paths are on the same address as the Kobe site itself.

| Path              | What it is                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/llms.txt`       | The index, in the llms.txt format: one line per page with its title, link and one-sentence summary, grouped by section.         |
| `/llms-full.txt`  | Every page's full text in one file, in section order.                                                                           |
| `/docs/<slug>.md` | One page as Markdown. The slug is the page's path, for example `/docs/memory.md` or `/docs/for-agents/working-in-a-sandbox.md`. |
| `/docs/<slug>`    | The same page in the docs viewer, for people.                                                                                   |

## How to use them

1. **Start with `/llms.txt`.** Each line's summary says what question the page answers. Pick the
   pages that match the user's question.
2. **Fetch only what you need** from `/docs/<slug>.md`. Prefer this over `/llms-full.txt` when your
   context is limited.
3. **Use `/llms-full.txt`** when you need the whole picture at once, for example to build an
   index or answer many questions in a row.
4. **Follow relative links.** Links between pages are relative Markdown links to `.md` files;
   resolve them against the current page's path.

Each page starts with YAML front matter: `title`, `summary`, `section`, `order` and `audience`
(`member`, `admin` or `agent`). Pages for `admin` describe settings only team or site admins can
change: when you answer a member, say that an admin has to do it rather than telling them to do it.

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

Your sandbox reaches the internet only through Kobe's egress proxy, so fetching these docs from
inside it works only if your team has enabled the Kobe site's own host. If the fetch is blocked,
do not retry in a loop: tell the user, and answer from what you know or ask them to paste the
page.
