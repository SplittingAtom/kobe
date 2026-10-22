# KOBE-455: One app-launch rule: the rail Apps tab uses useAppLaunch

- **Status:** in review (group branch `group-37-app-launch-rule`)
- **Branch / worktree:** `group-37-app-launch-rule` in `../Kobe-wt455`
- **Depends on:** KOBE-440, KOBE-451, KOBE-458

## Decisions

- Only two surfaces launch app cards (`launchAppCard`): the rail's Apps list and the + menu's Apps.
  Rail Pickers run a picker live (KOBE-460, no card); app commands and the palette do not launch apps.
- `rail-apps.tsx` now calls `useAppLaunch()` and closes its drawer when `launch` resolves true; its
  copy of the KOBE-440/458 rule is gone. The hook also returns `intoNewThread` for the row labels.
- gate-apps browser specs do not depend on the rail rows' markup; labels are unchanged.

## Evidence

- ac-1: characterisation tests written first and green on the old code, then on the new
  (`components/apps/app-cards.test.tsx`, "the rail's launch rule (KOBE-455)": KOBE-458 draft from
  the rail, server refusal shown, drawer closes after a launch at 960 px); the existing rail and
  - menu launch tests (`app-cards.test.tsx`, `plus-menu.test.tsx`) pass unchanged.
