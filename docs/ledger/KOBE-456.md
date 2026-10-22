# KOBE-456: A fresh sign-in lands in the Skill Registry team when it sorts first

- **Status:** in review (group branch)
- **Branch / worktree:** `group-29-signin-team` in `../Kobe-wt456`

## Decisions

- New site-wide table `user_last_teams` (migration 0172, own commit): a pointer per user, written
  with the session's active team on every `PUT /v1/me/teams/active`, so a new session on any
  browser starts in the last team used. Classified in `tenancy/identity.ts` (team-referencing).
- `GET /v1/me/teams` adds `lastTeamId` (null unless still a member) and per team `registry`
  (the Site's Registry team) and `chatReady` (a model is enabled; `listTeamChoices` in @kobe/db).
- Default team rule (`teamToActivate`, web): last team (server, then this browser's
  `kobe.lastTeamId`) while a member; else the first non-Registry team with chat ready; else the
  first non-Registry team; else the first by name. Explicit switches unchanged.
- e2e `pinTeam` keeps working (its PUT also sets the server's last team); comment updated.
- ac-2 (composer says no model is enabled) was already there: `model-picker.tsx` shows "No models
  are enabled for your team yet." in the composer before the first send; not changed here.

## Evidence

- ac-1, ac-3: `apps/web/lib/teams.test.ts` (`teamToActivate` skips the Registry team, prefers a
  chat-ready team, honours the last team).
- Server: `services/server/src/my-teams.db.test.ts` (hints, last team across sessions, refused
  switch, removed membership); `teams.db.test.ts` and `invites.db.test.ts` shapes updated.
