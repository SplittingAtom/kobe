# KOBE-259: Per-model output limit and context window in the model catalog

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (migration PR, feature PR follows)
- **Branch / worktree:** `kobe-259-per-model-output-limit` in `../Kobe-wt259`
- **Depends on:** KOBE-258 (runs that stop at the output limit fail `model_output_limit`; unchanged here)

## Plan

1. Migration PR: `model_catalog.max_output_tokens`, `context_window` (nullable, bounded) and
   `reasoning` (boolean, default false); absorbs KOBE-210's migration.
2. Feature PR: effective limits (catalog value, else configurable defaults) resolved by the server,
   carried in `run.start`, used by the sandbox's Pi model entry; site console models page; gateway
   reservation with the larger allowance and a clear refusal when a budget is below one call.

## Decisions

- **Migration `0090_model_token_limits`.** `model_catalog` is install-wide (no `team_id`, no RLS;
  grants unchanged: `tenancy/models.ts` already grants the app role on it), so no probe fixture
  changes: the cross-team probe covers team tables only.
- **Bounds.** `max_output_tokens` 256..131,072 (`MODEL_OUTPUT_TOKENS_RANGE`); `context_window`
  1,024..10,000,000 (`MODEL_CONTEXT_WINDOW_RANGE`); when both are set, output < window (room for
  input). 131,072 is a ceiling for typos, not any provider's maximum.
- **Reasoning flag.** Nothing in the catalog says whether a model reasons: Pi's `reasoning` flag in
  `kobe-models/provider.ts` is inferred from the API style, and glm-5.3 (the KOBE-258 incident)
  reasons behind `openai-completions`. So an explicit admin-set `reasoning` column, default false
  (existing models keep today's behaviour until an admin flags them). Not inferred from names.

## Open questions (for Chris or the coordinator)

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/models.db.test.ts` "output limit, context window and the reasoning flag"
  (defaults, bounds, output < window); db `test:db` 1055/1055 and server `test:db` 1230/1230 green locally.
- KOBE-210: its migration part (ac-1 column + catalog tests) is met by `0090`; its UI part is in
  the feature PR.
