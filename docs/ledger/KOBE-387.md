# KOBE-387: SMA12: Seeded relevance set and FTS recall@8 harness

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** local commit, not pushed (coordinator reviews and opens the PR)
- **Branch / worktree:** `kobe-387-sm-harness` in `../Kobe-wt387`, on `kobe-382-sm-selection`
  (PR #564, not merged)
- **Depends on:** KOBE-382 (selector), KOBE-376 (split tables), KOBE-383 (gate-7a.md method).
  **No migration.** No product behaviour change.

## What it adds

- `e2e/memory-eval.sh relevance|cache` → `services/server/vitest.eval.config.ts` (own config:
  `src/testing/memory-eval/*.eval.ts`, never in `pnpm test`/`test:db`/verify).
- `src/testing/memory-eval/relevance.eval.ts`: throwaway DB (createTestDatabase on
  `KOBE_TEST_DATABASE_URL`, dropped after), seeds `e2e/fixtures/memory-relevance/items.json` into
  `semantic_memory_items` (team/user), `portable_memory_items`, `site_memory_items` with versions
  aged by `age_days`; one untitled thread + run; each query through `readRunCandidates`; prints
  the Markdown table + misses; JSON to `KOBE_EVAL_OUT`.
- `src/testing/memory-eval/cache.eval.ts`: 20-turn replay over the public API (sign-in or cookie,
  optional Workspace/agent/model, optional `KOBE_EVAL_SEED=1` from
  `e2e/fixtures/memory-cache/seed.json` = gate-7a step 2), waits for each run's terminal event,
  reads `GET /v1/threads/{id}/usage`, prints share all / turns 2-20. Env only; nothing committed.
- `src/testing/memory-eval/score.ts` (+ `score.test.ts`, 12 tests): fixture schemas and
  cross-checks, rankings, recall@k, per-query scoring (recall per mode, in block, negative above
  answer), macro summaries per kind/style, 0.85 line, cache shares with gate-7a's prompt
  definition (input + cache read + cache write).
- Product code (refactor only): `select.ts` `relevanceScore()` split out of `memoryScore()` (same
  sum order, same floats); `run-memory.ts` `toCandidates()` split out of `select()` and new
  `readRunCandidates()` (context + lanes read exactly as `buildRunSemantic`, no records).
- Fixtures README with the construction; `docs/gates/gate-7a.md` = KOBE-383's file + the harness
  run instructions + the relevance section with results.

## Decisions

- **Gate number = recall@8 over SM24 relevance** (`ts_rank_cd + 0.3·trigram + 0.1·recency`) among
  the selector's eligible candidates. The full selector score adds 0.5 to person-lane
  preferences, which then fill every top 8 (0.174 overall): that measures the base, not
  retrieval. Both are reported, plus "in block" at the default budget.
- **Independent construction:** items by me first; queries by a separate agent that saw only
  `items.json` (no selector code), fixed style quotas (10/12/8 per kind), hard negatives; one
  query (q151, the ticket's example) added before the first run; nothing changed after it.
- **Cache replay over the public API**, not kubectl/DB: runs against any install from the
  operator's machine; the usage endpoint reads the same `run_usage` rows as gate-7a's SQL.
- gate-7a.md is a superset of KOBE-383's version (its text verbatim first), so the add/add
  conflict on rebase resolves by taking this side.

## Results (dev Postgres, 2026-11-13; two runs identical)

recall@8 (relevance): **overall 0.573**; preference 0.633, fact 0.517, convention 0.533,
definition 0.645, decision 0.533; literal 0.980, paraphrase 0.139, indirect 0.725. In block
0.669. → below 0.85: Phase D indicated on this set. Full table and reading in gate-7a.md.

## Open questions (for Chris or the coordinator)

- Gate A should weigh the mix: without the strict paraphrases the number is 0.87. The paraphrase
  failures are eligibility (no FTS word match → never a candidate; trigram only ranks), so a
  cheaper alternative to vectors would be letting a trigram threshold make an item eligible —
  not tried here (no tuning in this ticket).
- `cache` not run (needs a real provider): Gate A runs it on gate1 before/after KOBE-383.

## Evidence

- ac-1: `e2e/fixtures/memory-relevance/{items,queries}.json` + `README.md`; `score.test.ts`
  parses the committed fixtures (≥150 queries, ≥30 per kind, all styles).
- ac-2: `e2e/memory-eval.sh relevance` output (table above); `cache` mode implemented, unit-tested
  share maths, documented in gate-7a.md.
- ac-3: `docs/gates/gate-7a.md` "Relevance: FTS recall@8".
- Verify: typecheck, lint, all unit suites except web, server `test:db` (3,020), license and
  hygiene checks green. `write-paths.test.ts` sweep now skips `*.eval.ts` (fixture seeding, like
  tests). Web `lib/chat/context-memories.test.ts` fails deterministically on the base branch
  (label "Only in this workspace" vs expected "My memories in this workspace"; KOBE-382 test vs
  newer wording from main); untouched here, for the KOBE-382 branch.
