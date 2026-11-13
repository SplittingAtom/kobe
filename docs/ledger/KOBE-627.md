# KOBE-627: SSO-6 — group/app-role → team/role mapping engine

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commit on `kobe-627-sso-mapping`, not pushed)
- **Branch / worktree:** `kobe-627-sso-mapping` in `../Kobe-wt627` (from group branch `kobe-sso`)
- **Depends on:** KOBE-625 (tables, `idp:<uuid>` check, audit schemas). Unblocks SSO-3 (KOBE-628,
  calls the engine at sign-in) and SSO-8 (KOBE-632, calls it on SCIM group changes).

## What landed

- **Engine** `services/server/src/sso/access.ts`:
  `applyIdpAccess(db, { providerId, userId, values, actor? }) → { changes, conflicts, memberships }`,
  `followUpIdpAccess(deps, userId, result)` (post-commit effects), and
  `applyIdpAccessAndFollowUp(deps, input)` (what sign-in and SCIM call). Pure planning in
  `sso/access-plan.ts` (`desiredTeamRoles`, `planTeam`, `normalizeIdpValues`).
- **Rules (§7):** highest mapped role per team; managed rows (`added_via = 'idp:<provider>'`) are
  added / re-roled / removed; manual rows and rows another provider or the Skill reviewer grant
  owns are never touched (`mapping_conflict manual_row` when the desire differs); a removal or
  downgrade that would drop the last active team admin keeps the row (`mapping_conflict
last_team_admin`) and the next apply retries; no matched value removes every managed row;
  `memberships` tells SSO-3 whether to refuse `no_access`.
- **Removals and role changes go through `teams/members.ts`** (`removeMemberInTx` /
  `setMemberRoleInTx` with `via: { idp }`), so schedules pause, invitations are revoked, shares end,
  project standing ends, egress is told. The route's post-commit steps moved to
  `teams/after-change.ts` (`afterMemberRemoved`, `afterMemberRoleChanged`), shared by the Team
  console routes and the engine.
- **Managed rows are locked (SSO10):** `setMemberRole`/`removeMember` refuse a provider-managed row
  with 409 `managed_by_idp` (any caller without `via.idp`, incl. Kobe MCP tools that use the same
  routes); `takeOverMember` + `POST /v1/team/members/:userId/take-over` makes it manual (audited
  `identity.member.taken_over`). Accepting an older team invitation no longer clears an `idp:` tag
  (only `skill_reviewer_grant`, `invitations/team-invites.ts`).
- **Audit:** every change is `identity.member.added|role_changed|removed` with `via: "idp"` and
  `providerId` in the team log; conflicts are site `identity.sso.mapping_conflict`; mapping CRUD is
  `identity.sso.mapping.created|deleted`. The actor is the caller's (`actor`), else the request's,
  else system; an agent delegation of the request does not carry over.

## Routes and permissions

| Route                                                                                   | Permission            |
| --------------------------------------------------------------------------------------- | --------------------- |
| `GET /v1/site/sso/mappings[?providerId=]` (providers + mappings)                        | `site.users.manage`   |
| `POST /v1/site/sso/providers/:providerId/mappings`                                      | `site.users.manage`   |
| `DELETE /v1/site/sso/providers/:providerId/mappings/:mappingId`                         | `site.users.manage`   |
| `GET /v1/team/sso-mappings` (read-only, this team)                                      | `team.members.manage` |
| `POST /v1/team/members/:userId/take-over`                                               | `team.members.manage` |
| `GET /v1/team/members` gains `addedVia: "idp"` + `managedBy {providerId, providerName}` | unchanged             |

A site role in `role` (`owner`, `admin`, `site_admin`, `site_owner`, any case) gets 400
`site_role_not_mappable`; the column is the `team_role` enum besides.

## UI

- Site console → People → **SSO access mappings** (`/admin/site/sso-mappings`,
  `components/admin/site/sso-mappings-page.tsx`, nav file `lib/admin/nav/site/sso-mappings.ts`):
  per provider, its mappings, add (value, team, team role) and delete. Isolated so KOBE-626's
  Single sign-on page can absorb it (move the component under the provider page and drop the nav
  file + one barrel line).
- Team console → Members: managed rows show the role and "Managed by <provider>", no role select,
  no Remove, a **Take over** button with confirmation; "Show access mappings" lists the team's
  mappings read-only (loaded on request).

## Decisions / deviations

- **Signature takes `db`, not `tx`:** spec §7 step 2 writes each team in its own `withTeam()`
  transaction, and `withTeam` refuses nesting (a transaction-local team setting survives a
  savepoint), so one caller transaction can't span several teams.
- **No `identity.sso.mapping.updated`:** the audit registry has created/deleted only; changing a
  role is delete + add.
- **Re-apply on mapping change** is not done here: it needs SCIM memberships (SSO-8 re-applies to
  SCIM-known users); everyone else picks it up at the next sign-in (SSO-3). Routes answer
  `appliesAt: "next_sign_in"` and the page says so.
- Conflicts are audited on every apply that hits them (no dedup), as the spec's "retry on the next
  change" implies an evaluation each time.
- Lock order: the engine locks with `lockForChange` (admin rows, then target) like every other
  membership change, so concurrent console edits can't deadlock with it.
- At most 2000 values per apply (refused above, never truncated: truncation would remove access).

## Guide pages SSO-10 (KOBE-634) must update

- `docs/guide/admin/team-admin.md`: members managed by the identity provider ("Managed by"),
  why role change/removal is refused (409 `managed_by_idp`), **Take over**, the read-only
  "Show access mappings" list, and removal in the IdP as the way to take access away.
- `docs/guide/admin/site-admin.md` (Single sign-on section): access mappings (app roles
  recommended, highest role wins, team roles only, manual rows win, last-team-admin hold,
  conflicts in the audit log, "applies at next sign-in").
- `docs/guide/glossary.md`: access mapping, managed member.
- `docs/guide/reference/troubleshooting.md`: `managed_by_idp`, `site_role_not_mappable`,
  `mapping_conflict` reasons.

None changed in this ticket (SSO-10 owns the SSO guide pages; nothing is reachable without
SSO-2/SSO-3).

## Evidence

- ac-1 every §7 rule: `services/server/src/sso-access.db.test.ts` ("applyIdpAccess rules":
  highest role, update, manual wins, other provider, removal, last admin + retry, no access) and
  `sso/access-plan.test.ts` (12 unit tests).
- ac-2 removal pauses schedules: same file, "a removal goes through teams/members.ts…"
  (schedule inactive, `schedule.deactivated` + `identity.member.removed via idp`).
- ac-3 managed row locked: db test (PATCH/DELETE 409 `managed_by_idp`, no audit) and
  `apps/web/components/admin/sso-mappings.test.tsx` (no select/Remove, Take over).
- ac-4 Take over: db test (row manual, `identity.member.taken_over`, apply no longer touches it).
- ac-5 site role refused: db test + `sso/mappings.test.ts`.
- ac-6 audit `via: "idp"`: db tests on added/role_changed/removed and conflicts.
