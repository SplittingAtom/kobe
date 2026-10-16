# KOBE-223: C5 @file mentions with server-side path rewrite (CE22)

- **Status:** done on branch, awaiting review (no PR: group G4)
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-198 / KOBE-203 (rail and file listing), KOBE-148 (workspace files API),
  KOBE-221 (shared threads: readers cannot send)
- **Migrations:** `0107_schedule_mentions` (drizzle-generated: `schedules.mentions text[] NOT NULL
DEFAULT '{}'`, check `cardinality <= 20`), added in the security-review round

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

- **Storage: inline text, no marker kept.** The client sends the marker inside `content` and the
  picked paths in `mentions`; the server stores and sends Pi only the rewritten prompt (`/workspace/data/x.csv`). So history,
  edit (pre-fills the path text, which is plain text on resend), regenerate (re-sends the stored
  prompt), fork (copies Pi's session) and export all show the same absolute path with no new
  renderer, no new column and no change to `submitMessageBodySchema`. Paths of letters, digits
  and `_ . / + @ , = -` are written plain; anything else (spaces, brackets, …) as a Markdown
  code span fenced past any backticks in the name (`promptPath`).
- **Contract:** additive only: `packages/protocol/src/mentions.ts` (marker syntax, encode/find/
  decode) and the search query/response schemas in `files.ts`. Marker = `@file(` + path with `%`,
  `(`, `)`, whitespace and `\p{C}` percent-encoded + `)`; decoded exactly once.
- **Validation (server, never the client's word):** each listed path (relative to
  `/workspace`; absolute paths are refused) passes `mentionPathIssue` (no empty/`.`/`..`
  segments, backslashes, > 1024 bytes or a segment > 255, no invisible/format/shell characters:
  see B1 below), is not under `.kobe/`, at most 20, and is a live (not deleted) row of the
  **thread owner's** manifest in the caller's team, read in `withTeam()` with `team_id` and
  `user_id` named. No normalisation into another file, no filesystem access, no folders. Symlinks
  never reach the manifest (the sandbox sync takes regular files only). Any failure refuses the
  whole message: 422 `invalid_mention`, no run created; the message names an unknown path only
  after it passed the path rules.
- **Access:** `lockOwnedThread` runs before the rewrite, so a reader of a shared thread gets 403
  `read_only` before any lookup; the owner is read from the thread, the team from the session.
- **Scheduled runs** keep their mentions (see S3 below).
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

## Security review (coordinator: changes requested) and fixes

- **B1** mention paths refuse every `\p{C}` character (controls, zero-width/format incl. ZWJ and
  ZWNJ, bidi, BOM, tag block U+E0000–E007F, private use, unassigned, surrogates), variation
  selectors, other invisible marks and fillers, U+2028/2029, non-ASCII spaces, and `` ` ``, `$`, `;`
  (`mentionPathIssue`, protocol). 422 `invalid_mention`; search leaves such files out and the
  picker filters them again. Newlines can't reach the code span; backticks are refused (fence kept).
- **S1** search: `hitRateLimit` 300/min per member (429 `rate_limited`); scans at most 20 000
  manifest rows through the primary key (path order), no per-row regex, ranking in JS; query
  capped at 100 chars. No index or extension added. A workspace past 20 000 files may miss
  matches in the picker (accepted).
- **S2** mentions are structured: `mentions: string[]` (≤ 20, unique) on submit, steer, queued
  edit and schedules; only the exact marker `mentionMarker(path)` of a listed path is rewritten;
  any other `@file(...)` (code fences, prose, other encodings) is literal. The web keeps a per-draft
  picked set (`MentionStore`, filled by the picker's `onInserted`) and lists the picked paths whose
  marker is still in the text. The rewritten-text storage decision stays.
- **S3** schedules store `mentions` (migration 0107), validated on create/patch against the
  owner's manifest (422 `invalid_mention`, new schedule error code); at run time a listed file that
  is gone (or no longer allowed) leaves its marker as literal text, the run goes ahead, and the
  server logs `mentioned files not found; left as text` with the count.
- Nits done: N1 (rule checks before attachments are staged), N2 (rewritten text capped at
  200 000), N3 (chips show the whole workspace path), N4 (`` ` `` `$` `;` refused), N5 (e2e counts
  every run of the thread), N7 (tests for each character class, `/workspace/.kobe/x`, exactly 20
  and 21 markers of 20, search `.kobe/` and other-team rows, code fences, schedules), N8 (below).
- Skipped: N6 (CHAT_JS does not capture tool-call events; the echo already proves the read);
  tightening `uploadFileNameSchema`/`workspacePathIssue` for all uploads and syncs (wider change,
  beyond this ticket; such names simply cannot be mentioned); no unit test of the 20 000-row scan
  bound (needs 20 000 rows); the warn log is not asserted.
- N8: history carries the owner's absolute workspace paths, which readers of a shared thread see;
  that is the owner's own text (accepted).

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
