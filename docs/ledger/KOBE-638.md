# KOBE-638: Site console Teams: manage a team's members directly (no invitations)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (two local commits on `kobe-638-site-team-members`, not pushed)
- **Branch / worktree:** `kobe-638-site-team-members` in `../Kobe-wt638` (from group branch `kobe-sso`)
- **Depends on:** KOBE-627 (managed rows, Take over, `teams/after-change.ts`). Chris 2026-11-12
  (final): site admins manage members; self-add refused.

## Plan

1. **Schema commit (its own, first):** migration `0213_team_members_site_admin` (constraints only:
   `team_members.added_via` also takes `site_admin`; `notifications` takes `team.member.added` with
   `actor_user_id`, no schedule/thread/run/skill). No RLS change (both tables already have team RLS
   and probe fixtures). Protocol adds the kind (additive), the bell words it, the notifications
   store lists it. Upgrade test `packages/db/src/team-members-site-admin-upgrade.db.test.ts`.
2. **Feature commit:** server routes, shared membership code, web panel, Kobe MCP site tools, docs,
   browser spec.

## What landed

- **Routes** (`routes/site-team-members.ts`, mounted under `/v1/site/teams/:teamId`, permission
  `site.teams.manage` = Owner + site admins; CSRF via the app's origin check):
  `GET candidates?q=` (active non-members, never the caller, ≤ 20), `POST members`
  `{userIds[1..50], role}` (all or nothing), `PATCH members/:userId {role, expectedRole?}`,
  `DELETE members/:userId?expectedRole=`, `POST members/:userId/take-over`.
- **One implementation:** role change, removal and Take over call `teams/members.ts`
  (`setMemberRole`/`removeMember`/`takeOverMember`, new optional `origin: "site_admin"`) and
  `teams/after-change.ts`, exactly as the Team console. Adding is new (`teams/add-existing.ts`):
  users share-locked, rows tagged `site_admin`, `identity.member.added via site_admin`, an in-app
  `team.member.added` notification in the same transaction; email after commit
  (`teams/notify-added.ts`, one background task per recipient, skipped without a relay).
- **Rules (server):** last active team admin kept; managed rows 409 `managed_by_idp` except Take
  over; deactivated 409 `user_deactivated`; unknown 404; already a member 409 `already_member`;
  self-add 403 `self_add_refused`; site roles untouched.
- **Audit:** `identity.member.added|role_changed|removed|taken_over` gain `via: "site_admin"`
  (registry + `docs/audit-log.md`); actor is the site admin; team-scoped, so the team's own Audit
  view shows them.
- **Roster** (`listMembers`, both consoles): `addedVia` may be `site_admin`; new `deactivated`.
- **Web:** Site console › Teams › **Manage members** opens `site/team-members-panel.tsx` (table:
  name, email, team role, joined by, status; role select + Save, Remove with confirm, Take over
  for managed rows; your own row read-only; Add existing users: search, tick several, role, Add).
  Teams page description and nav description updated. Team console shows "Added by a site admin"
  and "Deactivated"; `RoleCell` and `joinedVia` are shared from `team/members-page.tsx`.
- **Docs:** `docs/guide/admin/site-admin.md` (Teams), `team-admin.md` (Members and roles),
  `admin-from-a-conversation.md` (site tools list), `docs/audit-log.md`.

## Decisions

- **New `added_via` value `site_admin`** so the roster says how someone joined without reading the
  audit log (which ages out). It behaves like a manual row (no mapping/grant touches it). A
  person's role change now clears only `skill_reviewer_grant` (before: any non-idp tag, i.e. the
  same for existing data), so "Added by a site admin" survives a later role change.
- **Self:** besides self-add (ac-4), the Site console refuses every change to the caller's own
  membership (403 `self_change_refused`), e.g. a site admin who is a member promoting themselves.
  Their own changes stay in the Team console. Say if self-removal should be allowed here.
- **Add is all or nothing** (one refusal names its `userId`, nothing added): no partial results to
  explain, and the picker only offers active non-members anyway.
- **Permission:** reused `site.teams.manage` (the Teams page's own); no new permission.
- **Notification lives in the team it is about** (notifications are team-scoped): the user sees it
  once they switch to that team; the email reaches them at once.
- **ac-6: not offered in the Team console.** Team admins keep invitations only (their powers
  unchanged; an invitation is the invitee's consent, and a team admin has no site-wide user
  directory today). The Team console only shows the new "Added by a site admin" and "Deactivated".
- **ac-7: added** `site_team_members_list`, `site_team_members_add`, `site_team_members_set_role`,
  `site_team_members_remove` (`kobe-mcp/tools/site/team-members.ts`): before-states (`from_role`
  sent as `expectedRole`; Add checks none is a member), approval card summaries, same routes and
  refusals. Take over stays console-only (a judgement call on someone's IdP access).
  `site_teams_create`'s description no longer says site admins can't add members.
- `teams.db.test.ts` "leaves membership … to the team's own admins" rewritten to the new rule.

## Open questions (for Chris or the coordinator)

- Self-removal from the Site console is refused with the rest of self changes; fine?
- Browser spec picks a team member2 is not in (`KOBE_SITE_MEMBERS_TEAM` slug, else the first);
  it skips if member2 is in every team. Not run (coordinator runs it after deploy).
- The schema commit must land before KOBE-629 if that branch ever needs a migration (it should not).

## Evidence (acceptance criteria → test or command output)

- ac-1 roster fields: `site-team-members.db.test.ts` "roster (ac-1)"; web
  `components/admin/site-team-members.test.tsx` "lists name, email, role, how they joined…".
- ac-2 add one / several, no invitation, bell + email, candidates search:
  `site-team-members.db.test.ts` "add (ac-2, ac-4)", "candidates (ac-2)"; web "searches, picks
  several users…".
- ac-3 role change/remove via `teams/members.ts` (schedules paused, `changed_since_approval`):
  db "role change and removal"; web "changes a role, removes after confirming, and takes over".
- ac-4 last admin, managed row + Take over, deactivated, self-add, site roles: db tests of the
  same names; web "shows last_team_admin…", "shows the server's refusal of an Add".
- ac-5 permission + CSRF + audit as site admin in the team log: db "permission (ac-5)" and the
  audit assertions in add/role/remove/take-over (team admin reads it via `/v1/team/audit`).
- ac-6: decision above; Team console tests unchanged and green (`team-pages.test.tsx`).
- ac-7: `kobe-mcp-site.db.test.ts` contract (each new tool refused without permission, answered
  with it, audited via agent); `kobe-mcp/site-tools.test.ts` (definitions, deletes list).
- ac-8 browser: `e2e/browser/tests/site-team-members.spec.ts` (not run here).
- Schema: `packages/db/src/team-members-site-admin-upgrade.db.test.ts` (2 tests).
- `pnpm verify` with `KOBE_TEST_DATABASE_URL` set (format, lint, typecheck, test, test:db, license, hygiene, wording): green, 2026-11-12.
