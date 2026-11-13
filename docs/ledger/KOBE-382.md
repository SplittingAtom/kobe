# KOBE-382: SMA7: Selection, run.start assembly, run recording and 'Memories in context'

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (local commit, not pushed)
- **Branch / worktree:** `kobe-382-sm-selection` in `../Kobe-wt382`, on `kobe-646-sm-agent-memory`
  (PR #542)
- **Depends on:** KOBE-377 (contract), KOBE-378 (store/tables), KOBE-381 (switches, Site
  settings), KOBE-646 (`agents/run-memory.ts` plan). **No migration.**

## What it does

- `services/server/src/memory/items/select.ts` — pure selector. Score =
  `ts_rank_cd + 0.3·trigram + 0.1·recency(180 d)` + 0.5 base for preferences in the `user` and
  `portable` lanes + 0.2 for items the thread's previous run got. Policy first, always, all of
  it; then lanes `user → portable → team → site` each fill a 1 KiB floor (rendered bytes, lane
  header paid by its first item), then the rest of the Site's `context_budget_kib` flows to the
  best remaining candidates of any lane. Pinned before relevance within a lane. Whole items only
  (a misfit is skipped, a smaller later one may still fit); ≤ 100 items; `omitted_count` = eligible
  items not given (including ones the store did not read).
- **Cache-stable order:** Policy (by id), pinned (lane render order `site, team, portable, user`,
  then id), then per-message picks (same lane order, then id). Same selection → same bytes;
  Policy + pinned prefix unchanged between messages (unit test).
- **Eligible:** pinned, sticky, a person-lane preference, or a query word matched (FTS). Trigram
  only ranks (see perf below).
- `services/server/src/memory/items/run-memory.ts` — `buildRunSemantic(tx, …)` in the run's
  `withTeam()` transaction: (1) one query for switches + Site settings
  (`switches.ts runMemoryStateQuery`, same values as `readSwitches`/`readMemorySiteSettings`) +
  thread title, agent and project names, last two user messages, previous message run's item
  ids; (2) one `UNION ALL` over the enabled lanes; (3) one insert statement into
  `run_memory_items` / `run_portable_memory_items` / `run_site_memory_items`
  (`ON CONFLICT DO NOTHING`, never deletes: run records can be under legal hold; a re-delivered
  start adds on top). Result is parsed with `runSemanticMemorySchema` (fail closed).
- **Query (SM24):** this message + thread title + previous two user messages + agent and project
  names; words (letters/digits, ≤ 64) OR-ed into `to_tsquery('english', …)`; trigram against this
  message (≤ 500 chars).
- **Walls:** Workspace rows under RLS (`locate()` adds `owner_user_id = runner` for `user`);
  portable rows `owner_user_id = runner`; Site lane only while `scopes.site`; Policy only on
  `memory.policy` (Site master). Lanes from `effectiveMemory` (KOBE-381).
- **Delivery (`sandbox-wire/delivery.ts`):** inside the existing Notes branch (`plan.notes`), adds
  `semantic` only when `plan.semantic` (KOBE-646: `all`, not a test chat or skill eval) **and** the
  agent announces `semantic_memory`. Eval sandboxes never get memory (unchanged). Agent evals
  (Orbit Jobs) have no run.start at all. A failure sends the run without the block (logged).
  Workspace memory off → `scopes: []` and Policy only; Site master off → no `semantic`.
- **Show:** `GET /v1/threads/{id}/context/memories` (`routes/thread-context.ts`; OpenAPI; schema
  `threadContextMemoriesSchema` in `protocol/context-viewer.ts`): the latest message run's records
  joined to the versions it got, in render order, lane per item. Owner only: 403 `not_owner` for a
  shared reader, 404 otherwise; personal/portable rows re-filtered by owner. Web: the context
  viewer's collapsible **Memories in context (n)** list per lane (labels
  `CONTEXT_MEMORY_SECTION_LABELS`, plain text) and Session info's **Memories in context** row
  (owner only; no row for readers, no request either).
- **Docs:** `docs/guide/memory.md` "Memories in a run" + "See which memories a run got"; front
  matter summary (feeds `/llms.txt`).

## Decisions

- **Re-pick every message (Q6).** Stickiness is the only memory of earlier picks.
- **Trigram computed in the server** (`items/trigram.ts`, pg_trgm-compatible: padded words,
  |A∩B|/|A∪B|; numeric trigrams, BMP exact). In Postgres, `similarity()` re-trigrams the message
  per row (~25 µs/row, no index under FORCE RLS) and alone blew the budget (p50 220 ms).
- **Two-step lane read:** every eligible row ranked by cheap `ts_rank` + base + sticky + recency;
  the best `LANE_READ_MAX = 64` get `ts_rank_cd` and the trigram; the selector orders by the full
  score. Eligible rows past 64 count as omitted (the block holds ~80 items at 16 KiB with typical
  statements, 100 max).
- **Context viewer section from the run records**, not the sandbox: the rendered block and the
  splitter are KOBE-383's; this list works with today's agents and survives a sandbox restart.
- Policy counts as the `site` table's records (`run_site_memory_items`); its lane shows as Policy.
- `notes_only` / `off` / test chat → no records written.

## Evidence

- ac-1 `memory/items/select.test.ts` (13): Policy first and kept at 4 KiB, floors, flow-on, pins,
  preference base, score formula, stickiness, whole items, `beyond`, deterministic order (shuffled
  input → identical items), stable prefix across messages, budget/cap at 4/8/16 KiB.
  `trigram.test.ts` (3) against pg_trgm values (`show_trgm('Cat')`, `similarity('word','two
words') = 0.363636`, a sentence 0.461538).
- ac-2/ac-3 `memory-selection.db.test.ts` (10): runner's own + Workspace + portable + Site + Policy,
  Policy then pinned first, records per table with versions; never another person's personal or
  portable items or another Workspace's (both directions, two Workspaces); re-pick per message;
  Site memories off keeps Policy, Workspace memory off → Policy only and `scopes: []`, Site master
  off → no `semantic`; no block or records for an agent without `semantic_memory`, a builder test
  chat, `notes_only` (Notes still sent), `off` (no `memory`); the agent's setting with the
  runner's memory; route: owner sees the run's items in render order, empty before a run, 404 for
  a non-reader, 403 `not_owner` for a project-share reader.
- Web: `context-viewer.test.tsx` (+2: list per lane, plain text, none when empty),
  `pi-commands.test.tsx` (+1: Session info count), `lib/chat/context-memories.test.ts` (3).
- ac-4 `memory-selection-perf.db.test.ts`: 1,000 Workspace items × 3 versions, 300 of the
  runner's, 50 portable, 1,000 Site, 25 Policy (2,000 B), ~all matching (small vocabulary), sticky
  previous run; 100 builds after 10 warm-ups, record writes included, own `withTeam` each.
  See numbers below. Default bound 200 ms (runs inside `pnpm verify`); `KOBE_PERF_STRICT=1`
  asserts 50 ms.

## Perf numbers (dev VM → remote dev Postgres, ~2.5 ms RTT; another agent's tests on the 4 CPUs)

| Version                                    | p50    | p95      |
| ------------------------------------------ | ------ | -------- |
| first cut (per-lane queries, SQL trigram)  | 222 ms | 257 ms   |
| two-step read, batched queries             | 79 ms  | 101 ms   |
| trigram in the server, 64 per lane, floats | 37 ms  | 47–55 ms |

Breakdown at the last row (p50): lanes UNION 24 ms (EXPLAIN: exec 17 ms + planning 5 ms),
context/state 3 ms, insert 2 ms, transaction 2 ms, server-side trigram/selection 3–4 ms. p95
moves with the VM's load (load average 4–6 during the runs); in-cluster Postgres (sub-ms RTT)
removes ~10 ms of round trips.

## Open

- p95 sits at the 50 ms line on this VM; a quiet run or Gate A (KOBE-388) on the cluster should
  confirm. Next levers if needed: a named prepared statement for the lanes UNION (saves ~5 ms of
  planning per run), or reading in the same transaction as `buildRunMemory`.
- KOBE-383 renders the block, teaches the splitter, and may reuse this list for its sections.
- KOBE-387 relevance harness may retune weights/`LANE_READ_MAX` (constants in `select.ts`,
  `run-memory.ts`).
