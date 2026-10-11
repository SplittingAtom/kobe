# KOBE-259: Per-model output limit and context window in the model catalog

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review: migration PR #244, feature PR stacked on it
- **Branch / worktree:** `kobe-259-migration` (PR #244) and `kobe-259-per-model-output-limit` in `../Kobe-wt259`
- **Depends on:** KOBE-258 (runs that stop at the output limit fail `model_output_limit`; unchanged here)

## Plan

1. Migration PR (#244): `model_catalog.max_output_tokens`, `context_window` (nullable, bounded) and
   `reasoning` (boolean, default false); absorbs KOBE-210's migration.
2. Feature PR: effective limits resolved by the server and sent in `run.start`, used by the
   sandbox's Pi model entry; site console models page; gateway reservation and a clear refusal.

## Decisions

- **Migration `0090_model_token_limits`.** `model_catalog` is install-wide (no `team_id`, no RLS;
  grants unchanged), so no probe fixture changes: the cross-team probe covers team tables only.
- **Bounds.** `max_output_tokens` 256..131,072 (`MODEL_OUTPUT_TOKENS_RANGE`); `context_window`
  1,024..10,000,000; output < window when both are set. The API also checks an output limit against
  the default window when the model has none (`output_limit_exceeds_context`, 400).
- **Reasoning flag.** Nothing in the catalog said whether a model reasons: Pi's `reasoning` field in
  `kobe-models/provider.ts` is inferred from the API style, and glm-5.3 (the KOBE-258 incident)
  reasons behind `openai-completions`. So an explicit admin-set column, default false (existing
  models keep today's 16,384 until an admin flags them). It only picks the default output limit;
  Pi's own `reasoning` (thinking parameters) is unchanged.
- **Defaults** (`services/server/src/models/token-limits.ts`, chart `server.modelDefaults`, env
  `KOBE_MODEL_DEFAULT_*` on server and scheduler):
  - 16,384 output for other models: the old constant, so nothing changes for them.
  - 32,768 for reasoning models: twice that, above the 16,384 glm-5.3 spent reasoning, while a
    call's budget reservation stays moderate. Not any provider's maximum (not guessed): a provider
    that allows less refuses the call, and the admin then sets the model's own limit.
  - 128,000 context window: the old constant.
  - A default output that would fill a smaller window becomes half the window.
- **Wire.** `run.start.config.model_limits {max_output_tokens, context_window}` (new optional key,
  not inside `model`, which is strict: an older agent strips the key instead of rejecting the frame).
  An older server sends none: the agent keeps 16,384 / 128,000. The model file carries both;
  kobe-models re-selects the model when only its limits changed (admin edit between runs).
  Pi sends `maxTokens` as each call's `max_tokens` / `max_completion_tokens` / `maxOutputTokens`,
  clamped to window - input - 4,096 (pi-ai `clampMaxTokensToContext`).
- **Gateway.** Reservation already used the request's cap; its ceiling
  (`MAX_CHARGED_OUTPUT_TOKENS`) was 65,536 and is now the catalog ceiling 131,072, so any configured
  limit is reserved in full. ac-4 "a budget smaller than one call fails clearly" means (review
  rounds 1 and 2): a request whose **input estimate alone** exceeds a budget's **limit** (not what
  is left) is refused at once, alone or not: 402 `budget_below_call`, run error
  `model_budget_too_small`, message "the request's input is larger than the whole budget".
  Comparing the full allowance refused modest budgets outright (20,000 tokens/day, $1/day at
  $75/M output), a regression. A budget below one call's output allowance behaves exactly as
  before: a lone call is admitted and may overshoot, overlapping calls get 429 and retry,
  exhaustion ends `budget_stopped`.
- **E2E still adapted to that rule.** Gate 2's $0.01 budget is below Pi's prompt as input (about
  10k tokens, ~$100 at the e2e price), so it would now be refused: the budget is $1,000 and the fake
  model's tool step reports a 1,000,000-token prompt so the step still uses it up (run.sh, gate2.sh
  ac-1, docs/gates/gate-2.md). KOBE-121 replicas: limit = spent today + 1 is below one request's
  input (~22 tokens) when the member spent little, so the member first spends 4 calls.
- **Charges on interrupted calls (review L1).** A call stopped or cut off without a usage report is
  charged at least its output allowance (existing policy: hidden reasoning is never seen), which is
  now the model's limit: 2x for the reasoning default, up to 8x for a 131,072 admin limit. Documented
  in values.yaml, the models page hint and docs/install.md. Charging actual output instead is a
  small code change (`UsageMeter.finish` drops `outputAllowance` for client aborts) but a policy
  change: provider-side reasoning would then go uncharged on every Stop.
- **Protocol in the feature PR.** `model_limits` and `model_budget_too_small` are additive contract
  changes made in the feature PR rather than a third PR (flagged for the coordinator).

## Open questions (for Chris or the coordinator)

- kobe-gate1: flag glm-5.3 as reasoning (or set its limit) on the Models page after deploy;
  existing catalog rows default to `reasoning = false`.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/models.db.test.ts` (defaults, bounds, output < window); PR #244 CI.
  KOBE-210: ac-1 met (column, catalog tests, admins set it on the models page); ac-2 met (team
  models, the chat's catalog, include `context_window`, null allowed: `services/server/src/models.db.test.ts`);
  ac-3 n/a (no OpenAPI document covers the models routes).
- ac-2: `services/server/src/models.db.test.ts` "install admins set a model's output limit…";
  `apps/web/components/admin/models-pages.test.tsx` (KOBE-259 cases); `token-limits.test.ts`,
  `config.test.ts`; chart `tests/model-defaults.test.ts`.
- ac-3: `services/server/src/runs-model.db.test.ts` (run.start `model_limits`: catalog values,
  reasoning default, half-window, plain default); sandbox `provider.test.ts`, `protocol.test.ts`,
  `model-file.test.ts`, `run-token.test.ts`; `kobe-models.real-pi.test.ts` "sends the run's output
  limit as max_tokens" (real Pi 1.0.0: upstream saw 50,000 on OpenAI, Anthropic and Gemini, and
  16,384 without limits).
- ac-4: `services/model-gateway/src/budget-gate.test.ts` "large output allowances" (full
  reservation of 131,072; `budget_below_call` for tokens and dollars); `usage/meter.test.ts`;
  real-Pi test above (`outputAllowance` 50,000); sandbox `errors.test.ts`; server
  `runs/failure-codes.test.ts`.
