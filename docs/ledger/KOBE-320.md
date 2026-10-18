# KOBE-320: B1: Workbench drafts: storage and API

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Branch / worktree:** `group-skills-b` in `../Kobe-skB`
- **Depends on:** KOBE-319 (Phase A, merged in 5d60abd7)

## What shipped

- **Tables (team, FORCE RLS, probes):** `skill_drafts` (owner, `shared`, `name`, `started_from`,
  `parent_ref`, `from_thread_id`, `rev`, `size_bytes`, `file_count`, `updated_by`) and
  `skill_draft_files` (path, `text_content` or `bytes` bytea, `size`). Key `(team_id, id)`; files
  reference `(team_id, draft_id)` ON DELETE CASCADE.
- **Migrations:** `0141_skill_drafts` (generated) and `0142_skill_drafts_rls` (custom: RLS; a
  trigger keeps each draft's size and file count from its files, so the 5 MiB check binds every
  writer; files never move between drafts; the app can't set the bookkeeping columns). New and
  empty tables: no backfill, no FORCE lifting. Each in its own commit.
- **API** (`/v1/skills/drafts`, `routes/skill-drafts.ts`, mounted before `/v1/skills`):
  `POST /` (blank draft with a SKILL.md skeleton), `GET /`, `GET /:id` (files list, ETag),
  `GET|PUT|DELETE /:id/files/<path>`, `PATCH /:id {shared}`, `DELETE /:id`,
  `POST /:id/versions {destination, semver, changelog, confirmPersonal?}`.
- **Server modules:** `skills/drafts/{files,records,service,save}.ts`; `skills/publish.ts` (scan +
  store + refusal mapping, now shared by the upload route and Save version); `routes/skill-json.ts`
  (the skill and version JSON both routes return).
- **Retention / offboarding:** `retention/skill-drafts.ts`: the nightly pass purges drafts unchanged
  for longer than the team's window (step 9, audited `retention.skill_drafts_purged` with a count);
  offboarding purges a departed author's drafts, shared ones too (step 6, before `finish`). Both
  skip drafts whose author a legal hold covers.
- **Audit:** `skill.draft.created`, `.shared`, `.deleted`, `.personalized`;
  `retention.skill_drafts_purged`; `skill.uploaded` gains optional `draftId`. In `docs/audit-log.md`.

## Decisions

- **Who sees a draft:** its author; Builders and Team admins once shared; nobody else (a draft one
  can't see is a 404, never a 403). Only the author shares, unshares, deletes or saves to personal.
  Save to team needs `team.skills.publish` (Builder), as an upload does.
- **Revisions:** one `rev` per draft; every change (file write or delete, share) needs
  `If-Match: <rev>` (428 without), runs under the draft's row lock and bumps `rev`; stale is
  409 `stale_revision` with `rev` and `changedBy {id, name}`. Save version takes an optional
  If-Match (stale: 409). Two co-editors on different files also conflict (whole-draft rev).
- **Files:** path rules are the package contract's for authored content (`checkPackagePaths`,
  segment-wise URL decoding, a decoded `/` refused); at most 200 files, SKILL.md at most 100 KiB
  (the upload's limits), 5 MiB in all (413 `draft_too_large`). Valid UTF-8 without NUL is stored
  inline, anything else as bytea; reads return the bytes exactly (text/plain or
  application/octet-stream, nosniff, CSP sandbox, no-store).
- **Name** follows the SKILL.md frontmatter whenever it parses; otherwise the draft keeps its name.
- **Save version** builds the canonical zip of the files and runs the upload's own validation
  (`validateZipBundle`, limits raised only for the stored zip's size), `numberingFrom`, the scan
  and `putPackage` (source `zip`); a team save is a pending D22 review. `semver` and `changelog`
  are required here (the upload keeps its defaults). The draft stays after a save. A personal save
  of a draft with `from_thread_id` needs `confirmPersonal: true` (409
  `confirm_personal_required`, message names the team) and records `skill.draft.personalized` in
  the version's transaction.
- **Limits:** 50 drafts per author per team; file writes share a 1,200 per 10 min per-user rate;
  Save version shares the upload rate.
- **No break-glass read policy:** drafts are skill sources like `team_skills`, not thread or memory
  content.
- **`from_thread_id` has no key:** a purged thread must not clear it (the personal-save
  confirmation would silently stop applying).

## Open questions (for Chris or the coordinator)

1. **Legal hold vs. the author's own edits:** purges skip held authors' drafts, but the author can
   still edit or delete a held draft (drafts are mutable; keeping every revision for a hold would
   need a history table like eval cases'). Also a held draft past the window stays visible (shows
   nothing about the hold beyond "not purged yet"). Accept for v1.2?
2. **Fork of a team version saved as personal** also takes team content to every team; the spec's
   confirmation covers only drafts started from a conversation. KOBE-322 (fork) may want the same
   confirmation for forks of team skills.
3. **Offboarding reach:** the purge runs per departed member's `sandboxes` row (existing design, as
   for memory and eval cases), so a member who left without ever having a sandbox keeps their
   drafts until the retention window takes them. Fine, or should the sweep also find departed
   authors of drafts?

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-drafts.db.test.ts` "drafts: create, read, write" (private by
  default, rev checks with changed-by, sharing to Builders/Team admins only, author-only share and
  delete, path rules, size caps, team walls); `skills/drafts/files.test.ts`.
- **ac-2** same file, "save version": team save pending review with `draftId` audited; member,
  stale, invalid package and bad bodies refused; personal save author-only, confirmation and
  `skill.draft.personalized` audit.
- **ac-3** probes (`packages/db` `probe.db.test.ts` via the new fixtures), `catalog.db.test.ts`
  (FORCE RLS, grants), `packages/db/src/skill-drafts.db.test.ts` (size trigger, checks, cascade);
  server "retention and offboarding" (window purge, hold skip, audit count, departed author).
- Runs: `@kobe/db` test + test:db, `@kobe/server` test + test:db, `@kobe/cli` test:db, typecheck,
  lint, format, site wording and public hygiene.
