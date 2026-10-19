# KOBE-338: C9: Member adds, team blocks and requests

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-316 (`member_skill_enablements`, the 0133 block triggers, the switch),
  KOBE-315 (the resolver's member adds), KOBE-336/337 (catalog detail, install rules)
- **Migrations (review):** 0153 `team_skill_requests` (generated), 0159 its RLS (custom), 0153
  `notifications.skill_id` + kind `skill.member_add.blocked` (generated); upgrade test
  `packages/db/src/skill-requests-upgrade.db.test.ts`; probe fixture added

## What shipped

- **Add for me** (`skills/member-adds.ts`, `routes/me-skill-enablements.ts`):
  `PUT /v1/me/skills/adds/:skillId {version, pinMode}`, `DELETE` the same, `GET /v1/me/skills/adds`
  (any member, active team). The row is the member's `member_skill_enablements` row with a version;
  the resolver (`runs/catalog-facts.ts`) loads it in step 3 of that member's runs in that
  team only. Refused: switch off (403 `adds_off`), blocked (409), installed in any mode
  (409 `installed`, review M3), a team skill of that name (`name_clash`), withdrawn, revoked,
  suspended or blocklisted versions (`not_installable`), deprecated (`deprecated`: a Team admin's
  override, SK31; keeping a version one already has is allowed), unknown (404). Audited
  `skill.member_add.added|changed|removed`. Takes the member's enablement, install and team skill-name locks.
- **Blocks** (`skills/team-blocks.ts`, `routes/team-skill-blocks.ts`, Team admins):
  `PUT|DELETE /v1/team/skills/blocks/:skillId`, `GET .../blocks`. The block removes the adds
  and notifies their members in-app (review N1); the answer and audit `skill.catalog.blocked` carry
  `addsRemoved`; `skill.catalog.unblocked`. Repeating a block changes nothing (`changed: false`).
- **Member adds in the console:** `GET /v1/team/skills/member-adds` (Team admins): member, skill,
  version, pin and the version it runs now.
- **Request for team** (`skills/install-requests.ts`): `POST /v1/skills/catalog/:skillId/request`
  (any member; a catalog-visible skill not blocked here; installed, it asks for a change). Audited
  `skill.catalog.team_requested`; the team's active admins are emailed after commit (background,
  best effort; requester, skill and team, link to the console). Limits and storage: see review
  fixes. Console: `GET /v1/team/skills/install-requests` (open requests of the last 30 days),
  `POST .../install-requests/:skillId/dismiss` (`skill.catalog.team_request_dismissed`).
- **Catalog:** the page carries `membersMayAdd`; cards `state.myAdd` (version, pin);
  `addedByMe` now counts only an add with a version (not an on/off toggle of an install); detail
  `membersMayAdd`, `canBlock`.
- **Web:** the catalog detail gets **Add for me** (approved versions, pin; Save/Remove my add;
  hidden while the switch is off or the team installed it), **Request for team** and, for Team admins, **Block in this team** (confirmed) / **Unblock**
  (`catalog-member.tsx`). The team console Skills page gets **Members and the catalog**
  (`member-adds-section.tsx`): requests (open in catalog, Dismiss), member adds, blocks (Unblock).

## Decisions

- Blocks and the lists need `team.skills.installs.manage` (Team admins); adds and requests
  `team.read` (every member). **Blocking an installed skill is refused** (409 `installed`): the
  Team admin uninstalls first, so a block never silently switches an install off.
- **Deprecated versions are not a member's to add** (SK31: a Team admin's override).

## Review fixes (review-338.md; coordinator decisions)

- **D1** requests live in `team_skill_requests` (team table, FORCE RLS, one row per member and
  skill: `first_at`, `last_at`, `dismissed_at`); the audit rows stay the record. **M1** a repeat
  within a day counts from the last ask, dismissed or not (`alreadyRequested`, no email). **M2** at
  most 5 skills per member a day: 429 `request_limit` "You can ask for up to 5 skills a day".
  **L2** deactivated members leave the list (rows cascade with the membership). **L3** a new
  install (`installAnswers`, also the Default sync and Reinstall) or a block deletes the skill's
  requests. Rows older than 30 days are purged when the console lists them.
- **M3** a member can't add a skill the team installed, in any mode (409 `installed`). Installing
  turns members' adds into their "on" choice for the install (they keep it at the team's pin);
  the resolver never loads an add of an installed skill (left rows count as "on"). Installed,
  **Request for team** asks for a change ("now 1.0.0" in the email, `installed` in the console).
- **N1** a block deletes the adds itself (`DELETE … RETURNING user_id`, the 0133 trigger stays as
  the backstop) and inserts one in-app notification each, `skill.member_add.blocked` with
  `skill_id` (contract: `schedule_id` nullable, `skill_id`/`skill_name` for this kind); the store
  lists it, the bell says "A Team admin blocked X in this team; your Add for me was removed" with
  **Open in the catalog**. No email. **L6** `addsRemoved` is that delete's count.
- **L1** Add for me takes the team skill-name lock. **L4** a member's toggle of an install clears
  an add's version. **L5** the email quotes the display name with the member's address.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- Review: same DB file (installed in every mode refused; install converts adds, L4 toggle;
  block notifies only the member whose add went; dismiss doesn't reset the day; the cap; a
  deactivated requester hidden; install answers requests; a change request when installed);
  `skill-resolver-gates.db.test.ts` (an add never beats the install); web
  `components/chat/notification-bell.test.tsx`, `lib/notifications/format.test.ts`.
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
