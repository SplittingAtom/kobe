# Thinking controls (KOBE-260)

Site admins decide per model whether a reasoning model may think and how much; team admins can
only lower that; members pick a level per conversation; the **server and the model gateway**
decide what each call actually sends. Rules and types: `packages/protocol/src/thinking.ts`. The
gateway's mapping: `services/model-gateway/src/thinking.ts`.

## Levels

Provider-neutral and ordered: `off < low < medium < high`. Pi's wider set (`minimal`, `xhigh`,
`max`) is not offered: providers disagree on them and the four cover every control below.

## Settings

| Where                     | Field                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model_catalog` (site)    | `thinking_control`                 | How the gateway writes the level (table below). `none`: Kobe sends nothing, the provider decides, no level is recorded. Only on a model marked `reasoning` (KOBE-259), and only a control that fits its provider.                                                                                                                                                                                                                                                      |
|                           | `thinking_allowed`                 | False: every run is `off`. Only for a control that can turn thinking off (`anthropic_effort` is always allowed).                                                                                                                                                                                                                                                                                                                                                       |
|                           | `thinking_default`, `thinking_max` | Set exactly when allowed: the level runs use when the conversation chose none, and the highest level members may pick (`default <= max`, `max > off`).                                                                                                                                                                                                                                                                                                                 |
|                           | `thinking_lowest`                  | `off`, or `low` for a model that cannot turn thinking off (review S2). With `low`, "off" means low everywhere, so it never reaches the provider as off and never fails. Known families default to `low` and an `off` for them is refused (`thinking-models.ts`: o-series, GPT-5, GPT-5 Pro, Gemini 2.5/3 Pro, Claude Sonnet/Opus 5.5, Fable, Mythos); `anthropic_effort` is always `low`; `anthropic_budget` is refused for Claude models that reject `budget_tokens`. |
| `team_models` (team, RLS) | `thinking_max`                     | The team's ceiling: null = the site's; `off` turns thinking off for the team. The API refuses a value above the site's maximum; at read time it is clamped again, so a later site change never widens it.                                                                                                                                                                                                                                                              |
| `threads` (team, RLS)     | `thinking_level`                   | The conversation's choice (any level; null = the model's default). Kept when the model changes.                                                                                                                                                                                                                                                                                                                                                                        |
| `runs` (team, RLS)        | `thinking_level`                   | The run's effective level, fixed when it starts (also `run.started.thinking_level`, the per-run usage, the answer footer).                                                                                                                                                                                                                                                                                                                                             |

Effective level at run start: `clamp(conversation ?? default, lowest, min(site max, team max))`,
the lowest level when thinking is not allowed (site or team). When several catalog aliases name
one provider model, the strictest of their policies applies, on the server and the gateway alike
(`strictestThinkingPolicy`), so the recorded level is the one on the wire. Same rules on the
server (`runThinkingLevel`) and the gateway (`callThinkingLevel`); the database checks the shapes.

## In the composer

The conversation's level sits beside the model picker, shown only when the model lets members
choose (`thinking_in_team.levels` not empty). Since KOBE-556 it is assistant-ui's Reasoning effort
control, vendored as `apps/web/components/chat/thinking-effort.tsx` (MIT notice kept): one pill
per allowed level (Off, Low, Medium, High) in a group named "Thinking level for this
conversation", `aria-pressed` on the conversation's choice as runs get it, else on the default's
pill (described as "Model's default"; choosing it stores null, so the conversation keeps
following the default and a member cannot pin the default level explicitly). It replaced KOBE-260's `<select>`; storage is unchanged (`PATCH /v1/threads/{id}`
`thinking_level`, or the new conversation's draft). It folds into the "Agent and model" menu on a
narrow composer (KOBE-418) and is the compact pills on the line below it (KOBE-450). The pressed
pill is the theme's inversion (`bg-foreground text-background`; forced colours keep its outline)
and the pill text is centred in both sizes (KOBE-574). The control is the pill track alone: the
spend bar and "spent / budget" readout of KOBE-556/557 were removed (KOBE-574); the reasoning
spend shows in Session info instead (KOBE-584, below).

## Mapping (gateway)

| Control              | Route (refused on any other)             | `off`                                                                          | `low` / `medium` / `high`                                                                                                                                                                  |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reasoning_effort`   | `/v1/chat/completions`                   | `reasoning_effort: "none"`                                                     | `reasoning_effort: "<level>"`                                                                                                                                                              |
|                      | `/v1/responses`                          | `reasoning: {effort: "none"}`                                                  | `reasoning: {effort: "<level>"}`, plus the caller's `summary` if `auto`/`concise`/`detailed` (KOBE-601)                                                                                    |
| `anthropic_adaptive` | `/anthropic/v1/messages`                 | `thinking: {type: "disabled"}`                                                 | `thinking: {type: "adaptive", display: "summarized"}`, `output_config: {effort: "<level>"}`                                                                                                |
| `anthropic_effort`   | `/anthropic/v1/messages`                 | (not offered: lowest is `low`)                                                 | as above                                                                                                                                                                                   |
| `anthropic_budget`   | `/anthropic/v1/messages`                 | `thinking: {type: "disabled"}`                                                 | `thinking: {type: "enabled", budget_tokens: 2048 / 8192 / 24576}`, at most `max_tokens` − max(1,024, ¼ of `max_tokens`) (S3); under 1,024: off (or 1,024 for a model that cannot turn off) |
| `gemini_budget`      | `/genai/v1beta/models/*:generateContent` | `generationConfig.thinkingConfig: {thinkingBudget: 0, includeThoughts: false}` | `thinkingBudget: 1024 / 8192 / 24576`, `includeThoughts: true`                                                                                                                             |

Which control a model needs is the admin's choice (Site → Models), never guessed from its name:

- **Ollama** (also Ollama Cloud) and **OpenAI-compatible** servers: `reasoning_effort`. Bifrost
  passes it to the provider's OpenAI-compatible API; Ollama maps `none` to `think: false`.
- **OpenAI**: `reasoning_effort`; mark models that cannot turn reasoning off (o-series, GPT-5)
  with lowest `low` (known families are set so automatically).
- **Anthropic**: `anthropic_adaptive` where `disabled` is accepted, `anthropic_effort` where
  thinking cannot be disabled (the newest models), `anthropic_budget` for older models.
- **Gemini**: `gemini_budget` (0 turns thinking off only on models that allow it).

## Enforcement

- **Every sandbox call** to a model with a control is rewritten by the gateway: the level is the
  run's recorded level (`runs.thinking_level`, read by run id and cached, a run without a level
  too; attribution as KOBE-118), clamped to the site and team settings in force now (the
  principal, cached ≤ its TTL).
- **Rewrite, never merge (review S1).** The body is parsed; every top-level reasoning field is
  removed in any letter case Bifrost's decoder accepts (sonic, matching keys case-insensitively
  as Go's `encoding/json` does, Unicode folding such as the Kelvin sign included): `reasoning*`,
  `thinking*`, `think`, `enable_thinking`, `budget_tokens`, `effort`, `output_config` (its
  `format` is kept), `chat_template_kwargs`, `extra_body`, `extra_params`, and Gemini's
  `thinkingConfig` in every generation config. Then the gateway's fields are written once. An
  appended duplicate would not do: Go decodes a repeated object key into the earlier value, so a
  caller's `budget_tokens` would survive. Bifrost v2.2.5's source knows `thinking.type` adaptive,
  `display` and `output_config.effort` (`core/providers/anthropic/types.go`); the forms are not run
  against a Bifrost image in CI (the unit test decodes with Go semantics instead).
- `max_tokens` in any letter case collapses to one key with the value Go would read (the last),
  so the budget below and the provider see the same limit (re-review R1).
- Anthropic budget without room (re-review R3): a model that can turn thinking off gets
  `disabled` (thinking would starve the answer, KOBE-258); one that cannot gets 1,024 while
  `max_tokens` is above it, else 400 `thinking_budget_too_small` (no form would be accepted).
- Unknown provider fields never pass: the gateway never sends `x-bf-passthrough-extra-params`
  (and strips any `x-bf-*` a caller sends). Count-token calls pass unchanged.
- **Fallbacks are refused (review S5).** A top-level `fallbacks` in any case would let Bifrost
  retry the call on another model past every per-model check; sandbox calls with it get 400
  `fallbacks_not_supported`.
- **Calls without a run (review S4).** Which calls legitimately name no run: Orbit eval Jobs
  (their token is the eval's; no run exists) and, while `requireRunToken` is off for rollout,
  agents older than the run-token capability. Anything else is code in the sandbox calling the
  gateway past Pi. Rule: an eval's call uses the model's default level; every other call without a
  run gets the **lowest** level, so leaving out the run headers never raises thinking. With
  `requireRunToken` on, such calls are refused before this point (eval Jobs as well, KOBE-118).
- **Reservations (review S7).** A budget the gateway writes (Anthropic `budget_tokens`, Gemini
  `thinkingBudget`) is output: the call's reservation is raised to at least that budget.
- A controlled model called through another API is refused (400 `thinking_route_refused`).
- The run token is unchanged (no new claim): the level is in the server's record.
- **Server calls** (titles, follow-ups; KOBE-219/222) keep `reasoning_effort: "low"` and their caps,
  whatever the conversation chose, and even when the site does not allow thinking for the model
  (by design, review N6: they are short, capped and budgeted on their own).
- Reasoning tokens are output tokens: the KOBE-259 output limit and budget reservations apply as
  before.

## Budgets and reasoning spend (KOBE-557)

**Where the spend shows:** Session info (`/session`, KOBE-584), from `GET /v1/threads/{id}/usage`.
"Thinking tokens" is the sum of the runs' `reasoning_tokens` (runs without a count add nothing; ≈
when any counted run was estimated; "—" when none has a count); it is part of Output tokens, as
its tooltip says. "Last run" is the run of the newest call (the run streaming in this tab is
skipped only until the usage read after it lands, so a run that ended without a model call does
not hide the previous one), graded with the control of **the model that run used** (its call's
gateway model in the team's list; not the conversation's current model). With `anthropic_budget` or
`gemini_budget`, whose budget is a real request field, it reads "<spent> of <budget> at <Level>".
With `reasoning_effort`, `anthropic_adaptive` or `anthropic_effort` it reads "<spent> at <Level>"
and its tooltip says "Level <X> is a typical scale of about <N> tokens, not a limit" (N from
`THINKING_EFFORT_BUDGETS`). At Off, or when the run's model is not in the list, it reads
"<spent> at <Level>"; "—" only without a count or a level. No bar: the composer's Reasoning
effort control no longer shows the spend (KOBE-574). Budgets per level live in `@kobe/protocol` thinking.ts; `thinkingBudget(control,
level)` picks the right table (null for `none`), and the team models API carries each model's
control in `thinking_in_team.control`.

| Control                                                      | Table                     | off | low   | medium | high   | Meaning                   |
| ------------------------------------------------------------ | ------------------------- | --- | ----- | ------ | ------ | ------------------------- |
| `anthropic_budget`                                           | `ANTHROPIC_BUDGET`        | 0   | 2,048 | 8,192  | 24,576 | the `budget_tokens` sent  |
| `gemini_budget`                                              | `GEMINI_BUDGET`           | 0   | 1,024 | 8,192  | 24,576 | the `thinkingBudget` sent |
| `reasoning_effort`, `anthropic_adaptive`, `anthropic_effort` | `THINKING_EFFORT_BUDGETS` | 0   | 2,000 | 8,000  | 24,000 | a display scale           |

The effort budgets are **a display scale, not a provider limit**: these providers take an effort,
not a token count, so a run may spend more. (The Anthropic budget sent may also be lowered to leave room for the answer, S3.)

**Reasoning tokens per call** (`run_usage.reasoning_tokens`, `reasoning_estimated`), written by the
model gateway (`services/model-gateway/src/usage/`):

- **Reported** when the provider reports a split: OpenAI Chat Completions
  `usage.completion_tokens_details.reasoning_tokens`, Responses
  `usage.output_tokens_details.reasoning_tokens`, Gemini `usageMetadata.thoughtsTokenCount`.
  Anthropic reports none. A reported non-zero count always wins. A reported 0 is often a proxy's
  placeholder (Bifrost and others send `reasoning_tokens: 0`), so it stands only when the stream
  carried no thinking text; otherwise the estimate below is recorded.
- **Estimated** when no non-zero split was reported but the stream carried thinking text:
  OpenAI-compatible `choices[].delta.reasoning_content`, else `reasoning` (one per delta; some
  servers send both) (Ollama, DeepSeek, vLLM), Responses
  `response.reasoning_text.delta` / `response.reasoning_summary_text.delta`, Anthropic
  `thinking_delta`, Gemini parts with `thought: true`. The estimate is **ceil(characters / 4)** of
  that text, the same unit as the gateway's output estimate (so non-ASCII thinking is not clamped
  to all of the output), and `reasoning_estimated` is true. A thinking event on an SSE line too long
  to decode counts with its whole line. Non-streamed (JSON) responses are not estimated.
- Never more than the call's output tokens (reasoning is part of output). Neither: null.

Reads: the per-run usage (`GET /v1/threads/{id}/usage`, `GET /v1/runs/{id}/usage`) returns
`reasoning_tokens` (the sum over calls with a count; null when none had one) and
`reasoning_estimated` (true when any counted call was estimated); the team and site usage totals
carry `reasoning_tokens` (calls without a split count 0). `run.completed`'s `usage` may carry an
optional `reasoning` count for a live client; the ledger stays the record.

## Known limits

- `anthropic_adaptive` and `anthropic_effort` keep only `format` of the caller's `output_config`.
- vLLM/SGLang's `chat_template_kwargs.enable_thinking` is not offered: it needs Bifrost's extra
  parameter passthrough, which would let any unknown field through.
- The Ollama mapping (`reasoning_effort: none`) is checked against the fake provider in CI; confirm
  it on a real deployment (the browser spec `thinking.spec.ts`).
