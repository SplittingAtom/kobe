# KOBE-336: C7: Catalog tab: browse, search, detail and egress check

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-334/335 (approved versions, authoritative scorecard), KOBE-314/316
  (installs, member adds, blocks), KOBE-39 (egress requests, D28)
- **Migrations:** none

## What shipped

- **Server** (`skills/catalog-browse.ts`, `routes/skill-catalog.ts`, any team member,
  `team.read`):
  - `GET /v1/skills/catalog?q=&tag=&sort=name|updated|teams`: catalog skills with an approved,
    unsuspended version (archived skills left out), each with summary, publisher, topic tags,
    latest version and verdict, the authoritative card's numbers (pass rate, lift, cases), teams
    installed under the minimum-count rule (1–2 teams: `"few"`), and this team's state:
    installed (version, pin, access), added by me, blocked. Search is Postgres full-text
    (`english`, name with `-` as spaces plus summary, `websearch_to_tsquery`); tag filter by
    topic tag; `tags` lists every active topic tag for the filter.
  - `GET /v1/skills/catalog/:skillId`: the card plus SKILL.md (body, frontmatter dropped, from
    the runtime zip), the package's files and sizes, published versions with state and
    changelog, the authoritative scorecard (numbers; the re-run's facts left out), license,
    maintainers' names (no emails), this team's agents whose current version names it, and the
    egress check per host: `enabledHere` (team_egress and in the ceiling) and `inCeiling`.
  - Nothing reviewers-only reaches browsers: no `source`, provenance, submitter or notes.
  - Teams installed is counted with `scanTeams` (each team under its own RLS), cached 5 min.
- **Web:** the Skills page's **Catalog** tab (`catalog-tab.tsx`): search, topic and sort, cards
  with verdict, eval pass rate, teams, topics and this team's state; the detail page
  `/me/skills/catalog/[id]` (`catalog-detail-page.tsx`): capabilities with "Needs example.com —
  not enabled here → Request access to example.com" (the D28 `POST /v1/egress/requests`, which
  emails the Team admins), "not allowed on this Site" for hosts outside the ceiling, the
  authoritative scorecard, rendered SKILL.md, versions and changelogs, files, license,
  maintainers and the team's agents.

## Decisions

- Teams installed is shown (with "few") now, from a cached live count; KOBE-339's nightly
  aggregates can replace the source.
- The detail shows the latest approved version; older versions are listed with changelogs (no
  per-version SKILL.md yet).
- Install / Add for me buttons are KOBE-337/338's.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-catalog.db.test.ts` "browse and search": approved skills
  only, full-text search (incl. stemming), tag filter, both together, bad sort 400; "shows this
  team's state…": sort by teams, latest version, score, `few`, installed / added by me / blocked,
  no reviewer fields. Web `apps/web/components/skills/catalog.test.tsx` (cards, search, topic,
  sort), `skills-page.test.tsx`.
- **ac-2** same DB file "detail": egress `enabledHere` / `inCeiling` per host; Request access for
  example.com emails the Team admin. Web: Request access posts the host; "not allowed on this
  Site".
- **ac-3** same DB file: versions with changelogs, the authoritative scorecard without `rerun`,
  SKILL.md, files, license, maintainers' names (no emails), the agent naming it; 404 for a skill
  never approved.
- Runs: typecheck, lint, format:check, license:check, db:check; unit tests (all packages; the
  machine's load average was ~48, so timing-bound tests were rerun alone); server DB 20 files
  199/199; db probe and upgrade tests 680/680.
