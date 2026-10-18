# KOBE-313: A7: Rescan on scanner rule-set change

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

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
- **Job (`skills/rescan.ts`):** at start and every 10 min on `server` pods. Lease: a session
  advisory lock plus the per-rule-set row, so one rescan per rule set across replicas; a done
  row makes later ticks a no-op. A pass with unreadable bundles ends `failed` and the next tick
  retries only those (counts accumulate). It rescans personal versions' own scans, then each
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

## Open questions (for Chris or the coordinator)

- Catalog rescans and installer/maintainer notices need stored catalog packages (submission
  ticket) and installs (KOBE-314/315).
- Should suspension emails also become in-app notifications (a protocol kind)?

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/skill-rescan.db.test.ts`: two concurrent `rescanOnce` calls give
  one rescan; a repeat scans nothing; new scans record the current rule set.
- ac-2: same file: an old ELF-as-.png team row (approved) and personal version (Pass) are
  suspended, omitted as `suspended` (`loadSkillFacts`), audited and emailed; a decision lifts
  it. `resolver/resolve.test.ts` "KOBE-313".
- ac-3: same file, Site console route; `apps/web/components/admin/skill-rescans-section.test.tsx`.
