# KOBE-338: C9: Member adds, team blocks and requests

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-316 (`member_skill_enablements`, the 0133 block triggers, the switch),
  KOBE-315 (the resolver's member adds), KOBE-336/337 (catalog detail, install rules)
- **Migrations:** none

## What shipped

- **Add for me** (`skills/member-adds.ts`, `routes/me-skill-enablements.ts`):
  `PUT /v1/me/skills/adds/:skillId {version, pinMode}`, `DELETE` the same, `GET /v1/me/skills/adds`
  (any member, active team). The row is the member's `member_skill_enablements` row with a version;
  the resolver (`runs/catalog-facts.ts`, unchanged) loads it in step 3 of that member's runs in that
  team only. Refused: switch off (403 `adds_off`), blocked (409), installed Required or Hidden
  (409 `required`/`hidden`), a team skill of that name (`name_clash`), withdrawn, revoked,
  suspended or blocklisted versions (`not_installable`), deprecated (`deprecated`: a Team admin's
  override, SK31; keeping a version one already has is allowed), unknown (404). Audited
  `skill.member_add.added|changed|removed`. Takes the member's enablement lock and the install lock.
- **Blocks** (`skills/team-blocks.ts`, `routes/team-skill-blocks.ts`, Team admins):
  `PUT|DELETE /v1/team/skills/blocks/:skillId`, `GET .../blocks`. The 0133 trigger removes the
  adds in the block's transaction; the answer and audit `skill.catalog.blocked` carry
  `addsRemoved`; `skill.catalog.unblocked`. Repeating a block changes nothing (`changed: false`).
- **Member adds in the console:** `GET /v1/team/skills/member-adds` (Team admins): member, skill,
  version, pin and the version it runs now.
- **Request for team** (`skills/install-requests.ts`): `POST /v1/skills/catalog/:skillId/request`
  (any member; a catalog-visible skill not installed or blocked here). Audited
  `skill.catalog.team_requested`; the team's active admins are emailed after commit (background,
  best effort; name of requester, skill and team, link to the console). Once a day per member and
  skill (`alreadyRequested`, no email). Console: `GET /v1/team/skills/install-requests` (open
  requests of the last 30 days per skill, since the last dismissal, not installed or blocked),
  `POST .../install-requests/:skillId/dismiss` (`skill.catalog.team_request_dismissed`).
- **Catalog:** the page carries `membersMayAdd`; cards `state.myAdd` (version, pin);
  `addedByMe` now counts only an add with a version (not an on/off toggle of an install); detail
  `membersMayAdd`, `canBlock`.
- **Web:** the catalog detail gets **Add for me** (approved versions, pin; Save/Remove my add;
  hidden while the switch is off or the team installed it Required/Hidden), **Request for team**
  (when not installed) and, for Team admins, **Block in this team** (confirmed) / **Unblock**
  (`catalog-member.tsx`). The team console Skills page gets **Members and the catalog**
  (`member-adds-section.tsx`): requests (open in catalog, Dismiss), member adds, blocks (Unblock).

## Decisions

- **No migration for requests:** a request is the team's own audit row (like Roll back's target in
  KOBE-337), the email is best effort (like the Registry's review emails), and the console list is
  the durable record. The action names avoid "install" (a legacy audit scope word the taxonomy
  test reserves).
- **Blocking an installed skill is refused** (409 `installed`): the Team admin uninstalls first
  (a Default records the opt-out), so a block never silently switches an install off.
- **An add of an installed skill** (Available or On by default) is allowed and wins for that member
  (the resolver already prefers the member's own version); removing it returns them to the
  install's default. One row per member and skill, so an add replaces their on/off toggle.
- **Deprecated versions are not a member's to add** (SK31: blocked for new installs; a Team admin's
  override).
- Blocks and the lists need `team.skills.installs.manage` (Team admins); adds and requests
  `team.read` (every member).

## Open questions (for Chris or the coordinator)

- Members whose adds a block removed are not told (the block is audited with the count). An
  in-app notice would need a notifications kind (migration).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-member-adds.db.test.ts` "Add for me": run start's
  `loadCatalogFacts` loads the add for that member in team A only (not another member of A, not the
  same member in team B); within major takes 1.1.0; refusals (withdrawn, revoked, deprecated,
  unknown, Hidden, Required); console list to Team admins only, team B sees none; remove, audited.
- **ac-2** same file "the team switch and blocks": switch off → `membersMayAdd: false`, 403
  `adds_off`, existing add stops loading (team B unaffected); block removes the add
  (`addsRemoved: 1`), refuses new ones, card blocked here only, member 403, unblock, installed
  skill refused. Web `apps/web/components/skills/catalog-member.test.tsx` (switch off hides Add for
  me; blocked offers neither; Block/Unblock).
- **ac-3** same DB file "Request for team": team A's admin emailed once (not team B's admin, not
  members), repeat within a day not re-sent, console list with count, Dismiss, installed/blocked/
  unknown refused. Web: Request for team, console requests and Dismiss.
- Runs: typecheck, lint, format:check, license:check; unit tests all packages (skill-scanner's
  size-cap test timed out at load ~60, passes alone); server DB 9 files 89/89; probe 657/657.
