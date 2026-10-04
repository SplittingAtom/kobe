# KOBE-77: 47c: Notices for omitted connectors and skills

- **Status:** in review
- **Branch / worktree:** `kobe-77-omission-notices` in `../Kobe-wt77`
- **Depends on:** KOBE-76 (merged)

## Plan

Run start appends one `context.omitted` event right after `run.started` when `StartPlan.omissions`
is non-empty; the web turns it into a run notice (NoticeSlot) listing each item.

## Decisions

- New protocol event `context.omitted` `{items: [{kind, name, reason}]}`, 1..100 items (producer
  truncates). Additive: not terminal, old clients ignore unknown types (the web only subscribes to
  types it knows). Documented in `packages/protocol/README.md` ("Event additions").
- Persistence is `run_events` like every event (no thread entry, no migration): a reload replays the
  stream from seq 0 and `live.ts` rebuilds the notice (same path as `egress.blocked`).
- Emitted only from the fresh start path in `runs/lifecycle.ts`, not `restartPlanInTx` (recovery),
  so a re-sent `run.start` does not duplicate it.
- No leak: items are the agent version's own connectors, the owner's personal skills and the team's
  own model state; resolver inputs are all read inside the run's `withTeam()`. Nothing cross-team.
- Notice style: the existing `styles.notice` run-notice box plus chat Tailwind tokens for the list.

## Open questions (for Chris or the coordinator)

- Contract rule says protocol changes go in their own PR; the ticket needs the event, so it is
  here (small, additive).
- Skill / personal-skill omissions are unreachable until KOBE-78/80 feed the resolver; the text and
  event are ready for them.

## Evidence (acceptance criteria -> test or command output)

- ac-1: `runs-resolver.db.test.ts` "KOBE-77" (event follows `run.started`, none when nothing
  omitted); `omission-notice.test.tsx` (each item listed); `conversation.test.tsx` "shows what the
  resolver left out".
- ac-2: `packages/protocol/src/events.test.ts` ("context.omitted", example round trip);
  `live.test.ts` "context.omitted"; the web tests above.
