# KOBE-313: A7: Rescan on scanner rule-set change

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent continuing from KOBE-314)

- **Branch state:** `group-skills-a` holds KOBE-307..313, all reviewed (313 review fixes in the
  last two commits). Migrations so far: 0128..0134; 0132/0133/0134 were edited in place while
  unreleased; next free number is 0135. Nothing is pushed; one PR at the end.
- **Conventions:** migration commit = `packages/db/drizzle/*` plus the schema TS it encodes (so
  each commit passes `db:check`); code and tests in a second commit. Edit an unreleased migration
  by removing it (sql, snapshot, journal entry), regenerating with
  `drizzle-kit generate --name <same>`, and restoring the journal `when`. When editing an _earlier_
  migration's snapshot, patch the JSON surgically (key order matters, or the diff explodes).
  Ledgers: one per ticket, decisions + evidence. Reviews land in the session scratchpad as
  `review-<N>.md`.
- **Scanner:** bump `RULE_SET_VERSION` **and** the ordinal `RULE_SET` on every rule change; the
  rescan compares ordinals and only moves rows forward. Scans run through `scanCanonicalZip`
  (worker pool, `skills/scan-pool.ts`; async). Stored verdicts read with `storedVerdict`.
- **Traps:**
  - Team tables (`team_members`, `team_skill_reviews`, `team_skill_versions`) return nothing
    outside `withTeam`: site-level jobs must loop teams.
  - Rebuild `@kobe/db` / `@kobe/skill-scanner` / `@kobe/protocol` (`pnpm --filter … build`) before
    server typecheck or tests: dependants read `dist`.
  - Bash heredocs in this harness turn `\uXXXX` into literal characters: write such regexes
    with the Edit tool or build them from `chr(92)`.
  - The full server db suite flakes with timeouts under load (unrelated files); rerun singly.
  - `pnpm db:check` fails on any uncommitted drizzle change; use `drizzle-kit generate` and look
    for "No schema changes" before committing.

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-311, KOBE-312 (same branch)

## Plan

Migration alone (`0134_skill_rescans`, generated, no backfill), then the rescan job, the
`suspended` resolver notice, the Site console section and tests.

## Decisions

- **Departure (migration):** the brief says no migration; the coordinator asked for the rule set
  per scan. `team_skill_reviews` and `personal_skill_scans` gain `rule_set_version` (null = an
  older rule set, rescanned) and `suspended_at`; `registry_versions.suspended_at`; site-wide
  `skill_rescan_runs` (one row per rule set: status, counts, up to 100 suspended ids/slugs).
  `personal_skill_scans` gains UPDATE for the app role (rescans update in place).
- **Job (`skills/rescan.ts`, `rescan-rows.ts`, `rescan-cache.ts`, `rescan-notify.ts`):** at
  start and every 10 min on `server` pods. Lease: a session advisory lock plus the per-rule-set
  row. A pass with unreadable bundles ends `failed` and the next tick retries only those. It rescans personal versions' own scans, then each
  team's review rows under that team's RLS (team versions and personal versions reviewed there),
  from the verified package zip (or runtime zip), caching scans per stored object.
- **Suspension (SK32):** an `approved` review row that turns Block (from non-Block) goes back to
  `pending` with `suspended_at`; the team resolver omits the skill as `suspended` (an older
  approved version does not take its place), and any decision clears it. A personal version that
  was Pass and turns Block gets `suspended_at` on its scan: it needs each team's approval and is
  omitted as `suspended` until then. Audited `skill.rescan.suspended` (team or site, ids and slug).
- **Notifications:** one email per pass to each author (uploader or owner) and the affected
  teams' admins (slugs and versions, never findings), best effort and logged. In-app
  notifications are schedule-only in the protocol; adding a kind is a contract change left out.
- **Protocol:** `context.omitted` reason `suspended` (additive); web label added.
- **Site console (ac-3):** `GET /v1/site/skill-rescans` (`site.blocklist.manage`) and a
  "Rescans after scanner updates" section on the Skill blocklist page.
- **Catalog versions:** not rescanned yet: no catalog bundle is stored before the Registry
  submission flow. `registry_versions.suspended_at` is ready for it.

- **Review fixes (review-313):**
  - Rule sets compare by an ordinal (`RULE_SET`, integer `rule_set` columns; 0134 regenerated):
    stale = null or lower; writes re-check under `FOR UPDATE`; a pod whose rule set is below the
    newest `skill_rescan_runs.rule_set` does nothing. `done` is not terminal: every tick runs a
    pass (one cheap query per team when nothing is stale), so rows old pods write during a
    rolling deploy are rescanned.
  - The suspend decision is made on the locked row (status read under `FOR UPDATE`), so a
    review decision that lands mid-rescan is honoured, not skipped; a pass with rows still stale
    at its end leaves the run `running` (or `failed` when bundles were unreadable).
  - Scan cache: LRU bounded at 16 MiB of results (`rescan-cache.ts`).
  - Progress and suspensions are written to the run row per batch; suspension emails use the
    rows as an outbox (`suspension_notified_at`), sent per batch and again by any later pass.
    Authors who left the team are not emailed team details; teams are read sequentially.
  - A bundle failing its integrity check is logged at error with its ids and key, and stored as
    Block `bundle-integrity` (an approved version is suspended); a missing object or failed scan
    is logged with context and retried.
  - Scans run in worker threads (`skills/scan-pool.ts`: 2 at once, 30 s timeout → Block
    `scan-incomplete`); `scanCanonicalZip` is now async.
  - Scanner (rule set 4, `2026.10.18.4`): script rules on every non-Markdown text file; run
    references (for Markdown) are case-insensitive, strip trailing punctuation and doubled
    slashes, and read long lines in windows; the two unbounded `[^|\n]*` gaps are `{0,500}`.
- **Follow-ups recorded for later tickets:**
  - **KOBE-318 (A12, frozen versions):** a frozen local version in a published agent must still
    check the team review status and `suspended_at`, not only the frozen hash; otherwise a
    suspended version keeps running in every agent that froze it. KOBE-319 (Gate A) should verify
    a frozen agent run omits a suspended version.
  - **KOBE-333 (C4, catalog packages):** store catalog packages and add them to the rescan, with a
    `rule_set` on `registry_versions`; KOBE-315/337 must omit `suspended_at` catalog versions as
    `suspended` and notify maintainers and installers.
  - Nits not done: suspension when an already-Block approved row gains new Block rules (N1);
    personal-scope rows rescanned right after their personal scan (N2); run-row copies of slugs
    on team/user erasure (N3); an UPDATE guard trigger on `personal_skill_scans` (N6); offered
    skills' `suspended` notice and `startedAt` on reopen (N7); a size cap on package reads (N8).

## Open questions (for Chris or the coordinator)

- Should suspension emails also become in-app notifications (a protocol kind)?

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/skill-rescan.db.test.ts`: two concurrent `rescanOnce` calls give
  one rescan; a repeat scans nothing; new scans record the current rule set; rows written after
  `done` are rescanned; an older rule set never rescans rows down; integrity failures block and
  suspend; unsent suspension emails go out on the next pass. `skills/scan-pool.test.ts`,
  `skills/rescan-cache.test.ts`; scanner `bypasses.test.ts` "A-S1".
- ac-2: same file: an old ELF-as-.png team row (approved) and personal version (Pass) are
  suspended, omitted as `suspended` (`loadSkillFacts`), audited and emailed; a decision lifts
  it. `resolver/resolve.test.ts` "KOBE-313".
- ac-3: same file, Site console route; `apps/web/components/admin/skill-rescans-section.test.tsx`.
