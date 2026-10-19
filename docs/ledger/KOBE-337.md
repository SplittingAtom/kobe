# KOBE-337: C8: Team installs, pins and updates

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

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
  from the running version to a published one.
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
