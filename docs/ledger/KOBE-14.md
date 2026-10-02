# KOBE-14: Teams, roles, authorization, active team switcher

- **Status:** in review
- **Branch / worktree:** `kobe-14-teams-authz` in `../Kobe-wt14`
- **Depends on:** KOBE-12 (merged), KOBE-8 (merged)

## Acceptance criteria (derived from spec D5, D6, D8, D9, §5.4, §6.1; Hadron unreachable)

- **ac-1 Teams.** Install Owner/Admins create teams (slug valid as `kobe-team-<slug>`, immutable;
  name) with a named initial team admin, atomically; list and rename teams. Users cannot.
- **ac-2 Team roles and membership.** Fixed team roles `team_admin | builder | member`. Team admins
  (and install admins, who place users into teams, D7) add existing users, change roles and remove
  members of a team; a team can never lose its last team admin. Membership rows stay behind team
  RLS (no new bypass, no SECURITY DEFINER).
- **ac-3 Install roles.** Fixed install roles Owner (exactly one, transferable) / Admin / User.
  The Owner grants and revokes Admin and transfers ownership (old Owner becomes Admin).
- **ac-4 Authorization.** One permission matrix (D8) in code, hierarchical roles; middleware
  `requireInstallPermission`, `requireTeam`, `requireTeamPermission` for downstream tickets.
  Install roles grant no team permissions: an install admin who is not a member gets 403 on every
  team-scoped route (D8: no team content without break-glass).
- **ac-5 Active team (D9).** One active team per session, stored server-side; every team-scoped
  request resolves exactly one `team_id` from it, re-verifies membership per request and runs its
  DB work in `withTeam(team_id)`. Setting it requires membership. Optional `X-Kobe-Team` header
  must match (guards a second tab that switched teams). Better Auth's `update-session` cannot set it.
- **ac-6 Team switcher.** Web: top-left switcher lists the user's teams with their role, shows the
  active team, switches it, and picks a team on first load when none is active; empty state when
  the user has no teams.
- **ac-7 Tests.** Unit tests (matrix, schemas, web helpers) and DB integration tests (memberships
  across RLS, every route's allow/deny), probe suite and catalog check green.

## Plan

1. db: `session_active_teams` (install-wide pointer, cascade with session); `memberships.ts`
   (`getMembership`, `listMemberships`); team creation and membership changes in `server/src/teams`.
2. server: `authz/` (matrix + middleware), routes `my-teams`, `team`, `install-teams`,
   `install-roles`; `sessionId` on the auth context.
3. web: `lib/teams.ts` + `app/team-switcher.tsx` on the home page.

## For downstream tickets (22, 34, 15, 20, 35, 45)

- `services/server/src/authz/permissions.ts`: `TEAM_PERMISSIONS` / `INSTALL_PERMISSIONS` (D8),
  `teamRoleAllows`, `installRoleAllows`. Add a permission here rather than checking roles inline.
- `services/server/src/authz/middleware.ts`: mount `requireTeam(deps)` on a team-scoped router, then
  `requireTeamPermission("team.…")` per route; `c.var.team` = `{ id, slug, name, role }`. Do team
  DB work with `withTeam(deps.database.db, c.var.team.id, …)`. Install routes use
  `requireInstallPermission("install.…")`.
- `@kobe/db`: `getMembership(db, teamId, userId)`, `listMemberships(db, userId)`, `TEAM_ROLES`.
- Audit (KOBE-15) should hook role changes in `routes/install-roles.ts`, `teams/members.ts`.

## Decisions

- **Active team lives server-side per session** in a new install-wide table `session_active_teams`
  (session_id PK → `sessions` ON DELETE CASCADE, team_id → `teams`), not a Better Auth
  additional field: Better Auth's `update-session` endpoint could otherwise set it. Allowlisted
  in `teamReferencing` (a pointer, no team content). Per session, so two devices can sit in
  different teams; a stale tab is caught by the `X-Kobe-Team` header (409 `team_mismatch`),
  which is **required on non-GET team-scoped requests** (400 `team_header_required`) and optional
  on reads.
- **No team is auto-selected server-side.** Team-scoped routes return 409 `no_active_team`; the web
  switcher activates the last-used team (localStorage) or the first one on load.
- **Listing a user's teams keeps `team_members` behind its single canonical policy**: one
  transaction visits each team with a transaction-local `kobe.team_id` (no second policy, no
  SECURITY DEFINER, so the catalog check stays as is). Cost: one query per team in the install.
- **Install admins do not manage membership of existing teams** (coordinator review, D8: Admins
  get "users and invites, create teams"). They create a team and name its first team admin at
  creation, rename teams and read rosters (`GET /v1/install/teams/{id}/members`); there are no
  install-level member add/re-role/remove routes. Otherwise an accomplice account made team admin
  could add the install admin, who would then read team content without break-glass. All later
  membership changes go through the team's own admins (`/v1/team/members`). Install roles grant no
  team permission and can't select a team they're not in.
- **Team creation names its first team admin** (`adminUserId`, may be the creator); a team can
  never lose its last team admin (row locks make concurrent demotions safe).
- **Only the Owner grants/revokes Admin** and transfers ownership (D8 lists ownership transfer as
  Owner-only; Owner-only role changes also stop an Admin from removing the second admin that
  break-glass approval relies on). The Owner's role changes only by transfer.
- **Team admins add existing users by email**; brand-new people arrive by invitation (KOBE-13).
- Slugs are immutable (they name `kobe-team-<slug>`); teams can be renamed by install admins.
- `services/server/src/testing/browser.ts` is a shared test browser; `auth.db.test.ts` keeps its
  own copy for now (KOBE-13 is editing that file in parallel).

## Known limits

- **`listMemberships` scales with the number of teams** (security review MEDIUM, note only): every
  `GET /v1/me/teams` runs one query per team in the install. Fine for one organization's teams.
  Suggested fix if it matters: cache the list per session and invalidate it on membership changes;
  if that's not enough, move the per-team loop into one SECURITY INVOKER SQL function (one round
  trip, still under RLS). An install-wide copy of memberships is not an option (D6 keeps
  membership team-scoped).

## Open questions (for Chris or the coordinator)

- Should ownership transfer require a fresh password/TOTP confirmation? Not in the spec; not done.
- **For Chris:** team admins can probe whether an email is a Kobe user via
  `POST /v1/team/members` (404 vs 201) and add any install user to their team without that user's
  consent (security review MEDIUM; behaviour left as is). Should adding go through KOBE-13
  invitations with acceptance, and return a uniform response?
- An install admin can still name an accomplice as first team admin of a _new_ (empty) team; only
  KOBE-15's audit log will show it.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/teams.db.test.ts` › "teams (ac-1)" (create with admin, 403 for users,
  slug validation/duplicate, no orphan team on failure, rename keeps slug).
- ac-2: › "team membership via /v1/team" (member read-only roster, admin add/re-role/remove,
  last-admin guard incl. concurrent demotions, removal revokes on next request) and "leaves
  membership of existing teams to the team's own admins" (install PUT/PATCH/DELETE → 404, roster
  unchanged); `packages/db/src/memberships.db.test.ts`.
- ac-3: › "install roles (ac-3)" (Owner-only Admin grants, Owner role fixed, atomic transfer,
  demotion racing a transfer always leaves exactly one Owner — an invariant check over 5 races;
  the race window is timing-dependent, so the `role <> 'owner'` guard is what guarantees it).
- ac-4: `src/authz/permissions.test.ts` (D8 matrix, hierarchy, install/team disjoint);
  › "install admins and team content" (no select, no team routes, stale pointer refused).
- ac-5: › "active team and switcher API" (member-only selection, same 403 for unknown teams,
  per-session, `X-Kobe-Team` mismatch, `update-session` can't set it, row dropped on sign-out).
- ac-6: `apps/web/lib/teams.test.ts`, `apps/web/app/team-switcher.tsx` on the home page.
- ac-7: catalog check + cross-team probe unchanged and green (`pnpm --filter @kobe/db test:db`).
