# Thinking controls (KOBE-260)

Site admins decide per model whether a reasoning model may think and how much; team admins can
only lower that; members pick a level per conversation; the **server and the model gateway**
decide what each call actually sends. Rules and types: `packages/protocol/src/thinking.ts`. The
gateway's mapping: `services/model-gateway/src/thinking.ts`.

## Levels

Provider-neutral and ordered: `off < low < medium < high`. Pi's wider set (`minimal`, `xhigh`,
`max`) is not offered: providers disagree on them and the four cover every control below.

## Settings

| Where                     | Field                              | Meaning                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model_catalog` (site)    | `thinking_control`                 | How the gateway writes the level (table below). `none`: Kobe sends nothing, the provider decides, no level is recorded. Only on a model marked `reasoning` (KOBE-259), and only a control that fits its provider. |
|                           | `thinking_allowed`                 | False: every run is `off`. Only for a control that can turn thinking off (`anthropic_effort` is always allowed).                                                                                                  |
|                           | `thinking_default`, `thinking_max` | Set exactly when allowed: the level runs use when the conversation chose none, and the highest level members may pick (`default <= max`, `max > off`).                                                            |
| `team_models` (team, RLS) | `thinking_max`                     | The team's ceiling: null = the site's; `off` turns thinking off for the team. The API refuses a value above the site's maximum; at read time it is clamped again, so a later site change never widens it.         |
| `threads` (team, RLS)     | `thinking_level`                   | The conversation's choice (any level; null = the model's default). Kept when the model changes.                                                                                                                   |
| `runs` (team, RLS)        | `thinking_level`                   | The run's effective level, fixed when it starts (also `run.started.thinking_level`, the per-run usage, the answer footer).                                                                                        |

Effective level at run start: `clamp(conversation ?? default, lowest(control), min(site max, team
max))`, `off` when thinking is not allowed (site or team). Same function on the server
(`runThinkingLevel`) and the gateway (`callThinkingLevel`); the database checks the shapes.

## Mapping (gateway)

| Control              | Route (refused on any other)             | `off`                                                                          | `low` / `medium` / `high`                                                                            |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `reasoning_effort`   | `/v1/chat/completions`                   | `reasoning_effort: "none"`                                                     | `reasoning_effort: "<level>"`                                                                        |
|                      | `/v1/responses`                          | `reasoning: {effort: "none"}`                                                  | `reasoning: {effort: "<level>"}`                                                                     |
| `anthropic_adaptive` | `/anthropic/v1/messages`                 | `thinking: {type: "disabled"}`                                                 | `thinking: {type: "adaptive", display: "summarized"}`, `output_config: {effort: "<level>"}`          |
| `anthropic_effort`   | `/anthropic/v1/messages`                 | (not offered: lowest is `low`)                                                 | as above                                                                                             |
| `anthropic_budget`   | `/anthropic/v1/messages`                 | `thinking: {type: "disabled"}`                                                 | `thinking: {type: "enabled", budget_tokens: 2048 / 8192 / 24576}`, below `max_tokens`; < 1024 is off |
| `gemini_budget`      | `/genai/v1beta/models/*:generateContent` | `generationConfig.thinkingConfig: {thinkingBudget: 0, includeThoughts: false}` | `thinkingBudget: 1024 / 8192 / 24576`, `includeThoughts: true`                                       |

Which control a model needs is the admin's choice (Site → Models), never guessed from its name:

- **Ollama** (also Ollama Cloud) and **OpenAI-compatible** servers: `reasoning_effort`. Bifrost
  passes it to the provider's OpenAI-compatible API; Ollama maps `none` to `think: false`.
- **OpenAI**: `reasoning_effort` (models that cannot turn reasoning off get Bifrost's lowest).
- **Anthropic**: `anthropic_adaptive` where `disabled` is accepted, `anthropic_effort` where
  thinking cannot be disabled (the newest models), `anthropic_budget` for older models.
- **Gemini**: `gemini_budget` (0 turns thinking off only on models that allow it).

## Enforcement

- **Every sandbox call** to a model with a control is rewritten by the gateway: the level is the
  run's recorded level (`runs.thinking_level`, read by run id and cached; attribution as KOBE-118)
  or, for a call naming no run, the model's default, clamped to the site and team settings in
  force now (the principal, cached ≤ its TTL). Pi's own reasoning fields are overridden: the
  gateway **appends** its members to the JSON object, which Bifrost's Go decoder takes over an
  earlier key in any letter case (`reasoning: null` first, so a caller's `reasoning.effort` cannot
  collide). Unknown provider fields (`think`, `chat_template_kwargs`) never pass: the gateway never
  sends `x-bf-passthrough-extra-params`. Gemini's field is nested, so that body is parsed and
  rebuilt with every other generation setting kept. Count-token calls pass unchanged.
- A controlled model called through another API is refused (400 `thinking_route_refused`).
- The run token is unchanged (no new claim): the level is in the server's record.
- **Server calls** (titles, follow-ups; KOBE-219/222) keep `reasoning_effort: "low"` and their caps,
  whatever the conversation chose.
- Reasoning tokens are output tokens: the KOBE-259 output limit and budget reservations apply as
  before.

## Known limits

- `anthropic_adaptive` and `anthropic_effort` replace the caller's whole `output_config` (Pi sends
  none for structured output today).
- vLLM/SGLang's `chat_template_kwargs.enable_thinking` is not offered: it needs Bifrost's extra
  parameter passthrough, which would let any unknown field through.
- The Ollama mapping (`reasoning_effort: none`) is checked against the fake provider in CI; confirm
  it on a real deployment (the browser spec `thinking.spec.ts`).
