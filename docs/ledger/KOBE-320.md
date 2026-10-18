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
  for longer than the team's window and released hold copies (step 9); the offboarding sweep purges
  departed authors' drafts (see Review round 1).
- **Audit:** `skill.draft.created`, `.shared`, `.deleted`, `.personalized`;
  `retention.skill_drafts_purged`; `skill.uploaded` gains optional `draftId`. In `docs/audit-log.md`.

## Decisions

- **Who sees a draft:** its author; Builders and Team admins once shared; nobody else (a draft one
  can't see is a 404, never a 403). Only the author shares, unshares, deletes or saves to personal.
  Save to team needs `team.skills.publish` (Builder), as an upload does.
- **Revisions:** one `rev` per draft; every change (file write or delete, share) needs
  `If-Match: <rev>` (428 without), runs under the draft's row lock and bumps `rev`; stale is
  409 `stale_revision` with `rev` and `changedBy {id, name}`. Save version requires
  If-Match too (428 / 409). Two co-editors on different files also conflict (whole-draft rev).
- **Files:** path rules are the package contract's for authored content (`checkPackagePaths`,
  segment-wise URL decoding, a decoded `/` refused); at most 200 files, SKILL.md at most 100 KiB
  (the upload's limits), 5 MiB in all (413 `draft_too_large`). Valid UTF-8 without NUL is stored
  inline, anything else as bytea; reads return the bytes exactly (text/plain or
  application/octet-stream, nosniff, CSP sandbox, no-store).
- **Name** follows the SKILL.md frontmatter whenever it parses; otherwise the draft keeps its name.
- **Save version** builds the canonical zip of the files and runs the upload's own validation
  (`validateZipBundle`, limits raised only for the stored zip's size), `numberingFrom`, the scan
  and `putPackage` (source `zip`); a team save is a pending D22 review. `semver` and `changelog`
  are required here (the upload keeps its defaults). The draft stays after a save. Personal saves: see Review round 1
  (B2).
- **Limits:** 50 drafts per author per team; file writes share a 1,200 per 10 min per-user rate;
  Save version shares the upload rate.
- **`from_thread_id` has no key:** a purged thread must not clear it (the personal-save
  confirmation would silently stop applying).

## Review round 1 (security/DB review, coordinator decisions)

- **B1 legal hold (silent history pattern):** 0141 adds `skill_draft_history` and
  `skill_draft_file_history`; files record their writer (`updated_by`). 0142's triggers copy what a
  change would lose while a hold covers the author **or the writer** (`skill_draft_held`): a file
  overwritten or deleted, a draft renamed or (un)shared, a draft deleted (its files copied before
  the cascade). Nothing is refused: edits, deletes and both purges go through, so a held draft past
  its window looks purged. Copies are immutable, their deletion refused (KH001) while held,
  TRUNCATE of all four tables refused under any hold; the retention pass purges released copies
  (`reason: hold_released`). No `hidden_at` needed: held rows never stay in the live tables.
- **B2 team wall:** a personal save of a fork whose parent is a team version (or another member's,
  or an unknown shape: fail closed) is refused, 409 `team_content` ("Promote it, or save it as a
  team skill"); a catalog fork or a fork of the author's own personal version is allowed. A draft
  started from a conversation or co-edited (`co_edited`, set by the database once anyone else
  writes, never cleared) needs `confirmPersonal`. Provenance is immutable and must fit the start
  (`skill_drafts_provenance` check). Every personal save records `skill.draft.personalized` in the
  team (`fromConversation`, `coEdited`). Personal saves and draft creation check
  `team.personal.create` (S5).
- **B3 offboarding:** independent of sandboxes. The offboarding sweep marks drafts whose author is
  no longer an active member (`owner_departed_at`), clears the mark when they return, and deletes
  them 30 days on (held content to history; audited `reason: offboarding`). The sandbox purge no
  longer touches drafts. Tested: no sandbox, a destroyed sandbox, deactivation, a return, and
  leaving again after a return.
- **S1** break-glass reads on all four tables (team grant all; user grant by author or writer;
  thread grant none). **S2** Save version requires `If-Match` (428). **S3** file writes check path,
  If-Match, rate, visibility and room before reading the body, and read it only up to that room.
- **Nits:** N1 advisory lock per (team, author) around the draft cap; N2 `file_count <= 200` in the
  DB check; N3 noted in the schema (`from_thread_id` writers check the team); N4 offboarding draft
  purges are now audited as counts; N5 the list pages (100, `?cursor=`, microsecond-exact); N6 file
  writes stay unaudited (autosave), saves and sharing are audited.

## Open questions (for Chris or the coordinator)

1. `parent_ref` shape is now a contract for KOBE-322: `{kind: catalog|team|personal, skillId,
semver, hash, ownerUserId?}`; anything else counts as team content.
2. A co-edited draft that is later unshared stays co-edited (by design: the content is still the
   team's). Fine?

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
