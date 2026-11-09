# KOBE-588: PC-1 New conversation header and project control

- **Status:** in review (commits on branch, not pushed)
- **Branch / worktree:** `kobe-588-new-conversation-header` in `../Kobe-wt588`
- **Depends on:** none (web only)

## Plan

Spec `docs/specs/projects-in-conversations.md` §3 NC1-NC5. Web only.

## Decisions

- Draft project is observable: `ChatSession.subscribeDraftProject` plus `draftProjectIssue`
  (`lib/chat/session.ts`); hooks in `components/chat/use-draft-project.ts`.
- NC1: `ThreadTitle` reads "New conversation in <name>"; the name span truncates (16ch) with the
  full name in its tooltip. The name comes from `session.projects()` (non-archived list, no
  visibility filter), falling back to `GET /v1/projects/{id}` for one not in the list.
- NC2: `draft-project-control.tsx`: Radix Popover with native radios (arrows, Space), filter field
  above 8 projects, "Remove project" button when one is chosen. Command `draft-project`
  (palette: true); the binding's label is "Choose the project for this conversation" with the
  projects as choices (plus Remove project), so the palette runs it as a second step. The privacy
  sentence is the IconAction description (tooltip + accessible description). Only rendered in the
  chat shell on a draft (`threadId === null`).
- NC4: `onThreadIdChange` (opening another conversation) and the two New conversation buttons plus
  the `new-thread` command clear the draft project (`useEndDraftProject`): `onThreadIdChange` is
  silent when a draft is already on screen. A workspace switch builds a new `ChatSession`
  (memoised on team id), which starts without a project.
- NC5: a refused `createThread` gives the draft its project back (`refuseDraftProject`); 403/404/409
  say "You can no longer start conversations in <name>." and `too_many_mounts` shows the server
  message (which carries the limit). Both render a `role=alert` beside the control with a Remove
  project button that takes the focus. Other failures (5xx, network) set no issue.
- `DraftProjectNote` removed; `project-sharing.test.tsx` now expects the new heading.

## Open questions

- The mount limit is shown through the server's message; the web does not format `limit` itself.
- Radio list is not a roving menu: Tab leaves the group; arrows move within it.

## Evidence

- `components/chat/draft-project.test.tsx` (11 tests): ac-1 header/banner/tooltip, ac-2 choose,
  switch, remove, add, hidden on a created thread, filter threshold, send uses chosen project;
  ac-3 New conversation and open-another clear; ac-4 refused send states.
