# KOBE-98: Skill editor for members' personal skills

- **Status:** in review
- **Branch / worktree:** `kobe-98-personal-skill-editor` in `../Kobe-wt98`
- **Depends on:** KOBE-83 (merged), KOBE-78 (merged)

## Plan

Reuse the KOBE-83 list and editor components for personal skills in a new member area `/my`.
No migrations, no new endpoints.

## Decisions

- KOBE-97 merged first and added the member area `/me` (`app/me/layout.tsx`, `MyAgentsShell`, chat
  header nav). This ticket reuses it: pages at `/me/skills[/new|/<id>]`, a "My skills" link in the
  same header nav, and the shell's brand/title now read "My area". No second shell or nav.
- `SkillsPage` / `SkillEditorPage` take `area="team"|"my"` (`skill-editor/area.ts` holds the
  differences: base path, titles, scope). In `my` the list asks `?scope=personal`, the scope
  picker and column are hidden and uploads always go to `scope=personal`.
- Server already enforces owner-only: personal skills are read and written only under
  `ownerUserId = caller` (`skills/store.ts`), and `POST ?scope=personal` needs only
  `team.personal.create` (member). Existing tests cover other-user 404s; this ticket adds one for
  a same-named upload by another member (separate skill, owner's version untouched).
- Review status (KOBE-80, now on main): the server returns `review: null` for personal versions
  (they are not reviewed), so there is nothing to show.

## Open questions

- None.

## Evidence

- ac-1: `components/me/my-skills.test.tsx` (member role with only `team.personal.create`
  creates and edits via `POST /v1/skills?scope=personal`).
- ac-2: `services/server/src/skills.db.test.ts` "reading and walls" and "bundle download" (404 for
  other users) plus the new same-name test; UI shows the server's 404.
