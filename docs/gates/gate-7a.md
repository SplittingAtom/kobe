# Gate A evidence: prompt-cache share of "What Kobe knows" (KOBE-383)

v1.3 Semantic Memory, wave A7 (KOBE-383 ac-4; Chris 2026-11-12, Q6: re-pick every message, keep the
stable parts first so the provider caches the prefix). This page records the **cache-read share**
on a 20-turn thread before and after KOBE-383. The numbers are **not filled in yet**: they need a
real provider that reports cache counters, so they are measured on gate1 at Gate A. The fake
upstream model used in CI and on the dev VM reports no cache tokens, so nothing could be measured
when KOBE-383 was built.

## What changed

Before KOBE-383 the memory fence carried a fresh random nonce every run, so the system prompt
changed near its start on every message and no later token could be read from the cache. After it:

- the nonce is per thread (HMAC of the thread id under the agent process's key), so the memory
  blocks are byte-identical across runs of a thread;
- the run's additions are ordered stable first: What Kobe knows (preamble, Policy, pinned),
  Notes indexes, project instructions, then the per-message picks, the viewed file and sync
  conflicts.

The picks are re-picked every message (SM24), so a message whose picks change still breaks the
cache from the picks onwards (that includes the conversation history after the system prompt).
The measurement shows how much the stable prefix buys in practice.

## Method

1. Pick a team model whose provider reports cached prompt tokens (Anthropic `cache_read_input_tokens`
   or OpenAI-compatible `prompt_tokens_details.cached_tokens`; the gateway normalises both into
   `cacheRead`, `services/model-gateway/src/usage/normalize.ts`, and records it as
   `run_usage.cache_read_tokens`, `usage/sink.ts`).
2. Seed the member's memory: 3 Policy rules, 2 pinned Workspace memories, 10+ other memories across
   the four places, and a Notes index of a few lines.
3. **Before:** on an install at the commit before KOBE-383 (the KOBE-382 build), open a new
   thread with a Kobe agent whose Memory setting is Full and send the 20 scripted messages in
   `e2e/browser` style (fixed texts, one per turn, each waiting for the run to finish). Note the
   thread id.
4. **After:** deploy the KOBE-383 build, repeat step 3 in a new thread with the same messages.
5. For each thread, from the gate1 database (`kobe-gate1-deps`, read-only):

   ```sql
   SELECT count(*) AS calls,
          sum(cache_read_tokens) AS cache_read,
          sum(input_tokens + cache_read_tokens + cache_write_tokens) AS prompt,
          round(100.0 * sum(cache_read_tokens)
                / nullif(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0), 1)
            AS cache_read_share_pct
   FROM run_usage
   WHERE team_id = :team AND thread_id = :thread;
   ```

   Also note the share for turns 2-20 only (turn 1 can never read the cache).

6. Record both rows below with the model, the commits and the date.

## Results

_To be filled at Gate A on gate1._

| Build                   | Model | Thread | Calls | Cache read | Prompt tokens | Share (all) | Share (turns 2-20) |
| ----------------------- | ----- | ------ | ----- | ---------- | ------------- | ----------- | ------------------ |
| Before (KOBE-382 build) |       |        |       |            |               |             |                    |
| After (KOBE-383 build)  |       |        |       |            |               |             |                    |

### Running the replay with the harness (KOBE-387)

`e2e/memory-eval.sh cache` does steps 3-5 from any machine with the repository (`pnpm install`),
through the install's public API as the member: it signs in, creates a new thread, sends the 20
messages of `e2e/fixtures/memory-cache/turns.json` one per turn (each after the previous run's
terminal event; they ask for no tools), then reads `GET /v1/threads/{id}/usage` (the same
`run_usage` rows as the SQL above) and prints the share over all turns and over turns 2-20.
`KOBE_EVAL_SEED=1` first creates the step 2 memories from `e2e/fixtures/memory-cache/seed.json`
(once per install, before the "before" replay; Policy needs a Site admin; add the Notes index by
hand). Everything about the install comes from the operator's shell; nothing is committed:

```bash
export KOBE_EVAL_URL=https://<install>            # public URL
export KOBE_EVAL_EMAIL=<member> KOBE_EVAL_PASSWORD=<password>   # or KOBE_EVAL_COOKIE=<Cookie header>
export KOBE_EVAL_TEAM_ID=<workspace id>           # optional: default is the active Workspace
export KOBE_EVAL_AGENT_ID=<agent id>              # an agent whose Memory setting is Full
export KOBE_EVAL_MODEL=<alias>                    # a model whose provider reports cached tokens
KOBE_EVAL_SEED=1 KOBE_EVAL_LABEL=before KOBE_EVAL_OUT=before.json e2e/memory-eval.sh cache   # KOBE-382 build
# deploy the KOBE-383 build, then:
KOBE_EVAL_LABEL=after KOBE_EVAL_OUT=after.json e2e/memory-eval.sh cache
```

A turn that does not end in `run.completed` stops the replay. "No cache reads at all" means the
provider reports no cached tokens: pick another model. Cross-check one thread with the SQL above.

## Relevance: FTS recall@8 (KOBE-387, SM25/SM30)

Gate A's other number: does the KOBE-382 selector (Postgres full text with the fixed `english`
config + 0.3 · trigram + 0.1 · recency) find the right memories? Phase D (vectors) only if overall
recall@8 is below **0.85**.

**Set.** `e2e/fixtures/memory-relevance/`: 121 items of a fictional company over all four lanes
(24 preferences, 34 facts, 21 definitions, 21 conventions, 21 decisions, 8 of them unrelated
noise) and 151 queries, 30+ per kind, labelled literal (50), paraphrase (61, no content word or
stem shared with the answer) and indirect (40, a task that needs the item). 95 queries list hard
negatives. Items and queries were written by different authors; the queries were frozen before
the first run and nothing was tuned afterwards (construction: the fixtures' README.md).

**Method.** `e2e/memory-eval.sh relevance` seeds the items into a throwaway database (created and
dropped on `KOBE_TEST_DATABASE_URL`'s server) over the split tables, then sends each query as a
run's message through the selector's own store read (`readRunCandidates`, the same SQL and
trigram as `buildRunSemantic`; a fresh untitled thread, so no earlier messages or stickiness).

- **recall@8 (relevance)**, the Gate A number: the selector's eligible candidates (a query word
  matched, pinned, or a person-lane preference) ordered by the SM24 relevance score; share of a
  query's expected items in the first 8, averaged over queries.
- **recall@8 (selector score)**: the same with the selector's full score, which adds 0.5 to every
  person-lane preference. The 24 preferences then fill the top 8 of every query, so this column
  measures the base, not retrieval; it is shown so nobody mistakes it for the gate number.
- **in block**: share of expected items inside the block actually selected at the default 8 KiB
  budget (what the agent sees).
- **negative above answer**: queries with hard negatives where one ranked above the answer.

**Results** (2026-11-13, KOBE-382 selector at `0da68a6c`, dev Postgres 17; two runs, identical):

| Group             | Queries | recall@8 (relevance) | recall@8 (selector score) | in block | negative above answer |
| ----------------- | ------- | -------------------- | ------------------------- | -------- | --------------------- |
| **overall**       | 151     | **0.573**            | 0.174                     | 0.669    | 17.9%                 |
| preference        | 30      | 0.633                | 0.678                     | 0.983    | 22.2%                 |
| fact              | 30      | 0.517                | 0.000                     | 0.550    | 18.8%                 |
| convention        | 30      | 0.533                | 0.033                     | 0.533    | 23.5%                 |
| definition        | 31      | 0.645                | 0.000                     | 0.677    | 19.2%                 |
| decision          | 30      | 0.533                | 0.167                     | 0.600    | 5.6%                  |
| style: literal    | 50      | 0.980                | 0.300                     | 1.000    | 11.1%                 |
| style: paraphrase | 61      | 0.139                | 0.082                     | 0.287    | 32.5%                 |
| style: indirect   | 40      | 0.725                | 0.158                     | 0.838    | 3.6%                  |

**Reading.** 0.573 < 0.85: on this set Phase D (vectors) is indicated. Literal questions are
solved (0.98); the gap is paraphrase (0.14): 53 of the 61 paraphrase queries miss, and in 43 of
them no expected item was even a candidate, because eligibility needs a full-text word match and
trigram similarity only ranks. More weight on trigram would not help them; meaning-level matching would. The headline
depends on the mix (40% strict paraphrases here, written to be hard); with literal and indirect
queries alone it would be 0.87. Gate A (KOBE-388) decides with these caveats.
