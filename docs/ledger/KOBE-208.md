# KOBE-208: B4: Rich history: reasoning block, tool cards, hover footer, Detail toggle

- **Status:** in review (PR #271)
- **Branch / worktree:** `kobe-208-rich-history` in `../Kobe-wt208`
- **Depends on:** KOBE-202 (A6 preferences), KOBE-203 (A7 IconAction, command registry)

## Plan

1. Server (own commit, needs the Opus security review): read one entry with its offloaded body;
   thread usage names each run's prompt entry.
2. Protocol (own commit): `detail_expanded` UI preference (the key KOBE-202 left room for).
3. Web: timing and offloaded-result mapping in the projection (`lib/chat/history.ts`,
   `tree.ts`); `reasoning.tsx`, reworked `tool-call.tsx`, `message-footer.tsx`, `detail.tsx`
   (provider, toggle, disclosure); the toggle in bar row two.

## Decisions

- **Large outputs (after review):** no ingest path offloads entries (`sandbox-wire/entries.ts`
  stores every payload inline; only fork copies an existing `blob_ref`), so outputs over 64 KB
  live inline. The entry list now trims a tool output over 64 KB to a 2,000-character preview and
  flags `payload_truncated` (role, `toolCallId`, `isError` kept, so the card maps it exactly, no
  migration). `GET /v1/threads/{id}/entries/{entryId}/output` answers only the output (text,
  `is_error`, ids; inline ones extracted in SQL, capped at 1,000,000 characters). Offloaded bodies
  (legacy or forks) go through one reader shared with the export: thread tree only, 8 MB cap even
  when the store understates the size, 4 reads at once per process, logged with ids and the
  error class only. An offloaded entry shows as its own block, read when opened; the client no
  longer guesses which call it answers.
- **Visibility** = `findThread` (owner; project readers once shared; owner only while in Trash);
  entry queries name `team_id` and `thread_id`. Tests: `thread-entry-output.db.test.ts`.
- **Usage:** `runsUsage` LEFT JOINs `runs` for `user_entry_id`. Each run commits its own prompt
  (edit, regenerate and Retry send a new one; `bindUserEntry`), so the prompt names exactly one
  run; the review's "regenerated siblings sum" does not happen (test added). The projection gives
  each answer its prompt past assistant parents (`promptEntryId`).
- **Timing:** Pi's clock only (entry and step timestamps); no `createdAt` mixing. Reasoning shows
  "step N s" with a tooltip saying it is the whole step (Chris's decision).
- **Collapse model:** each block follows the Detail toggle unless opened or closed by hand since
  it last changed. Bodies stay mounted (`hidden`). A failed full read shows an alert with Retry
  and is tried again on the next open.
- Detail command `detail` (Mod+Shift+D, unbound while `SHORTCUTS_BOUND` is false).

## Open questions (for Chris or the coordinator)

- The PR is large (see the PR body for the split); kept as one PR at the coordinator's request.
- LOW-2 (nosniff) is set on the output route only; a global `secureHeaders` is a separate ticket.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/rich-history.test.tsx` "rendering a recorded thread" (reasoning first
  line + step time, tool header + full I/O, large output read only on open and once, failure +
  Retry, rejected request, offloaded block, footer per run); `lib/chat/history.test.ts`;
  `lib/chat/tree.test.ts` "rich history".
- ac-2: `rich-history.test.tsx` "the Detail toggle" (all open/closed, PUT `detail_expanded`,
  restored after reload); `lib/shell/preferences.test.ts`; protocol `ui-preferences.test.ts`.
- ac-3: `rich-history.test.tsx` "collapsed by default" (answer shown, every block closed, no
  crushed icon buttons).
- Server: `thread-entry-output.db.test.ts` (list trimming, owner/reader/outsider/other team,
  Trash, other thread's and team's entry ids, foreign key, missing, not JSON, oversized and
  understated bodies, nosniff), `usage.db.test.ts` (`user_entry_id`).
