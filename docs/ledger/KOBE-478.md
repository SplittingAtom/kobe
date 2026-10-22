# KOBE-478: Skills Workbench Create File and New Folder in the Define tab

- **Status:** in review (group branch `group-28-skill-create-file`, not pushed)
- **Worktree:** `../Kobe-wt478`

## Design

- **Create file:** a button next to Add file (and "Create a file here" on an empty folder) opens
  `NewFileEditor` in the editor rail in place of the file pane: path (folders included, starting
  with the folder's `name/`), contents (a plain `Textarea`, as the existing file edit view, which
  does not use CodeMirror), Save file / Cancel. Save checks the path with `newPathProblem` (the
  package contract's rules, as Add file) and then writes through `editor.addFile(path, text)`,
  the same `PUT /v1/skills/drafts/:id/files/*` as autosave and Add file. So the server's path
  rules, size limits (`file_too_large`/`draft_too_large`, shown in the form), revision checks,
  lint, scan preview and saved versions apply unchanged. Nothing is written before Save.
- **New folder:** a draft stores files only (`skill_draft_files`, path with its folders); there
  is no folder row and no placeholder file in the model. A new folder is **UI state only**: it
  shows in the tree ("Empty until a file is saved in it.") until a file is saved in it, and is
  gone after a reload if it stays empty. Name rules (`newFolderProblem`): non-empty, one trailing
  `/` dropped, not an existing file or folder (also not one differing only in case), and the
  package path rules for a file inside it (no `..`, empty or `.` segments, absolute paths, `\`,
  control/bidi characters, reserved names spelled exactly). Nested names (`a/b`) allowed.
- **Unsaved new file:** once a path or contents is typed, Cancel, another tree entry or another
  folder's "Create a file here" ask "Discard the new file?" first; closing the Skills panel and
  the browser tab ask too. Switching Define/Test/Eval keeps it (tabs stay mounted).
- No server, route or migration change; a DB test pins the server's own refusal of absolute,
  empty-segment, backslash and smuggled `..%2F` paths (URL dot segments resolve out of `/files/`: 404).

## Verification

- Unit: `apps/web/lib/skills/paths.test.ts` (folder rules), `draft-editor.test.tsx` (create,
  cancel, path refusal, server size refusal, folder validation, file in a new folder, discard
  guard); `services/server/src/skill-drafts.db.test.ts` (KOBE-478 path refusals).
- Browser: `e2e/browser/tests/skills-workbench.spec.ts` "Create file and New folder ..." (gate1).
