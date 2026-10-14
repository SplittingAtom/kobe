# KOBE-209: B5: Inline system markers: model change, compaction, fork, interrupted, budget, approval

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-209-inline-markers` in `../Kobe-wt209`
- **Depends on:** KOBE-208 (merged, main cc6b05d0)

## Plan

1. Server (own commit, for the Opus security review): `GET /v1/threads/{id}/markers`.
2. Web: parse `model_change` / `compaction`, place them in the tree projection, render thin marker
   rows (`components/chat/markers.tsx`), fork marker with the existing branch picker, run and
   approval markers from the new route.

## Decisions

- **Where entry markers live.** Never as messages of their own (that would break grouping, heads
  and the branch picker). `tree.ts` places a marker where its entry sits: inside a turn as a
  `data-kobe-marker` part; after a message's last entry as `meta.after`; below a fork or the root
  as `meta.before` on the first message under it, so a marker shows on its own branch only (a
  model change on one edit branch is not shown on the other).
- **Compaction count.** "Folded" = conversation (`message`) entries above `firstKeptEntryId` on the
  compaction's path, stopping at an earlier compaction's first kept entry (what Pi newly folded).
  Unknown (not shown) when the first kept entry is not a loaded ancestor. An offloaded compaction
  is a marker with "too large to show here", no longer an "offloaded part of the answer".
- **Compaction expands with the Detail toggle** (same `useDisclosure` as reasoning and tool cards).
- **Fork marker.** "Forked here · N branches" with the existing `BranchPicker` (moved from
  `messages.tsx` to `markers.tsx`) at the top of every message that has siblings; it replaces the
  picker's old place under the message (no duplicate controls). N comes from assistant-ui's
  `branchCount`, i.e. the branches the picker can switch to.
- **Run / approval outcomes are not in the entry list.** Runs' terminal status and approvals live in
  `runs` / `approvals`. New route (server change, own commit):
  `GET /v1/threads/{id}/markers` → `{runs: [{run_id, status: interrupted|budget_stopped,
  user_entry_id, parent_entry_id, ended_at}], approvals: [{approval_id, run_id, tool_call_id,
  status: allowed|denied|expired, cause, decided_at}]}`.
  - Visibility like the thread (`findThread`: owner or project reader), team-scoped under RLS,
    `team_id` stated in every query; 404 `thread_not_found` otherwise.
  - Approvals only where `user_id` = caller (the run's user, as `GET /v1/approvals`): a reader of a
    shared thread gets none. Outcome only: never input, reasons, decider or token columns.
  - Newest 500 of each, returned oldest first. Reads Postgres only.
- **Placement of run markers** (`placeRunMarkers`): after the last answer to the run's prompt; under
  the prompt when nothing answered; after the message it continued from when the prompt never
  reached the tree. Order after a message: how its run ended, then entries Pi wrote after it.
- **Approval marker** sits right after its tool card (keyed by `tool_call_id`).
- The client reads markers when the thread opens and after each run ends (like the usage footer).

## Open questions (for Chris or the coordinator)

- Size: ~1,200 added lines (about 490 of them tests). Split if wanted: (a) server route + DB test;
  (b) web entry markers + fork marker (`entries.ts`, `tree.ts`, `markers.ts` entry half,
  `markers.tsx` without the provider); (c) web run/approval markers (provider, API, FakeKobe route).
- Expired approvals show "Approval expired" (cause not shown); cancelled/failed runs get no marker
  (Pi's own "This step was stopped." already shows for a Stop).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `components/chat/markers.test.tsx` "renders each kind in place…" (recorded FakeKobe
  thread: model change ×2, approval granted/denied, run interrupted, compaction, fork, budget stop,
  in DOM order) and "expands a compaction to Pi's summary and the count of folded messages".
- **ac-2** `markers.test.tsx` "shows the branch count with a picker that switches the leaf"
  (POST `/leaf` with the other branch's last entry; the budget marker leaves with its branch).
- **ac-3** `lib/chat/tree-markers.test.ts` (placement inside a turn, after, before a fork's branch,
  folded counts, offloaded compaction) and `lib/chat/tree.test.ts` unchanged and green; full web
  suite green (109 files).
- Server: `services/server/src/thread-markers.db.test.ts` (owner sees runs + decided approvals and
  no input; teammate/other team 404; project reader sees runs, no approvals).
