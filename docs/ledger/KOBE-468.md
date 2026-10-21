# KOBE-468: Chat: close button on egress and run notices

- **Status:** in review (branch `group-17-close-notices`, not pushed)
- **Branch / worktree:** `group-17-close-notices` in `../Kobe-wt468`

## Decisions

- One remembered list of closed notice ids, `kobe.chat.closedNotices` in localStorage (last 200,
  try/catch; blocked storage still hides the notice for the page view): `lib/chat/closed-notices.ts`.
- Ids: run notices `<run_id>:<seq>`; a blocked domain `<run_id>:egress:<domain>` (live.ts keeps one
  notice per domain and run); a blocked domain on a tool card `tool:<tool_call_id>:egress:<domain>`.
- `ClosableNotice` (`components/chat/closable-notice.tsx`) wraps NoticeSlot notices (omission, steer,
  memory, artifact, file) and the run-end notices (failed, budget stopped, Stopped). The × is the
  `dismiss-notice` IconAction, as on the retention notice.
- The egress notice carries the × inside its red box, named "Close notice about <domain>". Closing
  unmounts it, so polling a pending request stops; the request itself is not cancelled.
- Unchanged: policy denials, approval cards, connection banners, budget banner, action errors.

## Open questions

- The egress notice on a tool card is closable too (same notice); say if it should stay fixed there.

## Evidence

- ac-1/ac-2: `closable-notice.test.tsx`, `egress-notice.test.tsx` (close, reload, no polling,
  blocked storage), `lib/chat/closed-notices.test.ts`; conversation.test.tsx "closing notices".
- ac-3: same conversation test asserts the policy denial has no button; existing approval tests pass.
- No e2e/browser spec asserts on these notices.
