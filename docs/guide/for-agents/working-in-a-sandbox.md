---
title: Working inside a Kobe sandbox
summary: What an AI agent running in a Kobe sandbox can and cannot do, which tools it has, how the server decides every call, and the rules for files, projects and memory.
section: For agents
order: 3
audience: agent
---

You are an AI agent running inside a Kobe sandbox on behalf of one user. This page tells you what
your environment is, which tools you have, what the server enforces, and what to do when you need
something you do not have. Follow it as operating instructions. Where your own system prompt or
tool list is more specific, that wins: it reflects this site's and this team's actual settings.

## Your environment

- You run in an isolated sandbox (gVisor or Kata) that belongs to one user in one workspace. It
  accepts no inbound connections and holds no secrets: no API keys, no connector credentials, no
  cloud credentials. Do not look for them and do not ask the user to paste any.
- The user's files are at `/workspace` (shown to them as **My files**). Treat it as theirs: do not
  delete or reorganise files they did not ask you to touch.
- Python 3.12 (pandas, NumPy, DuckDB, PyArrow, Matplotlib, openpyxl, python-docx, ReportLab, pypdf)
  and Node 22 with npm are installed.
- The sandbox may sleep between messages. Running processes, the Python kernel and anything outside
  `/workspace` may be gone next time; files in `/workspace` are kept.

## Every tool call is decided by the server

Before any tool runs, Kobe's server checks it against the site's and team's deny, ask and allow
rules, your agent's tool lists and the run's approval mode. The result is one of:

- **Allowed**: the call runs.
- **Held for approval**: the call waits while the user sees an approval card with the exact input.
  You see nothing until they decide. If they allow it, exactly that input runs, once; if you change
  the input you need a new approval.
- **Denied**: you get an error result starting `policy.denied:` with a reason. Do not retry the same
  call. Tell the user what you could not do and why, and suggest the fix (below) or another way.

In scheduled and auto runs nobody can approve: calls that would ask are denied. There is no way
around a denial, and you must not try (for example by doing the same thing through `bash` or
`run_python`).

## Your tools

Which of these you have depends on your agent and the team's settings; your tool list is the
truth.

| Tool                                      | Use it to                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read`, `ls`, `find`, `grep`              | Read files under `/workspace`.                                                                                                                                           |
| `write`, `edit`                           | Create or change files in My files or in a checked-out project.                                                                                                          |
| `bash`                                    | Run shell commands. Treated as able to delete or overwrite; may ask.                                                                                                     |
| `run_python`                              | Run Python in this thread's live kernel (code, a `.py` file, or a notebook cell). State is shared with the user's notebook runs. Matplotlib plots are shown to the user. |
| `propose_file_edit`                       | Offer a whole new version of a file for the user to review and commit. Writes nothing.                                                                                   |
| `open_file`                               | Open a file in the user's artifact column when they ask to see, open or view it.                                                                                         |
| `create_artifact`, `update_artifact`      | Make content the user keeps (html, svg, markdown, mermaid, code, csv; up to 512 KiB). A code artifact is shown, not run.                                                 |
| `share_file`                              | Offer a file for download, only when the user wants to download it.                                                                                                      |
| `commit_project`                          | Commit a checked-out project's changes with a one-line message. Offered only to editors and owners; usually needs approval.                                              |
| `remember`, `recall`                      | Write and read memory (below).                                                                                                                                           |
| `save_skill_draft`                        | Save a skill folder under `/workspace/skills/<name>/` as a private Workbench draft.                                                                                      |
| `mcp__<server>__<tool>`                   | Call a connector's tool.                                                                                                                                                 |
| `list_mcp_resources`, `read_mcp_resource` | Read a connector's resources.                                                                                                                                            |
| `tool_search`                             | Find a tool by description.                                                                                                                                              |

Questions about Kobe itself: read the Kobe guide with the kobe connector's docs tools
(`docs_index`, `docs_page`, `docs_search`, `docs_full`), which every agent has and which need no
internet access; see [The kobe connector](#the-kobe-connector) below and
[How AI agents should read these docs](reading-the-docs.md).

You have no built-in web search or URL-reading tool. To fetch from the web, use `bash` (for example
`curl`) or Python through the egress proxy, which is already configured.

## The kobe connector

The built-in **kobe** connector is Kobe's own MCP server, reached through the MCP proxy like any
other connector (no internet access, no key). Its tools are named `mcp__kobe__<tool>`
(`mcp__kobe_builtin__<tool>` on a site where the name `kobe` was taken).

- **Docs tools** (`docs_index`, `docs_page`, `docs_search`, `docs_full`) are always available,
  whatever your agent's connector list, in every run including scheduled ones. Use them for any
  question about using or administering Kobe; the **kobe-guide** skill says how.
- **Admin tools** (`team_<area>_<verb>`, `site_<area>_<verb>`) do Team console and Site console
  work. Use them only when they are in your tool list: they are listed only when the site and the
  team turned them on, your agent uses the kobe connector, and the user's role allows them. Never
  imitate one with `bash`, `curl` or the API. They act **as the user**, with exactly the user's
  permissions.
- **Reads** run without asking. Results are paged: pass `next_cursor` back for the next page.
- **Every write asks the user**, in every approval mode, with an "Admin change" card; it is never
  remembered. In scheduled and auto runs writes are refused. Read the current value first and pass
  the before-state in the input exactly as you read it (for example `from_role`, `change.from`):
  it is part of what the user approves.
- **Errors.** `policy.denied:` with `kobe_admin_not_allowed` (the user may not use that tool now),
  `kobe_admin_write` in an unattended run, or `kobe_admin_rate_limited` (60 reads a minute, 30
  writes an hour per person): do not retry; tell the user. `changed_since_approval`: the setting
  changed after the user approved, nothing was changed; read it again and, if the user still wants
  it, call again for a new approval. `not_a_member`: the person you named is not in this team.
  `Kobe refused: …`: the console's own refusal (for example the last team admin cannot be
  demoted); explain it, do not work around it.
- Some actions have no tool (break-glass, ownership transfer, site roles, legal hold, retention,
  deletions, registering connectors, injected headers, the Kobe switches themselves). Explain them
  from the guide and point the user to the console page.

## Files and projects

- **The viewed file.** If your system prompt has "The file the user is looking at", change that
  file only with `propose_file_edit`, sending the complete new content and a one-line summary.
  `write` and `edit` on it are denied (or, where you cannot propose, held for the user). Proposals are limited to 128 KiB of text.
- **Other files** in My files: write them directly, then call `open_file` if the user should see
  the result.
- **Projects** are under `/workspace/projects/<slug>/` and read-only unless the user checked the
  project out. In a project conversation where the user is an editor or owner,
  `propose_file_edit` also works for that project's files (accepting commits it). Other projects
  and `/workspace/uploads/` are always read-only. If a write fails with a read-only error, do not
  work around it; tell the user (see below).
- **Commits.** After editing a checked-out project, call `commit_project` once the files are in a
  good state. It may wait for approval or be refused in unattended runs.
- **Conflicts.** If your system prompt lists workspace sync conflicts, a file you wrote was also
  changed by the user; their version kept the name and yours is beside it as
  `<name>.conflict-<time><ext>`. Tell the user.

## Memory

- `remember {scope, path, content, mode}` writes a Markdown file in `user` memory (saved at once;
  the user can undo) or `project` memory (held until a project member approves). Paths are one to
  four segments, such as `MEMORY.md` or `topics/clients.md`. Keep `MEMORY.md` a short index.
- `recall` lists files, reads one, or searches by text (not by meaning).
- Save durable facts and preferences the user would want next time, not conversation details.
- Never store secrets, passwords or tokens in memory.
- If the tools are missing, memory is switched off for this team or site; do not simulate it with
  files.

## When you need access

Internet access, connector keys, project rights and blocked calls each have a way for the user to
fix them. See [Asking the user for access](asking-for-access.md) before you tell the user anything
is impossible.

## Related

- [Asking the user for access](asking-for-access.md)
- [Concepts for agents](concepts.md)
- [How AI agents should read these docs](reading-the-docs.md)
- [Approvals](../internet-and-approvals/approvals.md)
