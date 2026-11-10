# KOBE-590: PC-3 Files panel lists every project

Branch `kobe-590-files-all-projects`, on wave 1 (PR #510). Spec: `docs/specs/projects-in-conversations.md` §2, §5 (FP1-FP6), §11.

## Status

Implemented (web only). Not pushed. `pnpm verify` not run here (7 GB box); focused vitest, tsc, eslint, prettier only.

## What changed

- `lib/projects/files-panel.ts`: pure rules. `shapeProjectRows` (active first, then name; filter; FP5 cap), `headListing` (a project's flat head file list as folder listings), `unmountedProjectEntry`, the words ("Active in this conversation", "Not in this conversation", the drag refusal).
- `components/files/project-heads.ts`: wraps the tree's `FilesApi`. A 404 for `projects/<slug>[/...]` of a known live project lists from `GET /v1/projects/:id/files` (cached 10 s), never mounting. A missing `projects/` folder is an empty one.
- `components/files/workspace-tree.tsx`: `useProjectsInTree(tree, activeProjectId)` builds the Projects rows (mounted entries plus a synthetic row per unmounted project), decorations (dot, greyed), `mentionRefusal`, filter/show-all state. Header link is "Manage projects →". `ProjectsFilter`, `ShowAllProjects`.
- `components/files/file-tree.tsx`: `RowDecoration.active/greyed`; green dot (`role="img"`, label), greyed name uses `text-muted-foreground`; a file of an unmounted project drags with `UNMOUNTED_DRAG_TYPE` (`lib/files/drag.ts`) instead of the path type.
- `components/chat/composer-mention-drop.ts`: that drag is taken and refused with its message on drop.
- `components/chat/use-conversation-project.ts` + `workspace-rail.tsx`: active project (thread's `summary.projectId`, or the draft), `newConversationIn`, `moveHere` (via `session.organize`, same move as the title menu).
- Menu commands `new-conversation-in-project`, `move-conversation-here` (`lib/shell/commands.ts`).
- Token `--kobe-active-dot` (= `--kobe-status-done`, per preset and scheme; tested 3:1 on rail and page in `app/theme-css.test.ts`).
- FP6: `components/projects/use-project-mutation.ts` reloads the provider after a saved change on the projects page, project detail page and members. Workspace switch builds a new provider; the active row follows the conversation with no fetch.

## Choices where the spec was silent

- "50 most recently used" = most recently updated (`updatedAt`); the API has no last-used.
- A project known to the list but not mounted is "unmounted"; its files do not open in the artifact column (not in the sandbox) and have no menu; Open/Download/Mention say or do nothing. Clicking one says "Start a conversation in <Project> to open its files".
- Active project that is not mounted yet (a draft) still refuses drags: the file is not in a sandbox.
- A mounted project that is archived or unknown to the list: archived ones are hidden (FP1); unknown ones stay by slug as before.
- Move here needs the on-screen thread to be loaded, not read-only and idle (same BUSY rule as the title menu); the server still rules.
- New conversation in this project: `setDraftProject(null)`, `switchToNewThread()`, then `setDraftProject(id)` (again on the next tick, in case the switch settles late).
- Persisted-expanded unmounted folders collapse if the project list has not loaded when the tree first lists them (the 404 handler forgets them).

## Open questions

- Should an unmounted file open read-only from the project head (preview in the artifact column)? Needs a head file read route in the artifact panel; left out.
- The "Show all (N)" expansion resets when the page reloads (not remembered).

## Evidence

`npx vitest run --maxWorkers=2` on `lib/projects`, `components/files`, `components/projects`, `app/theme-css.test.ts`, `components/chat`, `components/shell`: see the final report.
