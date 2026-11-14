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
