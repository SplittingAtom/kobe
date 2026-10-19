# KOBE-321: B2: Skills page and Workbench editor

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent doing KOBE-322 onward)

- **Branch:** `group-skills-b` in `../Kobe-skB`; 320 and 321 committed, nothing pushed. The
  fork-parent contract for 322 is in `docs/ledger/KOBE-320.md` (handoff).
- **Where starts go:** the Workbench tab's "New draft" (`components/skills/workbench-list.tsx`)
  only starts a blank draft today; 322 adds template, fork (Team and Mine rows in
  `components/skills/skill-list.tsx` have no actions yet), upload and from-a-conversation there.
- **Editor:** `components/skills/draft-editor-page.tsx` (layout), `use-draft-editor.ts`
  (one queue for every change, revisions, unmount flush), `use-scan-preview.ts`,
  `save-version-dialog.tsx`. Pure helpers a server component calls go in `lib/` (tabs.ts), never
  in a "use client" module: `app/server-client-boundary.test.ts` enforces it. 323's test pane goes beside the
  editor column in `Editor`'s grid.
- **Bump base:** `suggestDraftBump` (`services/server/src/skills/drafts/suggest.ts`) compares with
  the destination's same-named skill only; a fork saved as a new skill starts at 0.1.0
  (coordinator, review round 1). Existing skills get their edit path (Fork) in 322; the group
  deploys after 322.

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
  into the package only, since review round 1), `evals/`.
- **Meter** (`lib/skills/meter.ts`): counts UTF-16 units like the server; warns past 1,024 (Save
  version refuses) and past 1,536 (Claude Code's cap).
- **Server:** `GET /v1/skills/drafts/:id/scan` (verdict, findings, scripts; ETag rev; 429
  `scan_busy` + Retry-After) and `GET /v1/skills/drafts/:id/bump?destination=team|personal`
  (`{rev, latest, kind, suggested, reasons}`); both for a draft the caller can see (404 otherwise),
  rate-limited together (600 per 10 min per user, `DRAFT_PREVIEW_RATE`; scans count only when
  a new scan is needed).
- **Primitives:** console `Tabs` (Radix Tabs) and `Dialog` (Radix Dialog, `returnFocus` getter,
  `DialogClose`), with tests; `components/skills` joined the console CSS-module guard.
- **Retired:** the KOBE-83/98 editors (`skill-editor-page.tsx`, `files-editor.tsx`, `area.ts`,
  `lib/admin/skills/{bundle,validate}.ts`). Permanent redirects: `/me/skills/new` and
  `/admin/team/skills/new` → `/me/skills?tab=workbench`, `/me/skills/:id` → `?tab=mine` (one
  segment, so `/me/skills/drafts/<id>` is never caught). The Team console keeps its admin views:
  the skills list (links to `/admin/team/skills/<id>`, "Open the Workbench"), installs, switches,
  and a skill's access/reach/usage page (`skill-admin-page.tsx`), no editor.

## Decisions

- **Scan previews** share the main pool (see Review round 1; the first design's separate pool
  is gone). Cache per (team, draft, rev), 128 entries in process, complete scans only;
  visibility is checked before the cache.
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

## Review round 1 (review-321.md, coordinator decisions)

- **B1:** `skillTab` moved to `lib/skills/tabs.ts`; the page is keyed by tab (a `?tab=` link on
  the page switches). Proof: the old code built, but `next start` logged "Attempted to call
  skillTab() from the server" (HTTP 200, streamed error page); the fix renders the shell on all
  four tabs and the draft route with no server error. Guard test over every server file in app/.
  e2e `skills-workbench.spec.ts` (gate1): every tab loads, retired URLs redirect, a draft
  autosaves, lints, scans within 2 s, keeps an edit made just before leaving, and is deleted.
- **B2:** leaving the editor writes pending edits (unmount flush; the queue outlives the page),
  including after a failed write; tested.
- **S1/S2 (pool):** previews run in the shared pool with the save's worker, limits and rules
  (`preview: true`), so verdicts agree (tested on a crafted bundle and in the pool); a preview
  never queues and gives its slot up to any upload or save (`ScanCancelledError` preempted);
  `signal` stops a running worker. The separate preview pool is gone.
- **S1 (latest wins):** a caller's newer preview cancels their older one (other revision), the
  request's own signal too; busy is 429 with Retry-After 1 and the page asks again after 1 s (10
  times at most until the next change).
- **S2 (no cached Block):** a scan that ran out of time or memory is 503 `scan_unavailable`, never
  cached, shown "Scan unavailable, retrying…" (5 s, 3 times) with the last complete scan; paths
  that aren't a package are 422 `invalid_package`, shown as "Not scanned: …".
- **S3:** a cheap revision read first; a cached or running scan of that revision is reused
  without counting against the rate; files are read and zipped only after admission.
- **S4:** new file, delete file and sharing run in the editor's one queue behind pending
  autosaves (no self-409); tested.
- **S5:** the dialog's form mounts fresh on every open; a failed flush or bump shows "No
  suggestion: …"; tested.
- **Nits:** the meter announces only its warning; `/me/skills/:id` redirect is 307 (a later
  `/me/skills/<slug>` stays possible); binary files keep "(binary)" in their accessible name; the
  form's hint says it rewrites the frontmatter. Absolute-path lint flags only paths into the
  package (coordinator). Not done: `router.push` for create and delete (full reloads remain;
  delete has nothing left to save).

## Departures

- Server endpoints added to a web ticket (scan preview, bump): the live scan and the bump need
  the stored files and versions; lint stays in the browser.
- Browser e2e (`e2e/browser/tests/consoles.spec.ts`): `/admin/team/skills/new` and
  `/me/skills/new` shots dropped; `/me/skills?tab=workbench` and a `skill-draft` detail added (no
  baselines yet: `--update-snapshots` at the next gate run).

## Open questions (for Chris or the coordinator)

1. The Catalog tab is a placeholder; the Team and Mine rows have no actions until 322 (Fork).

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
