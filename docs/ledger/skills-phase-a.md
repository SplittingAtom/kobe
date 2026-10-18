# Skills v1.2 Phase A (KOBE-307..318, KOBE-423): summary

<!-- The group's record for review and merge; details in each ticket's ledger. -->

- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`, nothing pushed. One PR for the group.
- **Spec:** Kobe v1.2 Skills System, SK1–SK33 (Phase A: foundation). Gate: KOBE-319 (Gate A).

## What shipped, per ticket

- **KOBE-307 (A1):** `site_skill*` tables renamed `personal_skill*` in place (hand-written
  migration, no rows touched); Drizzle and server names follow; a CI guard refuses the old names.
- **KOBE-308 (A2):** semver, seq, changelog and package hash on team and personal skill
  versions; old version n became `0.n.0`; uploads take the next minor or a higher given number
  (409 `semver_not_increasing`); team skills gain `access` (from "Offer to all agents") and
  `archived_at`. API and web show semvers.
- **KOBE-309 (A3):** the skill package contract (`docs/skill-package.md`): canonical zip byte
  for byte, `kobe.skill.yaml` (strict), `provenance.json`, runtime hash (what sandboxes get) and
  package hash, path rules; in protocol, dependency-free.
- **KOBE-310 (A4):** `SkillStore` (put, get by hash, list, open, sandbox bundle, approval,
  export), location-scoped and verified on every read, deduplicated by hash within a team or
  user; uploads store the runtime zip plus the package zip; `skill_hash_checks` and a background
  recompute classify stored hashes (same, alias, legacy); the blocklist works on alias groups.
- **KOBE-311 (A5):** the Site Skills Registry and Catalog schema (`registry_*`, tags,
  `site_grants`, `site_skill_settings`) and the team tables (`team_skill_installs`, opt-outs,
  blocks, `member_skill_enablements`), FORCE RLS with probes; the catalog contract in protocol;
  catalog version immutability, reviewer separation and flagged self-approval for a
  single-admin Site in the database.
- **KOBE-312 (A6):** scanner verdict tiers (Pass, Caution, Block), a file-type allowlist,
  prose rules, whole-tree scans; approving Caution or Block needs the findings acknowledged, and
  a Block only with a Site admin's override (audited); no frontmatter pre-approves tools.
- **KOBE-313 (A7):** rescans on a scanner rule-set change (stored rule set per scan, a job with
  a lease, bounded memory and queue); an approved version that turns Block is suspended, omitted
  at run start as `suspended` (never replaced by an older one), and its authors and team admins
  are emailed; Site console status.
- **KOBE-314 (A8):** topic and system tags, the Default tag and the Default sync job (commit
  ordered, resumable, per team, idempotent), sticky opt-outs, Reinstall, Move Default to a new
  major; minimum-count rule on cross-team counts; Site and Team console pages.
- **KOBE-315 (A9):** resolver v2 in SK27 order (Required, named, installs and adds, personal;
  cap 64) with catalog pins (Pinned, Track within major, Track latest; deprecated, withdrawn,
  revoked, suspended), team blocks and the member-add switch; run records carry semver; the
  "Skill updated: x 1.4.2 → 1.4.3" marker; the install route and the name-clash rule.
- **KOBE-316 (A10):** members' per-team toggles for personal skills, team skills and installs;
  access modes for team skills (Builders: Available, On by default, Hidden; Team admins also
  Required); the team's catalog switches; Builder installs within the switch (API and the
  install "Change" form).
- **KOBE-317 (A11):** the seven built-ins became Kobe-published catalog skills, seeded at every
  server start from `services/server/builtin-skills/`, tagged Default once and installed in every
  team by the Default sync; the image bakes no skills; reserved names; legacy queued runs fail
  visibly.
- **KOBE-318 (A12):** publishing a team agent freezes the exact team skill versions it names
  (`team_agent_versions.skill_manifest`); runs load exactly those until a republish; a frozen
  version that is later blocklisted, suspended or no longer approved is omitted with a notice,
  never swapped; existing versions were frozen at what they resolved to on migration day
  (parity test); the builder shows "Skill update available".
- **KOBE-423:** backups verify skill bundle and package keys (`BLOB_REF_COLUMNS`), with a guard
  test that fails on any key-named column neither listed nor exempted.

## Migrations (0128 onward, all unreleased)

| #    | Name                            | Kind         | Ticket | What                                                                                                                              |
| ---- | ------------------------------- | ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 0128 | `personal_skills_rename`        | hand-written | 307    | Rename `site_skills`, `site_skill_versions`, `site_skill_scans`, their constraints and trigger to `personal_*`.                   |
| 0129 | `skill_semver`                  | generated    | 308    | `semver`, `seq`, `changelog`, `package_hash` on both version tables; `skill_access` enum, `team_skills.access`, `archived_at`.    |
| 0130 | `skill_semver_backfill`         | custom       | 308    | Backfill `0.n.0` / seq n and `default_on` (FORCE and triggers lifted), then the semver and seq checks.                            |
| 0131 | `skill_store`                   | generated    | 310    | `skill_hash_checks`; `package_storage_key` on both version tables.                                                                |
| 0132 | `skill_registry`                | generated    | 311    | Registry, tags, grants, settings and the four team catalog tables, with their keys and checks.                                    |
| 0133 | `skill_registry_rls`            | custom       | 311    | RLS (ENABLE + FORCE, policies) on the team tables, the `default` tag and settings seeds, tag guard, immutability, review guards.  |
| 0134 | `skill_rescans`                 | generated    | 313    | `rule_set` and `suspended_at` (+ outbox) per scan and review row, `registry_versions.suspended_at`, `skill_rescan_runs`, indexes. |
| 0135 | `skill_default_syncs`           | generated    | 314    | `skill_default_syncs` (seq, status, counts, cursor), `team_changed_at` on installs, the two catalog switches.                     |
| 0136 | `member_personal_enablements`   | generated    | 316    | `member_skill_enablements.personal_skill_id` (composite FK to the member's own skill), unique index, one-skill check.             |
| 0137 | `kobe_published_skills`         | generated    | 317    | `publisher` on versions, stored bytes columns, Kobe-only names, nullable requesters with `by_kobe` on tags, syncs and installs.   |
| 0138 | `kobe_published_skills_guard`   | custom       | 317    | Immutability of publisher and storage keys; a Kobe version has no self-review.                                                    |
| 0139 | `agent_skill_manifest`          | generated    | 318    | `team_agent_versions.skill_manifest jsonb` (nullable for the backfill).                                                           |
| 0140 | `agent_skill_manifest_backfill` | custom       | 318    | Freeze every team agent version (FORCE and trigger lifted), then the `team_agent_versions_skill_manifest` check.                  |

Every backfill (0130, 0140) has an upgrade test that migrates a database with rows as the
non-superuser owner. Several migrations were edited in place after review while unreleased
(0132, 0133, 0134, 0135, 0137, 0140: its backfill lookup, 155.6 s to 4.4 s on 20,000 versions), each edit in its own migration-only commit.

## Departures from the briefs

- **Migrations where the brief said none:** 313 (rule set and suspension per scan, rescan runs),
  314 (the Default sync's job table), 316 (personal toggles need `personal_skill_id`), 317
  (publisher marker, stored bytes, nullable requesters with `by_kobe`; no fake system user).
- **317:** the Kobe skill set ships in the server image and is seeded at every server start, not
  by a Helm hook Job from a chart-bundled set (the Job would need the same DB and S3 access and
  code). Kobe's seven now load in every non-exclusive run, count against the cap, are
  blocklistable and shadow a personal skill of the same name (spec SK4/SK6, intended).
- **318:** only team agent versions freeze (`team_agent_versions.skill_manifest`, not a shared
  `agent_versions`): agents name only team and catalog skills, so there are no named personal
  skills to freeze, and personal and gallery versions have no team (open question in the
  ledger; on Chris's gate-review list). Publish freezes the newest loadable version and leaves
  out, with a warning, a skill with none; a rollback restores the frozen versions of the version
  it republishes.
- **Expand/contract (318, review B-S3):** after 0140's Job, previous-release pods can't publish
  team agents (500) until Helm replaces them, and **rolling back across 0137–0140 is unsupported**
  (`docs/install.md`, like 0128): back up first; to go back, reinstall and restore. Run starts and
  reads keep working on old pods.
- **Commit hygiene:** 308 (0129 + 0130) and 311 (0132 + 0133) each landed a generated and a
  custom migration in one commit; later tickets keep them apart.
- **Behaviour changes on purpose:** 310 (a new upload's `evals/` and `kobe.skill.yaml` no
  longer reach the sandbox), 315 (offered team skills are step 3 ahead of personal skills; a
  blocklisted offered skill now shows a notice), 316 (Builders may set On by default; open
  question in its ledger), 318 (approving a newer version no longer changes a published team
  agent until republish; the 315 marker test moved to an On by default skill).

## Follow-ups already recorded for Phases B and C

- **Self-approval server wiring (Phase C, 311):** the database decides the flag; the audit
  `selfApproved`, the notification and the UI flag wait for the Registry review flow. A
  site-console scan override route comes with it (312).
- **Catalog rescans and package storage (KOBE-333):** store maintainer packages, add catalog
  versions (Kobe's have bytes now) to the rescan with a `rule_set` on `registry_versions`; omit
  suspended catalog versions and notify maintainers and installers (313, 315, 317).
- **Promotion refuses legacy versions (KOBE-333):** `legacyProblems(hash)` is there for it (310);
  a promotion of a skill named like a Kobe skill must answer a clear 409, not the 23514 of
  `registry_skills_kobe_names` (317).
- **Code run from `.md` files (rule-set bump):** fenced code a skill tells the agent to run gets
  only the prose and pipe-to-shell rules today; run the script rules on fenced blocks (313).
- **Builders' install UI:** changing an existing install is in the web (316 S4); there is no web
  page yet to install a new catalog skill, for anyone (the Skills page's Catalog tab, Phase C).
- Smaller items left in the ledgers: 312 nits (N1, N3–N5), 313 nits (N1–N3, N6–N8), 315 nits
  (N2, N4–N6), 316 (N5–N7), 317 (count installs in the Required meter; maintainer acts must refuse
  Kobe skills; `by_kobe` on syncs not tied to a Kobe skill in the DB; no retire step for a Kobe
  skill dropped from the set), 318 (personal agents' named team skills are not frozen).

## Merging with the G5 branch (KOBE-422, PR #314)

G5 adds migrations 0128 and 0129 on `main`, so ours renumber. In this worktree, once G5 is on
`origin/main`:

1. `pnpm --filter @kobe/db db:rebase` (clean tree; it stashes our migrations, merges
   `origin/main`, regenerates one generated migration for all our schema changes, then re-creates
   each custom one with its SQL in order: 0130, 0133, 0138, 0140; the hand-written rename 0128
   keeps its SQL and snapshot and is renumbered). On other conflicts resolve, commit the merge,
   then `db:rebase --apply`. Check the result: the rename must still come before the generated
   migration (which names `personal_skill*`), and the customs after it.
2. Update text that names migrations by number (schema comments, `docs/install.md` upgrade
   notes, ledgers) to the new numbers; upgrade tests find their point by SQL markers, not numbers.
3. From the 317 ledger (G5 moves start-up work into `services/server/src/startup/jobs.ts` and
   adds `packages/db/src/startup-seeds.ts` with `startup-seeds.db.test.ts`):
   - add to `STARTUP_SEEDED_ROWS`: `registry_skills` and `registry_versions` with
     `publisher = 'kobe'`; `registry_skill_tags`, `skill_default_syncs` and
     `team_skill_installs` with `by_kobe` (installs: none on a fresh site; an RLS table, read under
     `withTeam` if at all); `audit_log` rows `actor_kind = 'system' AND actor_id IS NULL AND
team_id IS NULL AND action = 'skill.kobe.published'`, and the sync events for Kobe skills
     only (`action IN ('skill.default.synced', 'skill.default.sync_failed',
'skill.default.applied') AND target ->> 'skillId' IN (SELECT id::text FROM
public.registry_skills WHERE publisher = 'kobe')`); bucket objects `<prefix>skills/catalog/*`;
   - move the 317 seed from `index.ts` into `startup/jobs.ts` as `startKobeSeed`, awaited before
     `startDefaultSync` starts and stopped with the other jobs;
   - give the guard test a BlobStore (e.g. `MemoryObjects`), or the seed is skipped and the guard
     sees no 317 rows.
4. Then `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, the unit suites,
   `@kobe/db` and `@kobe/server` `test:db` (the server suite alone), and `@kobe/cli` test:db with
   `KOBE_PG_BIN_DIR=/opt/homebrew/opt/libpq/bin`; CI's `db` job (drizzle-kit check, journal order,
   probes) must stay green.

## Open questions carried (for Chris or the coordinator)

- 309: UTF-16 vs code-point ordering in the canonical zip (kept UTF-16).
- 316: Builders may set On by default (reaches every member).
- 317: rolling upgrade order (servers before the sandbox image), cold-start fetch of seven bundles
  (KOBE-319 should read the k3d trial), e2e changes checked in CI only.
- 318 (Chris's gate review): personal agents don't freeze (an SK28 amendment; "Skill updated"
  markers show the changes). Decided by the coordinator: republish freezes the newest loadable
  version, else leaves the skill out with a warning.
