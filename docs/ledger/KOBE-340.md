# KOBE-340: C11: Deprecate, Withdraw and Revoke

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-315 (`pickCatalogVersion` already applies SK31 to pins), KOBE-81
  (blocklist), KOBE-337 (install rules), KOBE-338 (notifications for skills)
- **Migrations:** 0167 `notifications.skill_semver` and the retirement kinds (generated; the
  contract change is its own commit); upgrade test
  `packages/db/src/skill-retirement-upgrade.db.test.ts`

## What shipped

- **Acts** (`services/server/src/skills/registry/retire.ts`, routes
  `routes/site-skill-retire.ts`, spec §8):
  `POST /v1/site/skills/catalog/:skillId/versions/:semver/{deprecate|withdraw|revoke|unrevoke}`
  `{note?}` and `POST .../catalog/:skillId/deprecate {replacementId?}`;
  `GET .../catalog/:skillId/versions` (what to act on, `mayRetire`). Who: active maintainers and
  Site admins deprecate; Site admins (`site.skills.catalog.manage`) withdraw, revoke, unrevoke.
  Skill reviewers (grant) can't. From-states: deprecate approved; withdraw approved/deprecated;
  revoke approved/deprecated/withdrawn; unrevoke revoked (409 `wrong_state` otherwise).
- **One transaction** (the Registry tx, version row locked): the state, a review event (note;
  `checklist` holds `from` and, for revoke, whether it added the blocklist entry), a site audit row
  (`registry.deprecated|withdrawn|revoked|unrevoked`, `skill.catalog.deprecated`).
- **Revoke** puts the runtime hash on the blocklist in that transaction (`addBlockedInTx`; the
  alias group covers the package hash): run start omits it (resolver), the sandbox fetch refuses it
  even mid-run (`locateBundle` reads the blocklist on every fetch), so it **stops at the next
  fetch in every team**. **Unrevoke** returns to the state it left (approved, deprecated or
  withdrawn) and lifts only an entry its revoke added (`removeBlockedInTx`).
- **Tracking:** unchanged resolver rules (KOBE-315): withdrawn → next highest approved or
  deprecated in range; revoked → within range only; never across majors (latest's range is the
  newest published major).
- **Installs and adds** (`skills/retirement-state.ts`): the team's install list and members' adds
  carry `retirement {kind, semver, replacement}`: "Revoked — choose a version", "Withdrawn —
  choose a version" (a pin on it keeps working), deprecated (with the replacement), suspended.
- **Deprecated skill:** every version installs only for Team admins (`deprecated: true`, the
  warning); Builders 403; no new member adds (`deprecated`); the catalog detail names the
  replacement and offers retiring to maintainers and Site admins (`canDeprecate`).
- **Notices** (`retire-notify.ts`, after commit): in-app to the Team admins of each team whose
  install pins or runs the version (before or after; every install for a whole skill), and to each
  member whose add does (`skill.deprecated`, `skill.version.*` with `skill_semver`). Email: Revoke
  to everyone told plus the maintainers; Withdraw to the maintainers. Each team under its RLS
  (`scanTeams`).
- **Web:** `components/skills/retire-panel.tsx` (each act a version's state allows, confirmed with
  what it does; a note; deprecate the skill with a replacement) in the Site console's catalog
  (**Versions**) and the catalog detail (maintainers); banners on installs and member adds; the
  bell's titles ("sales 2.0.0 was revoked — choose a version").

## Decisions

- Running runs: a run already holding the skill's files keeps them until it ends (spec: "stopped
  at the next fetch"); the next run of the thread starts without it (Pi relaunches on a changed
  skill set), and no sandbox fetches it again.
- Notices go out after the act commits; if writing them fails the act stands (logged) and the
  install banners still say it. Email is best effort, off the request path.
- No un-deprecate (not in SK31); a mistaken deprecation is fixed by a Site admin in the database.
- Kobe-published skills can be withdrawn or revoked by Site admins (emergencies); they have no
  maintainers to email.

## Open questions (for Chris or the coordinator)

- Should Unrevoke email too? It notifies in-app only.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-retirement.db.test.ts`: deprecate (maintainer; outsider and
  Skill reviewer 403; pins keep it; Builder 403, Team admin installs with the warning; member add
  refused), withdraw (Site admins only; within-major tracking 1.2.0 → 1.1.0; a pin keeps 1.2.0
  with "withdrawn"; Move pin to it refused), revoke (latest tracking on major 2 omitted, never
  major 1; "revoked"; agents naming it omitted), unrevoke (back to approved or withdrawn; a block
  it didn't add stays), skill deprecation with a replacement.
- **ac-2** `services/server/src/skill-revoke-fetch.db.test.ts`: two teams' held runs fetch the
  bundle (200), revoke → both fetches 404, the next runs leave it out (`context.omitted`),
  unrevoke → the next runs carry it and fetch 200.
- **ac-3** same DB file: in-app notices per team and member, emails (revoke: installers and
  maintainers; withdraw: maintainers), audit rows with `from`/`to`, `blocklisted`/`unblocked`.
  Web `apps/web/components/skills/skill-retirement.test.tsx`.
