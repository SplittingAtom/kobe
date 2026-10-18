# KOBE-315: A9: Resolver v2: Required, installs, pins and Skill updated markers

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent continuing from KOBE-316)

- **Branch state:** `group-skills-a` holds KOBE-307..315 plus KOBE-423 (backup key columns). The
  315 review fixes are in (0135 edited in place, then code; see "Review fixes"), waiting for
  re-review. Migrations run 0128..0135; the next free number is 0136. Nothing is pushed.
- **Conventions and traps:** as in the KOBE-313 handoff. Also:
  - After any audit event or schema change, rebuild `@kobe/db` before typechecking the server.
  - `UPDATE_OPENAPI=1 npx vitest run src/openapi/document.test.ts` regenerates
    `services/server/openapi.json` when markers or events change.
  - The KOBE-255 test forbids "install" in audit action names.
  - `site-rename-migration.db.test.ts` lists objects with "install" in their names.
- **For 316:** `team_skill_settings` has `members_may_add_catalog` (read by the resolver) and
  `builders_may_install_catalog` (unused yet: 316 adds the setting route and lets Builders install
  when it is on). `team_skills.access` is what the resolver reads, through
  `teamSkillAccess` in `runs/resolver-input.ts`. Members' toggles are rows in
  `member_skill_enablements`: `team_skill_id` set, `enabled` true or false. Personal skill toggles
  are not read yet.
- **For 317:** catalog versions have no stored bundle. `bundleRefsWithGaps` (`skills/materialize.ts`)
  reports them as `unavailable`. 317 stores the bytes and adds a catalog branch to `sizesByHash`
  and `locateBundle`.
- **For 318:** named local skills still resolve to the newest approved version
  (`teamSkillStates`). Frozen versions go there.

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-311, KOBE-314 (same branch)

## Plan

No migration. The plan: a pure pin picker, then the resolver in SK27 order, then the loaders
(catalog installs, member choices, team-local access), run records with semver, the
`thread.skill_updated` event and markers, the install route with the name-clash rule, and the
web marker and badge.

## Decisions

- **Order (`resolver/resolve.ts`):**
  1. Required: team skills first, then installs.
  2. Named: local skills first, then catalog skills at the install's pin.
  3. Team skills and installs that are On by default or that the member turned on, then the
     member's own adds.
  4. Personal skills.
  - Names are deduplicated: the earlier entry wins. In steps 1–3 a duplicate is dropped
    silently. A personal skill hidden by step 1 or 2 is `shadowed_by_agent`; one hidden by step 3
    is the new reason `shadowed`.
  - Exclusive agents stop after step 2. Required still loads, and Required omissions still show.
  - The cap of 64 counts in this order, so Required counts first.
  - Within steps 1 and 3, each kind is sorted by name.
- **Intended change from today:** offered team skills (KOBE-297) are now step 3, ahead of
  personal skills.
  - Where an offered and a personal skill share a name, the offered one wins.
  - A blocklisted offered skill now gives a `blocklisted` notice instead of vanishing silently.
  - Two older tests in `resolve.test.ts` were changed to match.
- **A blocked skill keeps its name:** a blocklisted Required or named skill still holds its
  name, so a personal or installed skill with the same name never stands in for it. This was
  today's behaviour, and the parity test caught its loss.
- **Pins (`resolver/catalog-pins.ts`, SK31):**
  - `pinned` loads exactly that version. `within_major` loads the highest runnable version in the
    install's major. `latest` loads the highest runnable version of any major.
  - Deprecated versions keep working.
  - Withdrawn versions: a pinned install keeps working; a tracking install moves to the next
    version in range.
  - Revoked versions are omitted as `revoked`. A tracking install moves within its range only,
    never across majors.
  - Suspended versions are omitted as `suspended`, and no older version takes their place. This
    matches 313.
- **Name lookup:** if the team has a local skill with the agent-named name, the local skill is
  used. Otherwise, if a catalog skill has that name, it resolves through the team's install, or
  is omitted as `not_installed`. A name that is neither keeps today's `not_approved`.
- **Member choices (`runs/catalog-facts.ts`):**
  - A `member_skill_enablements` row with a version is an "Add for me", and uses its own pin.
  - A row without a version turns an Available install on or an On by default install off.
  - Hidden installs load only for agents that name them.
- **Team-local access:** the resolver reads `team_skills.access` (Required, On by default with
  the member's toggle, Available when turned on) instead of `offer_to_all`. The two are kept in
  step (reach.ts), so today's behaviour is unchanged (parity test). Archived skills load only when
  an agent names them.
- **Suspended and blocked never load on any path:**
  - The blocklist covers each version's runtime and package hash (`SkillRef.aliases`) through
    `blockedAmong`, including alias groups.
  - `locateBundle` now also refuses a hash whose version is suspended: a team review row, a
    catalog version, or a personal scan this team hasn't approved since. So a fetch mid-run
    stops too.
- **Run record (ac-2):** `runs.skill_refs` gains `semver`, and `source` can now be `catalog`
  (jsonb, type change only).
  - The markers return `semver` on skill uses, and the badge reads "Used skill: name 1.4.3".
  - The sandbox frame (`skill_bundles`) is unchanged, so older agents keep working.
- **Skill updated (ac-3):**
  - At run start, each skill is compared with the thread's newest earlier started run that had
    it (last 20 runs).
  - A changed version appends `thread.skill_updated` `{thread_id, skills: [{name, from, to}]}`
    right after `run.started` (protocol, additive).
  - `GET /v1/threads/{id}/markers` returns `skill_updates`, worked out from `runs.skill_refs`,
    which outlive the event stream.
  - The web shows "Skill updated: x 1.4.2 → 1.4.3" above the run's prompt and reloads the
    markers when the event arrives.
- **Install route (name clash):**
  - `PUT /v1/team/skills/installs/{skillId}` takes `{version, pinMode, access}` and needs
    `team.skills.installs.manage` (Team admin).
  - It refuses with 409 `name_clash` while an unarchived team skill has the same name.
  - Withdrawn or revoked versions get 409 `not_installable`. A deprecated version installs with
    `deprecated: true`.
  - It clears a Default opt-out. A change to pin mode or access marks the install touched.
  - Audited as `skill.catalog.configured`, including the previous values.
- **Catalog bytes:** no catalog bundle is stored before 317, so a resolved catalog skill is
  omitted as the new reason `unavailable` (logged), and the run still starts.
- **Protocol (additive):** the `context.omitted` reasons `not_installed`, `revoked`, `shadowed`
  and `unavailable` (web labels added), and the event `thread.skill_updated`. `openapi.json` was
  regenerated.

## Review fixes (review-315, review-314 nits)

- **S1 team gates (`catalog-facts.ts`):** installs and member adds of a skill in
  `team_skill_blocks` never load (named: `not_installed`), whatever rows are left. Member adds load
  only while `team_skill_settings.members_may_add_catalog` is on (default on) and never for a
  Hidden install; a disallowed add is ignored. The install PUT and Reinstall refuse `blocked`.
- **S2:** every step-1/2 omission (Required: revoked, suspended, not_approved; named: not_installed,
  revoked, suspended, not_approved) claims its name, so no personal or step-3 skill stands in
  (`shadowed_by_agent`). N1: suspended Required / On by default team skills are reported.
- **S3:** Track latest follows the newest published major; revoked or withdrawn there never drops
  back to an older major.
- **S4:** a new team skill whose slug is an installed catalog skill's name is refused (409
  `name_clash`). Named resolution: a team skill wins unless the team installed the catalog skill
  and its own is archived or was never approved.
- **S5:** any PUT change (version too) marks the install touched and origin `team`; suspended
  versions are `not_installable`. Deprecated still installs with `deprecated: true` (no ack flag).
- **S6:** runs with no agent load the team's Required skills (and their notices), nothing else.
- **Default sync (coordinator):** a team with its own unarchived skill of the name is skipped,
  audited per team as `skill.default.applied` `change: name_conflict`, counted in
  `skill_default_syncs.name_conflicts` (masked like the other team counts). Reinstall refuses
  `name_clash`. Migration 0135 edited in place (also the two catalog switches).
- **N-314a:** `/default-syncs` shows no counts until a job is done or failed. **N-314b:** an `add`
  installs the Default's current major.
- Also N7 (catalog names need a published version) and N8 (dead `offeredSkillNames`). The parity
  test's generator was seeded by the clock (every fixture identical); it now seeds by label and a
  second family (name clashes, over the cap) checks D1–D4 exactly. Not done: N2, N4, N5, N6.

## Open questions (for Chris or the coordinator)

- Builders may install catalog skills: the column exists (0135); 316 wires the setting.

## Evidence (acceptance criteria → test or command output)

- ac-1: `resolver/resolve-order.test.ts` covers order, dedupe, exclusive with Required, the cap
  with Required first, and every omission reason. `resolver/catalog-pins.test.ts` covers each pin
  mode, deprecated, withdrawn, revoked and suspended. `skill-resolver-v2.db.test.ts` covers the
  same against the database.
- ac-2: `skill-resolver-v2.db.test.ts`: `skill_refs` holds `{name, source, sha256, semver}`.
  `apps/web/components/chat/skill-badge.test.tsx`: "Used skill: pretty-html 1.4.3".
- ac-3: the same db test: a newer approved version, then the next run in the same thread gets the
  `thread.skill_updated` event, and the markers return `skill_updates`. The web test renders the
  marker.
- ac-4: `resolver/parity.test.ts`: 200 seeded fixtures resolve to the same skills, hashes and
  omissions as the KOBE-313 resolver (a verbatim copy), apart from the documented changes.
  `thread.skill_updated` is typed in `@kobe/protocol` (`events.test.ts`).
- Suspension mid-run: `skill-materialization.db.test.ts` "KOBE-315".
- Suites: `@kobe/server` test:db 126 files / 1698 tests; `@kobe/db` test:db 56 files / 1324; server, web,
  protocol and db unit suites green; repo lint and typecheck green.
