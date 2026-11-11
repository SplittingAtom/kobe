# KOBE-617: Member and agent guide (docs/guide)

- **Status:** ready for review (agent done; not pushed)
- **Branch / worktree:** `kobe-617-docs-guide` in `../Kobe-wt617` (from main `a9a1060c`, KOBE-614 merged)
- **Depends on:** KOBE-616 (viewer at `/docs`, `/llms.txt`, `/llms-full.txt`, `/docs/<slug>.md`),
  which builds from these files; KOBE-615 (PR #525, file editor toolbar) is described here already.

## Plan

Chris's request (2026-11-11): user- and agent-facing docs for Kobe, shown in the app behind a docs
icon and served to agents as llms.txt. This ticket writes the content in `docs/guide/` to the
shared page contract (front matter `title`, `summary`, `section`, `order`, `audience`; relative
`.md` links; no H1 in the body).

## Pages (25)

| Section                       | Pages                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Getting started               | `getting-started`, `getting-started/layout`                                                                             |
| Chat and threads              | `chat/composer`, `chat/threads-panel`, `chat/sharing-and-branches`                                                      |
| Files and editing             | `files/workspaces-and-projects`, `files/file-editor`, `files/notebooks`                                                 |
| Agents and skills             | `agents/agents`, `agents/skills`                                                                                        |
| Connectors and apps           | `connectors-and-apps`                                                                                                   |
| Memory                        | `memory`                                                                                                                |
| Internet access and approvals | `internet-and-approvals/internet-access`, `internet-and-approvals/approvals`                                            |
| Models                        | `models`                                                                                                                |
| Appearance                    | `appearance`                                                                                                            |
| Team admin                    | `admin/team-admin`                                                                                                      |
| Site admin                    | `admin/site-admin`                                                                                                      |
| Reference                     | `reference/keyboard-shortcuts`, `reference/troubleshooting`, `glossary`                                                 |
| For agents                    | `for-agents/reading-the-docs`, `for-agents/concepts`, `for-agents/working-in-a-sandbox`, `for-agents/asking-for-access` |

## Decisions

- **Old docs keep their engineering content.** `docs/threads-panel.md` (member-only) is now a
  pointer. `docs/file-editing.md` (Practical guidance), `docs/agents.md` (Creating) had their
  member sections replaced by pointers; `file-editing.md`, `agents.md`, `theming.md`,
  `approvals.md` and `answer-feedback.md` got a one-line pointer under the title. PR #525 also
  edits `file-editing.md` (other hunks): expect a trivial merge.
- **Words follow the UI**: Workspace, My files (scratchspace as the concept), Team console /
  Workspace settings, Contributor, Allow/Deny, Request access. Admin-only settings are on the two
  admin pages and flagged where member pages mention them.
- **Semantic memory** is described as planned, not shipped (`recall` is text matching only).
- **No member light/dark preference page** exists: the guide describes the bar's Dark theme toggle
  (per browser cookie, follows the OS until used); styles are site-wide (TH1).
- **Agent pages** state limits as the code has them (tool names from `packages/protocol/src/tools.ts`
  and kobe-tools; egress 403 text from `services/egress-proxy`), and tell the agent to defer to its
  own tool list and system prompt for site-specific settings.
- `for-agents/working-in-a-sandbox` is ~1,050 words (the tools table); the access part was split
  into `for-agents/asking-for-access` to stay near the length target.

## Open questions (for Chris or the coordinator)

- KOBE-616 decides whether `/llms.txt` and `/docs/<slug>.md` need a session; `reading-the-docs`
  says only "on the same address as the Kobe site" and that a sandbox reaches it only if egress
  allows the site's host. Adjust if 616 serves them differently.
- Not checked in a browser: labels come from source (`apps/web`), not a running gate1.
- PR #525 labels (Save As, Rendered/Raw switch, Proposed edit bubble, Run/Interrupt/Start/Restart,
  split output) are taken from its branch; correct if review changes them.

## Evidence (acceptance criteria → test or command output)

- ac-1/ac-2: the page table above; links checked by a script (every relative `.md` link resolves,
  every page has the five front-matter keys).
- ac-3: labels and routes from `apps/web/lib/shell/commands.ts`, `shortcuts.ts`, `app/**/page.tsx`,
  `lib/admin/nav/{team,site}/*.ts`, component strings; behaviour from `docs/specs/*` decisions
  (workspaces, projects-in-conversations, conversation-tree, thread-lineage-and-folders,
  thread-file-map, file-editor FE14-FE17, notebooks, egress-access, mcp-apps-host MA amendment).
- ac-4: pointers listed under Decisions.
- ac-5: pages 316-1,065 words; `pnpm run format:check`, `scripts/check-public-hygiene.sh` and
  `scripts/check-site-wording.mjs` pass.
