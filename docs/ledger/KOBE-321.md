# KOBE-321: B2: Skills page and Workbench editor

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent doing KOBE-322 onward)

- **Branch:** `group-skills-b` in `../Kobe-skB`; 320 and 321 committed, nothing pushed. The
  fork-parent contract for 322 is in `docs/ledger/KOBE-320.md` (handoff).
- **Where starts go:** the Workbench tab's "New draft" (`components/skills/workbench-list.tsx`)
  only starts a blank draft today; 322 adds template, fork (Team and Mine rows in
  `components/skills/skill-list.tsx` have no actions yet), upload and from-a-conversation there.
- **Editor:** `components/skills/draft-editor-page.tsx` (layout), `use-draft-editor.ts`
  (autosave queue, revisions, scan), `save-version-dialog.tsx`. 323's test pane goes beside the
  editor column in `Editor`'s grid.
- **Bump base:** `suggestDraftBump` (`services/server/src/skills/drafts/preview.ts`) compares with
  the destination's same-named skill only; a fork saved as a new skill gets 0.1.0. 322 may want
  the parent version as the base when the destination has no skill of that name.

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Branch / worktree:** `group-skills-b` in `../Kobe-skB`
- **Depends on:** KOBE-320

## What shipped

- **Skills page** `/me/skills` (My area shell): tabs Catalog (placeholder until C7), Team, Mine
  (personal skills and the member's skill choices, KOBE-316), Workbench (my drafts and drafts
  shared with me, paged; New draft). `?tab=` opens a tab; switching tabs updates the address
  (`history.replaceState`). Reached from the bar (`skills` command, area links) and the palette
  and `/skills`; the profile menu's "My skills" link went (the bar has it).
- **Workbench editor** `/me/skills/drafts/<id>`: file tree (folders grouped, binaries read-only,
  New file checked with the protocol's `checkPackagePaths`), SKILL.md frontmatter form (name,
  description with the meter, other keys as YAML, instructions) or SKILL.md as text (also the
  fallback when the frontmatter doesn't read), text file editor, delete file, share switch and
  delete draft (author only), lint panel, scan preview panel, Save version dialog.
- **Autosave:** each edit is written after 400 ms idle, at most 1.2 s apart while typing, one
  write at a time with `If-Match` of the last revision; then the scan preview of that revision.
  A 409 `stale_revision` stops autosave and shows who changed the draft with Reload.
- **Lint** (`lib/skills/lint.ts`, in the browser on every keystroke): frontmatter readable, name
  rules (error), double hyphen (warning), description present (error) / says what and when
  (warnings), referenced files exist (links and `scripts|references|assets|evals/...` paths),
  every `scripts/` file and every scanned script mentioned in SKILL.md, absolute paths (links
  starting `/`, home dirs, `~/`, drive letters; `/workspace/...` outputs are allowed), `evals/`.
- **Meter** (`lib/skills/meter.ts`): counts UTF-16 units like the server; warns past 1,024 (Save
  version refuses) and past 1,536 (Claude Code's cap).
- **Server:** `GET /v1/skills/drafts/:id/scan` (verdict, findings, scripts; ETag rev; 429
  `scan_busy` + Retry-After) and `GET /v1/skills/drafts/:id/bump?destination=team|personal`
  (`{rev, latest, kind, suggested, reasons}`); both for a draft the caller can see (404 otherwise),
  rate-limited together (600 per 10 min per user, `DRAFT_PREVIEW_RATE`).
- **Primitives:** console `Tabs` (Radix Tabs) and `Dialog` (Radix Dialog, `returnFocus` getter,
  `DialogClose`), with tests; `components/skills` joined the console CSS-module guard.
- **Retired:** the KOBE-83/98 editors (`skill-editor-page.tsx`, `files-editor.tsx`, `area.ts`,
  `lib/admin/skills/{bundle,validate}.ts`). Permanent redirects: `/me/skills/new` and
  `/admin/team/skills/new` → `/me/skills?tab=workbench`, `/me/skills/:id` → `?tab=mine` (one
  segment, so `/me/skills/drafts/<id>` is never caught). The Team console keeps its admin views:
  the skills list (links to `/admin/team/skills/<id>`, "Open the Workbench"), installs, switches,
  and a skill's access/reach/usage page (`skill-admin-page.tsx`), no editor.

## Decisions

- **Scan previews have their own pool** (`previewScanPool`, `PREVIEW_SCAN_POOL`): one worker,
  96 MiB heap, 2 waiting, 1 per user, 10 s deadline, so typing never queues uploads, saves or
  rescans; with the main pool's two 192 MiB workers the pod stays under its 1 GiB limit. A
  preview that can't finish shows Block `scan-incomplete`; the save scans again in the main pool.
- **Preview cache** per (team, draft, rev), 128 entries in process: every change bumps the rev,
  so a hit is the scan of exactly those files; visibility is checked before the cache.
- **Bump rules (SK14)** in `skills/drafts/bump.ts`: major for name, description or any script
  (`scripts/` or a script extension anywhere), minor for SKILL.md body or other frontmatter,
  patch for everything else (references, assets, `evals/`, `kobe.skill.yaml`); an unreadable
  SKILL.md counts as major; null when byte-identical (the save would be `unchanged`). A new skill
  is suggested 0.1.0 (the upload's default). The author's number wins once typed.
- **Personal bump** compares only with the caller's own personal skills (never another member's).
- **Save version** flushes pending edits first and sends that revision; the personal
  confirmation checkbox shows up front for drafts from a conversation or co-edited, and after a
  409 `confirm_personal_required` (the server's message is the checkbox hint).
- **Skills page path:** `/me/skills` (the My area, next to My agents), not a new top-level route.

## Departures

- Server endpoints added to a web ticket (scan preview, bump): the live scan and the bump need
  the stored files and versions; lint stays in the browser.
- Browser e2e (`e2e/browser/tests/consoles.spec.ts`): `/admin/team/skills/new` and
  `/me/skills/new` shots dropped; `/me/skills?tab=workbench` and a `skill-draft` detail added (no
  baselines yet: `--update-snapshots` at the next gate run).

## Open questions (for Chris or the coordinator)

1. The Catalog tab is a placeholder; the Team and Mine rows have no actions until 322 (Fork).
2. `/workspace/...` paths in SKILL.md are not flagged as absolute (they name the sandbox's
   output folder, not skill files). Right call?

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/skills/skills-page.test.tsx` (tabs, Team/Mine/Catalog, drafts mine
  and shared, paging, start a draft, no start without the permission, bar and `/skills`);
  `components/ui/console/tabs-dialog.test.tsx`.
- **ac-2** `components/skills/draft-editor.test.tsx` "lints on every keystroke and shows the scan
  of the saved edit within 2 s" (fake timers: PUT with If-Match and the scan of rev 4 inside
  2,000 ms), max-wait autosave, meter thresholds, stale revision; `lib/skills/lint.test.ts`
  (each rule, both meter thresholds); server `src/skill-drafts-preview.db.test.ts` "scan preview"
  (verdict per revision, 404 for anyone who can't see it, cache per rev, busy 429).
- **ac-3** server `src/skills/drafts/bump.test.ts` (each change kind) and
  `skill-drafts-preview.db.test.ts` "suggested bump" (0.1.0, patch, minor, major, unchanged, per
  destination); web Save version tests (suggestion per destination, If-Match, confirmation, the
  server's refusal); `lib/admin/nav/redirects.test.ts` (retired editors);
  `components/admin/skill-admin-pages.test.tsx` (admin views without an editor).
- Runs: web test (1,891), typecheck, lint, build; server test, lint, typecheck, test:db; format,
  site wording, public hygiene.
