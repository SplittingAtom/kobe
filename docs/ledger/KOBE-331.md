# KOBE-331: C2: Skill reviewer grant and site.skills.review

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-330 (Registry team), KOBE-311 (`site_grants`, `SITE_GRANTS`)
- **Migrations (review):** 0154 `team_members.added_via` (generated, CHECK `skill_reviewer_grant`)

## What shipped

- **Permissions** (`services/server/src/authz/permissions.ts`): `site.skills.review` and
  `site.grants.manage` (both Site admin and Owner). `SKILL_REVIEW_ACTIONS` and
  `skillReviewAllows({siteRole, grants}, action)`: holders of `site.skills.review` may do every
  Registry action; the **Skill reviewer** grant allows `queue.read`, `claim`, `comment`,
  `approve`, `request_changes`, `reject` and nothing else (never `reject_and_block`,
  `withdraw`, `revoke`, `tag_default`, `settings`). The ladder itself is unchanged: the grant adds
  no site permission.
- **Middleware** `requireSkillReview(deps, action)`: reads the caller's grants per request (a
  deactivated account's grants count for nothing), so taking the grant closes the queue at once.
  First route behind it: `GET /v1/site/skills/registry/status` ({ready, registryTeam}); the
  queue, claim and verdict routes of later tickets use the same guard.
- **Grants** (`skills/registry/grants.ts`, routes in `routes/site-roles.ts`):
  `GET /v1/site/roles/grants` (`site.users.manage`, like the roles list),
  `PUT|DELETE /v1/site/roles/grants/:userId/skill_reviewer` (`site.grants.manage`). Idempotent
  give (`changed: false`), 404 for an unknown user or a grant not held. Audit
  `identity.site_grant.granted` / `.revoked` (site log, the admin as actor).
- **Registry team membership:** a grantee is added as a `member` of the Registry team when
  granted, and every grantee when a team becomes the Registry team (KOBE-330's settings save),
  each audited `identity.member.added` (`via: skill_reviewer_grant`) in that team's log.
- **Web:** Site roles page gets a **Skill reviewers** section (any Site admin): what reviewers may
  do, the holders with Take (confirmed), and Make Skill reviewer for active plain users (Site
  admins review anyway, so they are not offered).

## Review fixes (review-c1.md)

- **H1** grantees join only the dedicated Registry team (KOBE-330 review); the grant is refused
  for oneself, Site admins and the Owner (`not_grantable`, they review through their role).
  Team admins see "Added by Kobe: Skill reviewer" on such members. No separate notification: the
  team is the Registry's own (its admin is the Site admin who created it).
- **Coordinator decision (revoke):** Kobe's memberships are `added_via = skill_reviewer_grant`;
  taking the grant removes exactly those, through `removeMemberInTx` (invites, schedules, egress,
  shares, audit `identity.member.removed` with `via`). A prior member, a member whose role a team
  admin changed, or one who accepted an invitation is the team's own (`added_via` cleared) and
  stays.
- **M3** granting a deactivated account is 409 `user_deactivated`; deactivated holders never join
  and are flagged in the list. **M4** the grant (or revoke) and the membership change are one
  transaction under the Registry team's RLS context, the team read under `FOR SHARE`.
- **L5** tests: reviewers can't grant (themselves included), revoke or list grants; team admins
  can't grant or revoke; a promoted-then-demoted grantee keeps only reviewer actions;
  `grantsOf` is empty for a deactivated holder; the reviewer table is exhaustive by type.
  **L6** DELETE answers `user_not_found` for an unknown user. **L7** the Registry team's creator
  is its team admin; other Site admins review through `site.skills.review` and are not members
  (re-runs are the review ticket's to place).

## Decisions

- **Who gives the grant:** "the Owner or a Site admin" (SK22), so a new admin-level
  `site.grants.manage`, not the Owner-only `site.roles.manage`.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-reviewer-grant.db.test.ts`: give and take by a Site admin
  (members 403, unknown user 404, unknown grant 400), audit rows with the actor, a grantee joins
  the Registry team when it is named and a later one at once (audited in the team log),
  membership kept after taking.
- **ac-2** `services/server/src/authz/permissions.test.ts` "Skill reviewer grant beside the
  ladder": every action for reviewer, admin, Owner and user; the DB test checks the status route
  opens to reviewers and admins only, and that reviewers can't read or change Registry settings,
  list site roles or give grants.
- **ac-3** permissions test: a plain user still has no site permission, `site.skills.review` is
  not a User's; the site matrix rows are unchanged apart from the two new admin permissions.
- Web: `apps/web/components/admin/skill-reviewers-section.test.tsx`, the updated Site roles test.
