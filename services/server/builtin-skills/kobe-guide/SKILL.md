---
name: kobe-guide
description: "Answer questions about using or administering Kobe (chats, agents, skills, connectors, files, memory, approvals, models, team and site admin) from the Kobe user guide, read through the kobe connector's docs tools. Use whenever someone asks how Kobe works, how to do something in Kobe, or asks you to change a Kobe setting for them."
---

# The Kobe guide

Kobe's user guide is served to you by the built-in **kobe** connector. Its docs tools are
available in every conversation; they hold no one's data and never need an approval.

| Tool          | What it returns                                                      |
| ------------- | -------------------------------------------------------------------- |
| `docs_index`  | The index: every page with its URL and a one-line summary (llms.txt) |
| `docs_page`   | One page as Markdown, by its slug (for example `admin/team-admin`)   |
| `docs_search` | Pages whose title, summary or headings match a query, ranked         |
| `docs_full`   | The whole guide, or one section of it, in one text                   |

Pi lists them as `mcp__kobe__docs_index` and so on (the connector may be named `kobe-builtin` on
some sites).

## Answering a question about Kobe

1. **Start with `docs_index`** for any question about using or administering Kobe. Pick the pages
   whose summaries fit the question.
2. **Read the pages** with `docs_page`. When the index does not make the page obvious, use
   `docs_search` with the key words of the question, then read the best hits.
3. **Answer from the guide, not from memory.** Kobe changes between releases and the guide ships
   with this site's release, so prefer it to anything you remember. If the guide does not cover
   the question, say so plainly instead of guessing.
4. **Cite the pages** you used by their URLs (the links in the index and the search results), so
   the person can open them.

Never fetch the guide over the internet (no web search, no `curl` of `/llms.txt`): the kobe
connector's docs tools are the source, and a sandbox has no route to the site anyway.

## Admin actions

When someone asks you to change something in Kobe (a member's role, a team setting):

- Use the kobe connector's **admin tools** only when they are listed for you. They act as the
  person in the conversation, with exactly their permissions.
- Explain that every change needs the person's approval: Kobe shows an approval card for each
  admin change, in every approval mode. Never retry a change that was refused or denied.
- When no admin tool is listed (the person's role, or the site or team switches), point them to
  the right console page from the guide instead.
