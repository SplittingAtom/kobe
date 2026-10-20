# KOBE-460: Rail Apps tab: a Pickers section on top (dropdown + live picker), the app list below

- **Status:** in review (group branch, not pushed)
- **Branch / worktree:** `group-13-rail-pickers` in `../Kobe-wt460`
- **Depends on:** KOBE-436/437/439/440 (app calls, frame route, composer bridge, rail apps), KOBE-448

## Decisions

- Chris's four choices (2026-10-20) are written into `docs/specs/mcp-apps-host.md` MA3
  ("Amended 2026-10-20 (Chris, KOBE-460)"), with §6 and §8 lines for the picker.
- **One frame host, one bridge.** The picker is `AppFrame` (`components/apps/app-frame.tsx`) with a
  new `placement: "rail"` (inline to the app, fills its section, scrolls inside a wrapper) and two
  optional props: `threadId` (read at call time) and `onCall` (each call's answer). Same member
  frame route `GET /v1/team/apps/{appId}/frame?team=&sha256=` and header CSP; same
  `sandbox="allow-scripts"`; the host bridge is unchanged. `cardKey` is `rail-picker`, so one
  picker frame exists at a time (the `<LivePicker>` is keyed by app id).
- **How a picker's tool calls are checked.** The existing path was keyed by app, not by card, so
  it already ran every card check: rate limit, member principal (session + `X-Kobe-Team`,
  `team.chat`), MA8 liveness (`memberApp`: connector active and enabled for the team, template
  pinned/approved/not drifted, member's grant or usable site key), tool of the app's connector,
  pinned/not drifted, `readOnlyHint`, `"app"` visibility, team exposure, argument schema, policy
  at `app_bridge` (deny, ask → deny, read only), credential reveal, audit `mcp.app_call`.
  What a card has and a picker lacks is a thread. The **narrowest rail variant**: the calls body
  takes an optional `thread_id` (uuid, strict schema). When present, `callApp` (step 1, after the
  MA8 check, before any decision or credential) runs `findThread` with the member as viewer
  (their own or shared-to-them threads; RLS plus explicit `team_id`) → else `thread_not_found`
  (404), then `connectorsOffIn` → `connector_off` (403). Both are new `APP_CALL_REASONS`
  (zod enum, no migration) and audited like every denial. The picker always sends the thread on
  screen; in a new conversation it sends none, and the web does not run the picker while the
  draft has its connector off (`draftConnectors`; the server refuses that context at send anyway,
  KOBE-451 LOW-5). No other route changed.
- Card frames still send no `thread_id` (behaviour unchanged; see open question 1).
- **Composer.** `useAppComposer(app, {newConversation, active})`: the thread on screen, else the
  `new` draft; `active: false` (picker not on screen: Files tab or rail collapsed) refuses both.
  The composer's insert listener now keys on its draft (`remoteId ?? "new"`), so a new
  conversation takes the text with the same marker and gate. Nothing is written to a thread.
- **Width.** `rail-state` keeps the member's `width` (saved) and adds `shownWidth`
  (`max(width ?? 280, 400)` while a picker shows on the Apps tab, unsaved; the grid's CSS still
  caps it to the room the conversation needs). The handle shows `shownWidth` and commits the
  member's drag as their width. The drawer gets `min(400px, 85vw)` via `data-picker`.
- **Remembered per member:** a new optional layout preference `rail_picker` (64-hex app id or
  null) in `packages/protocol/src/ui-preferences.ts`, additive, as KOBE-448 did for `rail_tab`.
- **Fallback:** a stored picker missing from a successful apps read is set to None with "Your
  picker is no longer available…"; a call answered `app_not_available` re-reads the apps list.
  A call answered `connector_off` shows "<connector> is off in this conversation…".
- Didn't touch launch code (KOBE-458/455) or `components/skills` (KOBE-459).

## Open questions (for Chris or the coordinator)

1. Card frames' calls do not check the thread's connectors-off today (only launches and sends
   do). Sending `thread_id` from cards too is a one-line change in `tool-card-app.tsx` /
   `app-card.tsx`; left out to keep card behaviour unchanged.
2. The browser spec needs Catalyst's picker env on gate1 (`KOBE_APPS_PICKER_PATH`,
   `KOBE_APPS_PICKER_USE_LABEL`, `KOBE_APPS_PICKER_TEXT`); not run here (no cluster access).

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2, ac-3, ac-4, ac-5: `apps/web/components/shell/rail-pickers.test.tsx` (13 tests:
  section absent without a picker, above the list, list unchanged; None + case-insensitive
  options; saved and restored; gone → None + note; frame in the section; ui/message fills the
  thread's and the new draft, never sends; context chip; widen to 400, member width kept and
  restored, not while Files shows; draft connector off → not run).
- ac-6: `services/server/src/team-apps.db.test.ts` "rail picker calls naming the thread on
  screen (KOBE-460)": own thread allowed, connector off refused and audited, another member's /
  another team's / unknown thread refused, bad uuid 400, write tool / exposure / app of another
  team refused. Frame route and sandbox asserted in the web test.
- ac-7: `docs/specs/mcp-apps-host.md` MA3, §6, §8.
- ac-8: `e2e/browser/tests/gate-apps/picker.spec.ts` (pick, choose a table, composer text, no
  send, width; reload keeps it, collapsed rail; phone drawer, no page scroll); runbook updated.
- Protocol: `ui-preferences.test.ts`; web `lib/shell/preferences.test.ts`.
