# Memory relevance set (KOBE-387)

The seeded store and queries behind `e2e/memory-eval.sh relevance` (Gate A's FTS recall@8,
v1.3 SM25/SM30; results in `docs/gates/gate-7a.md`). KOBE-400 adds the extractor eval to the same
harness.

## Files

- `items.json`: 121 memories of a fictional analytics company (Larkspur) across the four lanes the
  selector reads: `user` (the runner's own in the Workspace), `portable` (the runner's
  preferences), `team` (the Workspace) and `site`. Kinds: 24 preferences, 34 facts, 21
  definitions, 21 conventions, 21 decisions. `age_days` sets each version's age (recency).
  Eight `noise-*` items are unrelated office trivia that no query expects.
- `queries.json`: 151 messages a member might send, each with its `kind` (the kind of its first
  expected item), `style`, `expected` items (1-3) and optional `negatives` (hard negatives).

## How it was built

1. **Items first.** The items were written as a plausible company memory before any query, with
   deliberate confusers next to the real answers: three revenue measures (ARR, MRR, a
   services-inclusive run rate) plus AR days and services revenue recognition; the team's
   lowercase-SQL convention next to the person's uppercase-SQL preference; NRR as a definition and
   as a board decision; pricing tiers next to the price rise; and so on.
2. **Queries by a separate author.** A different agent wrote the queries from `items.json` alone,
   with no access to the selector code or its weights, and without running anything. Per kind it
   wrote 10 `literal` (natural wording sharing key terms), 12 `paraphrase` (the same need with no
   content word or stem shared with the statement, checked word by word) and 8 `indirect`
   (a task that needs the item, e.g. "draft the Growth price-change announcement"), and listed hard
   negatives for 95 queries (items that look related but do not answer).
3. **One addition:** q151, the ticket's own example ("What's our revenue metric?" → the ARR
   definition), added before the first run.
4. **Frozen before the first run.** Nothing was changed after seeing results: no query reworded,
   no expected item moved, no weight tuned. The first run's numbers are the recorded ones.

## Limits

- The paraphrase share (40%) and their strictness are choices of this set; they are a stress test
  of word matching, not a sample of real traffic. The report gives recall per style so Gate A can
  weigh them.
- One store of 121 items, far below the scope limits (KOBE-382's perf test covers size); every
  lane's candidates fit in the selector's 64-per-lane read.
- English only (the store's search config is fixed to `english`, Q11).
