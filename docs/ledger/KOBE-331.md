# KOBE-331: C2: Skill reviewer grant and site.skills.review

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-330 (Registry team), KOBE-311 (`site_grants`, `SITE_GRANTS`)
- **Migrations:** none (`site_grants` and its enum exist since KOBE-311)

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

## Decisions

- **Taking the grant leaves Registry team membership alone:** the person may be a member for
  other reasons; the team's admins remove them if wanted. The queue closes at once either way.
- **Who gives the grant:** "the Owner or a Site admin" (SK22), so a new admin-level
  `site.grants.manage`, not the Owner-only `site.roles.manage`.
- Changing the Registry team later adds the reviewers to the new team; the old team's
  memberships stay.

## Open questions (for Chris or the coordinator)

- Should taking the grant also remove the person from the Registry team when Kobe added them?

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
