# KOBE-337: C8: Team installs, pins and updates

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff for KOBE-338 onward (a fresh agent continues)

- **Branch:** `group-skills-c` in `../Kobe-skC`, from main 16155c46; ~95 commits; nothing pushed;
  one PR for Phase C (Chris's gate review after it; KOBE-342 is not ours). Done and reviewed:
  KOBE-442, 330–337 (ledgers in `docs/ledger/`; reviews in the coordinator's scratchpad,
  `review-*.md`). At PR time run `pnpm --filter @kobe/db db:rebase` (G10 PR #317 and MCP Apps add
  migrations too).
- **Migrations on this branch** (after `db:rebase` on main 05a92778): 0153 every schema change
  of Phase C (generated, one migration: drafts sync, `teams.registry`, `team_members.added_via`,
  promotion requests, `from_conversation`, review states and the confirmer CHECK, eval subject
  `registry`, `team_skill_requests`, skill notifications, `skill_usage_snapshots`, `undeprecated`),
  then custom: 0154 synced-rev backfill, 0155 dedicated-Registry guard, 0156 promotion requests
  RLS, 0157 `from_conversation` backfill, 0158 review guard for the confirmer, 0159
  `team_skill_requests` RLS. Upgrade tests in `packages/db/src/*-upgrade.db.test.ts`. The
  scanner's rule set is 5 (rescans).
- **Decisions in force (coordinator / Chris):**
  - Registry team: a dedicated team Kobe creates; Skill reviewers join it via the grant; Site
    admins may hold the grant from another admin; a self-grant only on a single-admin Site
    (flagged `selfGranted`).
  - Separation of duties for every act that weighs a version (Approve, acknowledging Caution
    findings, starting or cancelling re-runs): never the submitter or the confirming Team admin,
    except the single admin (DB flags `self_approved`, 0158).
  - Approve fails closed: Registry team, row lock, authoritative card (this package, current
    Registry team and Site judge alias/model, ≤ 30 days, not all errored), blocklist, Block
    override with a note (Site admins), every Caution finding acknowledged, live skill, active
    submitter who may still submit (catalog skill row locked).
  - Names: free once no submission is open (reject from any open state, or the author retracts).
  - Re-runs: in the Registry team as the reviewer, Site judge only, every run kept in the
    history; the card is the latest completed run's.
  - Egress reachability anywhere server-side uses `decideEgress` + the proxy's loaders
    (`egress/host-standing.ts`).
  - Installs: Roll back or Move pin back on a tracking install pins it (audited `pinModeFrom`,
    console notice); Roll back never rolls forward; blocklisted, withdrawn, revoked never offered.
- **KOBE-338 (member adds, blocks, requests):** `member_skill_enablements` (catalog adds carry
  `version_id`, `pin_mode`), the DB trigger refusing adds of a blocked skill and the block trigger
  removing adds (0133), `readCatalogSwitches().membersMayAdd`, the resolver's member adds
  (`runs/catalog-facts.ts`), and `/v1/me/skills/enablements` already exist; build `PUT/DELETE
/v1/me/skills/adds/:skillId {version, pinMode}` (refuse withdrawn/revoked/blocklisted like
  `installCatalogSkill`), the team block/unblock routes (Team admins, audited), the console list of
  member adds, Request for team (notify Team admins like egress requests' outbox), and the catalog
  card/detail buttons (`catalog-tab.tsx`, `catalog-detail-page.tsx`; `state.addedByMe/blocked`
  are there).
- **KOBE-339 (usage signals):** `catalog-browse.ts` shows teams installed from a cached
  `scanTeams` count with the "few" rule (`MIN_TEAMS` in `catalog-admin.ts`); replace with the
  nightly aggregates; run skill uses are on `runs.skills_used` (KOBE-297), thumbs from KOBE-275.
  Fixed windows, no team names, probe test for cross-team endpoints.
- **KOBE-340 (deprecate/withdraw/revoke):** admin-only actions are already in
  `skillReviewAllows` (`withdraw`, `revoke`); the review events enum has `deprecated`,
  `withdrawn`, `revoked`, `unrevoked`; the resolver (`resolver/catalog-pins.ts`) already applies
  SK31 to pins; `addBlockedInTx` for revoke; decisions run in `inRegistryTx` (Registry team
  context). Install updates/diff already exclude withdrawn/revoked/blocklisted targets.
- **KOBE-341 (external scanner):** `site_skill_settings.scanner.external` (off); Job in the
  Registry team's namespace, no secrets, no egress unless configured; findings advisory (Caution
  at most). Licence check first; stop for Chris if the scanner isn't in the family.
- **Known open items:** no `registry.version.updated` stream event; budget-cap and
  personal-connector re-run tests rely on shared code (judged not required); C4-L1/L2/L4 from
  review-c2 (requests outliving a demoted requester, orphan catalog blobs, preview cost) remain.

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-314/315/316 (installs, pin resolution `pickCatalogVersion`, the install
  rules), KOBE-335 (authoritative cards), KOBE-336 (catalog detail)
- **Migrations:** none

## What shipped

- **Already there (Phase A, kept):** `PUT /v1/team/skills/installs/:skillId` with version, pin
  mode and access; Builders only while "Builders may install catalog skills" is on, never
  Required or deprecated; withdrawn, revoked and suspended versions refused; blocks and name
  clashes refused; uninstall of a Default records the opt-out; the resolver's pin semantics.
- **Updates** (`skills/install-updates.ts`, `GET .../installs/:skillId/updates`, any member):
  the pinned version, the version runs load now (`pickCatalogVersion`, as run start), newer
  approved versions newest first with changelog, `major`, whether the pin takes it by itself
  (`automatic`: within major its own major only, latest any, pinned none) and the eval delta from
  the authoritative cards; and the Roll back target.
- **Diff** `GET .../installs/:skillId/diff?to=<semver>`: the file diff (the bounded review diff)
  from the running version to an approved or deprecated one (never withdrawn, revoked or
  blocklisted).
- **Move pin** `POST .../move {version}` and **Roll back** `POST .../rollback`: the install's
  version changes, pin mode and access kept, through `installCatalogSkill` (every install rule:
  Builders, withdrawn/revoked, blocks), audited `skill.catalog.pin_moved` /
  `skill.catalog.rolled_back` (from, to) instead of `configured`. Roll back returns to the version
  the install ran before the change that set its current one, found in the team's own audit rows
  (no migration); 409 `no_rollback` when there is none.
- **Web:** the catalog detail's **Install in this team** form (version: approved or deprecated
  with a warning; pin; access, Required only for Team admins); the team console's install rows get
  **Updates** (what runs, each newer version with changelog, eval change and its diff, the major
  label and "Track within major never takes a new major", Move pin, Roll back).

## Decisions

- Roll back reads the team's own audit log rather than a new column: the log is the record of
  each change, and the ticket adds no migration.
- Update available lists versions newer than what runs; those the pin takes by itself are marked
  so (Move pin is offered for the others).
- Members see updates (published content); only installers move pins.

## Review fixes (review-337.md)

- **M1** (coordinator) a move back on a tracking install pins it; audited with `pinModeFrom`,
  `runningFrom`, `runningTo`; `pinnedBy` on the install list and the console notice; Roll back's
  target starts from what runs. Tests for within major and latest.
- **L1** a second Roll back skips the change it undid (409 `no_rollback` when nothing is left);
  **L2** diffs target approved/deprecated only; **L3** blocklisted versions neither offered nor
  installable; **L4** pin mode and access read under the install lock; **L5** the Install form
  names hosts not enabled here; **L6** the escaped raw view escapes backslashes, UTF-8 validated
  by hand.

## Open questions (for Chris or the coordinator)

- The "Skill updated" thread marker on a version change is the resolver's (KOBE-315); not
  re-tested here.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-installs-updates.db.test.ts` "install with each pin and
  access mode": pinned 1.0.0 → runs 1.0.0, within major → 1.1.0 (1.2.0 withdrawn), latest →
  2.0.0 (run start's `loadCatalogFacts`); Required loads as required, Hidden and Available not
  offered; a Builder can't set Required.
- **ac-2** same file "updates, Move pin and Roll back": updates with changelog and eval delta,
  the diff, Move pin to 2.0.0 and Roll back, each audited with from/to; moving to a withdrawn
  version refused; no Roll back target → 409. Web
  `apps/web/components/admin/install-updates.test.tsx`, `components/skills/catalog.test.tsx`.
- **ac-3** same file: within major never takes 2.0.0 (offered as `major`, not automatic);
  withdrawn 1.2.0 and revoked 0.9.0 not installable.
- **ac-4** same file: team B's pinned install and its runs stay at 1.0.0 through team A's install,
  move and roll back; every move/rollback audit is team A's.
- Runs: typecheck, lint, format:check, license:check, db:check; unit tests (db 641, server 2091,
  web 2001, egress-proxy 98, skill-scanner 152); server DB 14 files 113/113; probe 657/657.
