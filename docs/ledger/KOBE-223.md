# KOBE-223: C5 @file mentions with server-side path rewrite (CE22)

- **Status:** done on branch, awaiting review (no PR: group G4)
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-198 / KOBE-203 (rail and file listing), KOBE-148 (workspace files API),
  KOBE-221 (shared threads: readers cannot send)
- **Migrations:** none

## What it does

1. **Picker** (`apps/web/components/chat/mention-picker.tsx`): assistant-ui's own trigger popover
   (`ComposerPrimitive.TriggerPopoverRoot` around the composer, `TriggerPopover char="@"` with a
   `Directive` behaviour). The textarea is the combobox (aria-expanded/controls/activedescendant
   from `ComposerPrimitive.Input`), the list a `listbox` "Workspace files": arrows, Enter/Tab
   pick, Escape closes. Results come from the new `GET /v1/workspace/files/search?q=&limit=`
   (own synced files: workspace, `uploads/`, `projects/` mounts; names starting with the query
   first, then newest; 50 max, 20 asked). The popover stays closed while nothing matches, so a
   message that merely holds an `@` still sends on Enter; while a run holds the thread, Enter in
   an open list picks instead of queueing (guard in `composer.tsx`).
2. **Chip**: a pick writes the marker `@file(<path>)` into the text; `MentionChips` ("Mentioned
   files", above the input like attachment chips) is derived from the markers in the text, so it
   follows edits, undo, dictation and drafts; ✕ removes the marker.
3. **Rewrite** (`services/server/src/runs/mentions.ts`, called in the orchestrator inside the
   thread transaction for `submitMessage` (user trigger), `steer` and the queued-message edit):
   each marker resolves to the file's absolute sandbox path; `runs.input`, `run.start.message`,
   `run.steer` and `steer.applied` carry the rewritten text. No upload, no copy; project mounts
   stay read-only (the agent just gets their path).

## Decisions

- **Storage: inline text, no marker kept.** The client sends the marker inside `content`; the
  server stores and sends Pi only the rewritten prompt (`/workspace/data/x.csv`). So history,
  edit (pre-fills the path text, which is plain text on resend), regenerate (re-sends the stored
  prompt), fork (copies Pi's session) and export all show the same absolute path with no new
  renderer, no new column and no change to `submitMessageBodySchema`. Paths of letters, digits
  and `_ . / + @ , = -` are written plain; anything else (spaces, brackets, …) as a Markdown
  code span fenced past any backticks in the name (`promptPath`).
- **Contract:** additive only: `packages/protocol/src/mentions.ts` (marker syntax, encode/find/
  decode) and the search query/response schemas in `files.ts`. Marker = `@file(` + path with `%`,
  `(`, `)`, whitespace and `\p{C}` percent-encoded + `)`; decoded exactly once.
- **Validation (server, never the client's word):** decode (malformed → refuse); refuse any
  `\p{Cc}` (NUL, C0/C1), U+2028/2029; an absolute path must start with `/workspace/` (stripped),
  any other absolute path is refused; then `workspacePathIssue` (no empty/`.`/`..` segments,
  backslashes, bidi controls/BOM, > 1024 bytes or a segment > 255); `.kobe/` refused; at most 20
  distinct files; every path must be a live (not deleted) row of the **thread owner's** manifest
  in the caller's team, read in `withTeam()` with `team_id` and `user_id` named. No
  normalisation into another file, no filesystem access, no folders. Symlinks never reach the
  manifest (the sandbox sync takes regular files only). Any failure refuses the whole message:
  422 `invalid_mention`, no run created; the message names the unknown path only after it passed
  the path rules.
- **Access:** `lockOwnedThread` runs before the rewrite, so a reader of a shared thread gets 403
  `read_only` before any lookup; the owner is read from the thread, the team from the session.
- **Scheduled runs** are not rewritten (their prompt is sent as written; a schedule cannot hold a
  picked mention).
- **Extensibility for KOBE-224/225:** the `TriggerPopoverRoot` wraps the whole composer; the `/`
  menu adds its own `TriggerPopover char="/"` (Action behaviour) next to `MentionPicker`. The
  Enter-queues guard checks the input's `aria-expanded`, so it covers any trigger.
- Live-only files (on the sandbox disk, not yet synced) are not offered or accepted: the manifest
  is the server's only trustworthy listing.

## e2e

- **k3d** (`e2e/run.sh`, after the KOBE-146 uploads section, same thread): the upload is a file of
  the Owner's workspace; `bash: cat @file(uploads/<thread>/e2e-upload.txt); exit 0` → 201, the
  stored `runs.input` is `bash: cat /workspace/uploads/<thread>/e2e-upload.txt; exit 0`, and the
  fake model's tool echo returns the file's content (the real sandbox read that path).
  `/etc/passwd`, `../../etc/passwd` and an unknown file are 422 and leave no run. Proven at G4's CI.
- **Browser** (`e2e/browser/tests/file-mentions.spec.ts`, gate1 after deploy): drops a file into
  `uploads/`, types `@kobe-223-…`, Enter picks, chip, send; the prompt shows the absolute path, a
  tool-call card names it, the answer quotes the file; the file is deleted at the end.

## Open questions

- None blocking. Mentions in the assistant-ui edit composer (edit a sent message) get no picker;
  a typed marker there is still resolved by the server.

## Evidence

- ac-1: `apps/web/components/chat/mention-picker.test.tsx` (listbox + combobox ARIA, arrows,
  Enter, chip, sent content; Escape; chip removal; Enter picks while running; no list without
  matches); `services/server/src/file-mentions.db.test.ts` (rewrite to the absolute path in
  `runs.input` and `run.start`; steer and queued edit); `workspace-files.db.test.ts` (search:
  own files only, deleted and other members' excluded, ranking, limit, bad queries 400).
- ac-2: `e2e/run.sh` "mentions" checks (k3d, CI); browser spec for gate1.
- ac-3: `services/server/src/runs/mentions.test.ts` (outside `/workspace`, traversal however
  encoded, NUL/controls/line separators/backslash/bidi, malformed, overlong) and
  `file-mentions.db.test.ts` (422 for those, unknown, deleted, `.kobe/`, > 20, another member's
  and another team's files; reader 403 `read_only`).
- Commands: format:check, lint, typecheck, `turbo run test` (all green; protocol `frames.test`
  and sandbox-agent `identities.test` timed out once under full parallel load, green alone and at
  concurrency 2), `@kobe/db` and `@kobe/server` `test:db`.
