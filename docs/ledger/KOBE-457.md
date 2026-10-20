# KOBE-457: G11 browser failures on gate1 rev 81

- **Status:** committed on `group-11c-gate1`, not pushed
- **Branch / worktree:** `group-11c-gate1` in `../Kobe-pin`
- **Depends on:** KOBE-448, 450, 451, 452, 453 (G11, #325/#326)

## Root causes (ac-1)

gate1's data differs from CI's k3d fixtures in three ways that matter here: the owner is in two
teams (Team1 and Skill Registry, which sorts first), Team1 has apps (the rail's Files | Apps
tabs), and its agent is named `Kobe (Team1)`. Every failure traces to one of them meeting a spec
or a test helper; none is a product bug.

1. **composer-controls.spec.ts:105 at 768 and 1024 px: stale helper (spec).** `Chat.open()` calls
   `showBothPanels`, which since the KOBE-453 review clicks the collapsed strip's Show files /
   Show apps when the Files toggle is not on screen. Below 1100 px the rail is always collapsed
   and that click opens it as a modal drawer (`useModalLayer`, the rest of the chat `inert`), so
   the composer left the accessibility tree and `getByRole("textbox", { name: "Message" })` found
   nothing. The 768/1024 spec (#326) and the strip click (#325) were written on separate group
   branches. Fix: the helper sets the section up in the drawer, then closes it (Escape) when it
   opened one.
2. **my-area-panels.spec.ts:83 (800 px): same helper (spec).** The drawer opened by `open()`
   covered the bar, so the chat app intercepted the click on `[data-command=my-memory]`. Fixed by
   (1).
3. **rail-header.spec.ts:33: stale measurement (spec).** With more than one team the selector is a
   `<details>` menu whose closed list holds a button per team. Chromium still lays that list out
   (closed `details` content is `content-visibility: hidden`), below the line, so the spec's
   `querySelectorAll("button, a, summary")` measured buttons nobody sees: a 74 px spread while the
   line itself is one line (screenshot). A box-size filter was not enough (gate1 rerun: still 74).
   Fix: measure only controls that pass `checkVisibility()`, at least four of them; the 4 px
   tolerance stays.
4. **gate5/u17-workspace.spec.ts:87: second browser in another team (spec).** The active team
   belongs to the session (D9); a fresh sign-in with no remembered team activates the first team
   by name (`teamToActivate`). `secondBrowser` signed in on its own and landed in Skill Registry,
   which has no apps, so no Apps tab. KOBE_TEAM (034dfc4c) only pinned the setup's session. Fix:
   `support/team.ts` `pinTeam()`, used by the setup and by `secondBrowser`.
5. **gate5/u21-history.spec.ts:102: same as (4) (spec), not flaky.** The second browser opened the
   Team1 thread's address while in Skill Registry, so no tool card rendered. Fixed by (4).
6. **my-shared-cases.spec.ts:14: regex from a name (spec).** `new RegExp(KOBE_AGENT)` with
   `Kobe (Team1)` makes `(Team1)` a group, matching "Kobe Team1", so no radio matched. Fix: escape
   the name.

## Decisions

- Kept every check's strength: the line tolerance is still 4 px; only hidden controls are left out.
- No product change: a new session landing in the first team by name is D9 behaviour, and the
  drawer being modal below 1100 px is by design (KOBE-201/453).

## Evidence (gate1 rev 81, local-cc05517052e1, KOBE_TEAM=team1, chromium)

- Reproduced with the branch's specs before the fixes: the same 7 failed (snapshots showed the
  modal "Workspace" drawer at 768/800 px, "Skill Registry" with "No thread with that id." in the
  second browser, and the radio "Kobe (Team1), Team" unmatched).
- After the fixes, the six spec files in full: 22 passed, then rail-header.spec.ts 5/5 after the
  `checkVisibility()` change.
- Full chromium suite with the fixes (30.7 min): 82 passed, 5 skipped, 8 failed, none of them
  the seven: the 3 consoles screenshot baselines (expected); 3 `gate-apps/explorer` (need the
  `KOBE_APPS_*` connector env, which the runner does not pass; they passed in their own run);
  `remember-approvals` (the model took 6 min and no second approval card came) and `status-cues`
  (the Threads button said "waiting for your approval", left by that run). Both passed on a
  rerun on their own (4/4), so model timing, not these changes.
- `pnpm verify` and `pnpm --filter @kobe/web test` (238 files, 2200 tests) green. No product code
  changed, so no web unit test applies (ac-2 has no product bug to cover).
