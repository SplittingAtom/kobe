# KOBE-98: Skill editor for members' personal skills

- **Status:** in review
- **Branch / worktree:** `kobe-98-personal-skill-editor` in `../Kobe-wt98`
- **Depends on:** KOBE-83 (merged), KOBE-78 (merged)

## Plan

Reuse the KOBE-83 list and editor components for personal skills in a new member area `/my`.
No migrations, no new endpoints.

## Decisions

- No "my" area existed on main, so this adds a minimal one: `app/my/layout.tsx` + `MyShell`
  (`components/my/`). Unlike the console shells it needs only the active team (`GET /v1/team`),
  no admin permission, and provides the same `ConsoleAccessContext` so the editor components work
  unchanged.
- `SkillsPage` / `SkillEditorPage` take `area="team"|"my"` (`skill-editor/area.ts` holds the
  differences: base path, titles, scope). In `my` the list asks `?scope=personal`, the scope
  picker and column are hidden and uploads always go to `scope=personal`.
- Entry point: "My skills" link in the chat header (`components/my/my-links.tsx`), next to the
  console links. There is no user menu on main.
- Merge with KOBE-97 (My agents): add one entry to `MY_SECTIONS` in `lib/my/nav.ts` and put pages
  under `app/my/agents/`. `my-shell`, `my-links`, `app/my/layout.tsx` and the `MyLinks` line in
  `chat-app.tsx` are the files both tickets may create; keep whichever copy lands first.
- Server already enforces owner-only: personal skills are read and written only under
  `ownerUserId = caller` (`skills/store.ts`), and `POST ?scope=personal` needs only
  `team.personal.create` (member). Existing tests cover other-user 404s; this ticket adds one for
  a same-named upload by another member (separate skill, owner's version untouched).
- Review status (KOBE-80) is not on main, so it is not shown.

## Open questions

- The `/my` shell and nav are shared with KOBE-97; whoever merges second reconciles `nav.ts`.

## Evidence

- ac-1: `components/my/my-skills-pages.test.tsx` (member role with only `team.personal.create`
  creates and edits via `POST /v1/skills?scope=personal`); `MyShell` opens without admin access.
- ac-2: `services/server/src/skills.db.test.ts` "reading and walls" and "bundle download" (404 for
  other users) plus the new same-name test; UI shows the server's 404.
