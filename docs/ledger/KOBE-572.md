# KOBE-572: Browser specs on gate1: assign and run, propose and approve, fork bound, pin and update, owner leaves

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (spec written; not run: gate1 still runs a build without the roster UI)
- **Branch / worktree:** `kobe-572-roster-gate1-specs` in `../Kobe-wt572`
- **Depends on:** KOBE-566..571 (routes, Agents page, labels). Spec `docs/specs/agents-roster.md`
  §4-§6, AR-8.

## Plan

One Chromium spec, `e2e/browser/tests/agents-roster.spec.ts`, owner (KOBE_USER) plus member2
(KOBE_USER2/KOBE_PW2). Each scenario creates its agents through the API (unique names), and an
afterEach runs its undo steps last-in first-out: withdraw team/site entries, delete agents (published
ones archive), schedules and threads, close member2's browser. The team default agent is never
touched. Skips when `GET /v1/agents/roster` answers 404, without member2, or when the team's
pre-publish eval gate answers 202.

## Scenarios

1. **assign and run:** owner publishes a personal agent, assigns it to the team (201 active);
   member2 sees the Team-tab row (Active), picks it from the picker's Team group, the run answers
   (one Ollama turn), the thread's pin is `{agentId, version 1}` = the row's version in effect.
2. **propose and approve:** member2's agent → "Propose to Team1" from the Personal row menu (202,
   Reach "Proposed to Team1"); owner presses `Proposed (n)` (n ≥ 1: leftovers of other runs may
   count), Approve… with Version rule v1; member2's Team row Active v1, Reach "Team: Team1".
3. **fork bound:** owner creates and publishes a team-owned agent, Fork to Personal… (dialog note
   "Bound to Team Team1: usable only there."), Fork and open; Personal row "Bound to Team: Team1";
   assigning the copy to the site → 422 `agent_bound_to_team` (API).
4. **pin and update:** owner assigns, pins v1 (Pin a version…, "Pinned to v1"); member2 starts a
   thread (API, pin v1); owner publishes v2 → "Update available: v2"; Update to latest (v2) →
   version in effect v2; the earlier thread keeps v1, a new one pins v2.
5. **withdraw pauses schedules; threads keep pins:** owner assigns; member2 starts a thread and a
   weekly schedule (API); owner withdraws → thread keeps v1, the row is gone from member2's Team
   tab, the schedule is paused `agent_unavailable` ("Paused: agent unavailable" on /me/schedules);
   re-assign → the schedule is active again.

## Decisions / deviations

- **Fork bound is driven by the owner, not member2:** members may not fork team content at all
  (403, KOBE-568 `canForkAgent`: team-owned and team-entry sources need `build`).
- **"Owner leaves" replaced by "withdraw pauses schedules; threads keep pins":** the literal case
  (owner removed from the team → Unavailable row → admin adopts) needs a disposable member;
  member2 is shared by other specs. The coordinator decides on the fresh gate1 install whether to
  add a scratch member for it.
- Picker check uses the Team group (`role=group` "Team") and the radio's name prefix (lent agents
  carry an origin label in the name).

## Evidence (acceptance criteria → test or command output)

- ac-1: not run yet (coordinator runs it from the Playwright container after the next deploy).
  `e2e/browser` `tsc -p .`, eslint and prettier clean.
