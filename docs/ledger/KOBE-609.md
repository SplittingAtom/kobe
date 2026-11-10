# KOBE-609: blocked card trusts a decision older than the block

Branch `kobe-609-stale-decision` (from origin/main 778aebda).

## Change

- `EgressNotice` takes `blockedAt` (the block event's server `ts`). `requestForBlock()` drops the
  member's latest request when it is approved/denied with `decidedAt` before `blockedAt`: the card
  renders as a fresh block (Request access; Approve/Deny for deciders, who then create and decide
  a new request). Pending always shows pending. No `blockedAt` or an unparsable time: old behaviour.
- Threaded from every caller: run notices (`NoticeSlot` → `notice.ts`, which also covers the stored
  per-answer cards of KOBE-605 since `blockedByPrompt` copies the row's `ts`), tool-call cards
  (`ToolActivity.egressBlocked` entries now carry `blockedAt` from the event in `live.ts`), notebook
  kernel bar (`BlockedDomain.blockedAt` in `lib/notebooks/executions.ts`).
- Clock: both times are server-side (event `ts` from the server's event append, `decided_at` from
  Postgres `now()`), no browser clock involved. The event is appended when the proxy's report is
  relayed, so `ts` is at or after the actual block.
- `e2e/browser/tests/egress-access.spec.ts`: each test first denies pending requests for its host
  (any team) left by an earlier run; clean-up restores the host's ceiling row to what it found
  (before: an existing not-in-ceiling row was left in_ceiling after an approval, so the next run
  skipped as "already covered"). Hosts stay env-only.

## Verification

- `apps/web` vitest chat/notebooks: 134 files, 1212 tests passed (new: 7 cases in
  `egress-notice.test.tsx` + `requestForBlock` unit).
- web build, web tsc, eslint, `pnpm format:check`, e2e/browser tsc, public hygiene, site wording: ok.
- Not run here: the gate1 browser spec twice in a row (needs a deploy).

## Open

- The proxy reports a host at most once per 30 s per sandbox: if the spec's private-host test
  (d) is re-run within ~30 s of its previous retry, its first block may not produce a new notice.
