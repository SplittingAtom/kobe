# Bifrost request decoding and rewriting (KOBE-414)

What Bifrost does to the bodies Kobe's model gateway (`services/model-gateway`) forwards: how it
decodes them, what it changes on the way upstream, and whether the upgrade from the pinned
v2.2.5 (`sha256:65854fd1…f115`) to v2.5.1 (`sha256:5ec9873a…d3c8`, tag `transports/v2.5.1`)
changes any of it. Measured on 2026-11-10 with both images and the harness in
`tools/bifrost-capture/`.

**Result.** Bifrost decodes request bodies with sonic in its `encoding/json`-compatible default
mode: keys are matched case-insensitively, a repeated scalar is last-wins, and a repeated object is
**merged into** the earlier one. The gateway never sends a repeated reasoning field (it parses and
rebuilds the body), and Bifrost forwards every reasoning field the gateway writes unchanged on both
versions, with three exceptions that are Bifrost's own and harmless (below). The only difference
between v2.2.5 and v2.5.1 on these bodies is Ollama's `xhigh`. **Go for v2.5.1**, after a Bifrost
PVC backup and the real-Bifrost integration test (see "Upgrade").

## 1. Decoder (ac-1)

Every inference route decodes the body with `sonic.Unmarshal`, which uses `sonic.ConfigDefault`
(`Config{}`: `CaseSensitive` false). Paths at `transports/v2.2.5` (v2.5.1 in brackets; same code):

| Route Kobe uses          | Decode                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/chat/completions`   | `transports/bifrost-http/handlers/inference.go:78` [`:72`] `prepareRequest` → `sonic.Unmarshal(ctx.PostBody(), req)`; `ChatParameters.UnmarshalJSON` `core/schemas/chatcompletions.go:253` [`:274`] decodes through `schemas.Unmarshal` = `sonic.Unmarshal` (`core/schemas/json_native.go:25`) |
| `/v1/responses`          | same `prepareRequest` (`inference.go:1114`, `prepareResponsesRequest`)                                                                                                                                                                                                                         |
| `/anthropic/v1/messages` | `transports/bifrost-http/integrations/router.go:384` [`:408`] `sonic.Unmarshal(rawBody, req)` into `AnthropicMessageRequest`, whose `UnmarshalJSON` (`core/providers/anthropic/types.go:988`, `:999` [`:1034`, `:1045`]) is again `sonic.Unmarshal` on an alias                                |
| unknown top-level keys   | `extractExtraParams` (`inference.go:686` [`:787`]) decodes into `map[string]json.RawMessage`: exact-case keys, last duplicate wins; keys absent from the route's known-field list become provider `extra_params`                                                                               |

Sonic is `github.com/bytedance/sonic v1.15.3-0.20260730064818-2a36d6da63e2` in both tags
(`api.go:98-104`: `CaseSensitive` "indicates that the decoder should not ignore the case";
`ConfigDefault = Config{}.Froze()`; `Unmarshal` → `ConfigDefault.Unmarshal`, `api.go:194`).

Duplicate-key behaviour, measured with that sonic version against `encoding/json` (identical in
every case) and confirmed through both images:

| Body                                                                                                        | Decoded                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `"max_tokens":100,"MAX_TOKENS":200`                                                                         | `max_tokens` 200: **case-insensitive, last-wins** for scalars                                        |
| `"thinking":{"type":"enabled","budget_tokens":16000},"thinking":{"type":"adaptive","display":"summarized"}` | `{"type":"adaptive","budget_tokens":16000,"display":"summarized"}`: **merge-into** for struct fields |
| `"reasoning":{"effort":"xhigh","summary":"auto"},"reasoning":{"effort":"low"}` (Responses)                  | forwarded `{"effort":"low","summary":"auto"}`: merge-into                                            |
| `"output_config":{"effort":"high","format":{…}},"output_config":{"effort":"low"}`                           | `{"effort":"low","format":{…}}`: merge-into                                                          |
| `"thinking":{…},"thinking":null`                                                                            | unset: a later `null` clears                                                                         |
| a field typed `interface{}` / `map[string]RawMessage`                                                       | last-wins (replace); a `map[string]any` field merges keys                                            |

So an appended reasoning object never replaces the caller's: the caller's `budget_tokens` or
`summary` survives beside it. Through the v2.2.5 image the merged Anthropic case above went upstream
as `{"type":"enabled","budget_tokens":16000}` (Bifrost turned `adaptive` into a budget because a
budget was present, and dropped `output_config.effort`). Chat Completions refuses a body that sets
both `reasoning_effort` and `reasoning.effort` (400 "Invalid request payload"; v2.5.1 only when
they differ). v2.5.1 decodes the same way.

## 2. What Bifrost forwards (ac-2)

Bodies were produced by the gateway's own functions (`make-cases.mjs` calls `applyThinking` and
`withStreamUsage` from the built package) from Pi-style input that carried Pi's own reasoning
fields (`thinking` budget 16,000, `reasoning_effort`/`reasoning.effort` `xhigh`,
`reasoning.summary` `auto`). Kobe's levels are `off`, `low`, `medium`, `high` (`@kobe/protocol`
`THINKING_LEVELS`; there is no `minimal`, `xhigh` or `max` level). Every case streamed except where
noted. On every route Bifrost strips the `<provider>/` prefix from `model`, drops `stream: false`
(omitempty) and re-serialises the body (key order changes). Below, "same" means the field went
upstream exactly as the gateway wrote it. **v2.2.5 and v2.5.1 forwarded byte-for-byte equivalent
bodies (after key sorting) in every gateway case.**

### Anthropic Messages (`/anthropic/v1/messages` → `/v1/messages`)

| Control / model                       | Level    | `max_tokens` | Gateway writes                                                       | Forwarded (both versions)                                        |
| ------------------------------------- | -------- | ------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `anthropic_budget`, claude-sonnet-4-5 | off      | 32,000       | `thinking {type: disabled}`                                          | same                                                             |
|                                       | low      | 32,000       | `thinking {enabled, budget_tokens 2048}`                             | same, + header `anthropic-beta: interleaved-thinking-2025-05-14` |
|                                       | medium   | 32,000       | budget 8192                                                          | same, + beta header                                              |
|                                       | high     | 32,000       | budget 24000 (24,576 capped to leave a quarter)                      | same, + beta header                                              |
|                                       | off      | 4,096        | disabled                                                             | same                                                             |
|                                       | low      | 4,096        | budget 2048                                                          | same, + beta header                                              |
|                                       | medium   | 4,096        | budget 3072 (capped)                                                 | same, + beta header                                              |
|                                       | high     | 4,096        | budget 3072 (capped)                                                 | same, + beta header                                              |
| `anthropic_adaptive`, claude-opus-4-6 | off      | 32,000       | `thinking {disabled}`                                                | same                                                             |
|                                       | low…high | 32,000       | `thinking {adaptive, display: summarized}`, `output_config {effort}` | **`thinking.display` dropped**; `output_config.effort` same      |
| `anthropic_effort`, claude-opus-4-7   | low…high | 32,000       | as above                                                             | same (display kept)                                              |
| adaptive + `output_config.format`     | high     | 32,000       | `output_config {format, effort}`                                     | same (schema keys re-ordered)                                    |

`max_tokens`, `system`/message `cache_control` blocks and `budget_tokens` always arrive unchanged.
Bifrost drops `thinking.display` only for models before Opus 4.7 (its own model table:
`AnthropicThinking.Display` is "Opus 4.7+"); those models return summarized thinking by default, so
nothing is lost. A `claude-cli`/`claude-code` user agent (which a sandbox could send; the gateway
forwards `user-agent`) switches Bifrost to raw passthrough for Claude models: the gateway's bytes
went upstream verbatim, key order included, which is if anything closer to what the gateway wrote.

### OpenAI Chat Completions (`/v1/chat/completions`)

| Provider                                                                           | Level    | Gateway writes                                                                                                    | Forwarded (both versions)                                   |
| ---------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| openai (gpt-5.1)                                                                   | off…high | `reasoning_effort` none/low/medium/high, Pi's `max_completion_tokens` 16,384, `stream_options.include_usage` true | same                                                        |
| ollama (gpt-oss:120b, Bifrost's Ollama provider calls `<url>/v1/chat/completions`) | off…high | same                                                                                                              | **`max_completion_tokens` renamed `max_tokens`**; rest same |
| custom OpenAI-compatible (`base_provider_type: openai`)                            | off…high | same                                                                                                              | same                                                        |

### OpenAI Responses (`/v1/responses`)

| Provider | Level    | Gateway writes                                                                                                  | Forwarded (both versions)                                                                                                                                                 |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai   | off…high | `reasoning {effort}`, `max_output_tokens` 16,384, Pi's `include: [reasoning.encrypted_content]`, `store: false` | same, **+ `reasoning.summary: null`**                                                                                                                                     |
| ollama   | off…high | same                                                                                                            | **converted to Chat Completions**: `reasoning_effort`, `max_tokens`, `messages` (instructions → system), `stream_options.include_usage` added; `include`, `store` dropped |

### Models without a thinking control (body passes the gateway unchanged)

| Case                                                                              | v2.2.5 forwards                                | v2.5.1 forwards |
| --------------------------------------------------------------------------------- | ---------------------------------------------- | --------------- |
| Ollama chat, Pi `reasoning_effort: xhigh`                                         | `reasoning_effort: "high"`                     | **`"xhigh"`**   |
| Ollama Responses, Pi `reasoning.effort: xhigh`                                    | `reasoning_effort: "high"`                     | **`"xhigh"`**   |
| OpenAI gpt-5.1 chat, `xhigh`                                                      | `"high"` (model does not accept xhigh)         | `"high"`        |
| Anthropic via Chat Completions, `cache_control` on system and user content blocks | system moved to `system`, `cache_control` kept | same            |

The gateway never writes `xhigh` (no such Kobe level), so the Ollama difference reaches only models
without a control. The v2.5.0 `cache_control` fix concerns chat-message shapes Kobe does not send
(Kobe calls Anthropic models through the Messages route); the plain shape above was already kept by
v2.2.5. An empty `messages` array was refused with a 400 on both versions for chat, Ollama chat and
Messages (the v2.5.1 crash fix concerns paths these shapes did not reach).

**Gateway-side observation (not Bifrost):** for a `reasoning_effort` model on `/v1/responses` the
gateway replaces Pi's whole `reasoning` object, so Pi's `summary: "auto"` is dropped and OpenAI
returns no reasoning summary (Bifrost then writes `summary: null`). If summaries are wanted, the
rewrite can keep `reasoning.summary` (it is not a level); a small follow-up, not part of this ticket.

## 3. Gateway paths that modify a request body (ac-3)

| Path                                               | What                                                                                                                                                                                                              | Kind                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `thinking.ts` `applyThinking` (gateway.ts:610)     | `JSON.parse`, remove every reasoning field in any case (`withoutReasoning`), collapse `max_tokens` case variants to the last value, add the gateway's fields once, `JSON.stringify`                               | **parse and rewrite**                                                                                                   |
| `body-model.ts` `withStreamUsage` (gateway.ts:628) | streaming `/v1/chat/completions`: splices `,"stream_options":{"include_usage":true}` before the closing `}`                                                                                                       | **append**                                                                                                              |
| `server-call.ts` `checkServerCallBody`             | validates the server's body (zod shape, model, output cap, `reasoning_effort` only for reasoning models); forwards it unchanged                                                                                   | none (read only); the server builds the body with `JSON.stringify` (`services/server/src/models/gateway-client.ts:289`) |
| Output limits (KOBE-259)                           | the gateway writes no limit: Pi sends the catalog limit as `max_tokens`/`max_completion_tokens`/`max_output_tokens`; `topLevelModel` reads it to size the reservation; `applyThinking` caps the budget against it | none (read only)                                                                                                        |
| `body-model.ts` `topLevelModel`                    | structural scan for `model`, `stream`, `background`, output caps, `n`, `fallbacks`                                                                                                                                | none (read only)                                                                                                        |
| Usage metering (`usage/`)                          | reads responses only                                                                                                                                                                                              | none                                                                                                                    |
| Forward / retry (gateway.ts:674)                   | sends `forwardBody` as is, same bytes on the one retry                                                                                                                                                            | none                                                                                                                    |

**The one append path, `withStreamUsage`, is safe under Bifrost's decoder and needs no urgent fix.**
Under merge-into a caller's earlier `stream_options` (any letter case) decodes first and the
appended object then sets `include_usage` to true (scalar, last-wins), which is the intent; the
caller's other `stream_options` members survive the merge, which is harmless. Measured: a body with
`"stream_options":{"include_usage":false,"include_obfuscation":false}` followed by the appended
member went upstream as `{"include_usage":true}` on both versions. It would only matter if the body
reached a first-wins reader verbatim (no such path today: Bifrost re-serialises chat bodies, and raw
passthrough exists only for Anthropic Messages). The tidy fix, if the coordinator wants one: set
`stream_options.include_usage` on the parsed object when `applyThinking` has already parsed the
body, and keep the splice only for unparsed bodies (avoids a second `JSON.parse` of up to 8 MiB).

## 4. Upgrade to v2.5.1 (ac-4)

### Store migrations

Bifrost runs its migrations at start on the config store (`/app/data/config.db`, the Bifrost
PVC); Kobe keeps `logs_store` off, so log-store migrations create nothing it uses. Between the
tags the config store gains 76 migrations (227 → 303 entries) (`framework/configstore/migrations.go`), among them
`add_anthropic_workload_identity_column`, `add_cache_creation_above_12hr_pricing_columns`,
`add_relays_tables`, `add_mcp_per_user_discoveries`, `add_agent_gateway_tables`, and two that change
data: `move_config_json_vk_limits_to_model_configs` (moves virtual-key budgets and rate limits onto
model-config tiers) and `drop_agent_registration_options`. 17 of the new ones refuse rollback
("non-rollbackable"; additive columns that older binaries ignore, plus the drop). The log store
adds `logs_add_user_email_column`, `logs_add_client_ip_column`, relay-log and `round_trip_id`
columns. In practice the upgrade is one-way:

1. Back up the Bifrost PVC (`config.db`) before the upgrade, and keep the backup (never delete it
   without asking).
2. A rollback is restoring that backup with the v2.2.5 image, not a downgrade in place. The server
   re-pushes providers, keys and virtual keys on its next reconcile, so a restored store converges.
3. Because Kobe sets virtual-key `budgets`/`rate_limit` through the admin API
   (`services/server/src/models/bifrost-admin.ts`) and reads `rate_limit` back to compare, run the
   real-Bifrost integration test (`services/server/src/models/bifrost.int.test.ts`) against v2.5.1
   in the bump PR. The v2.5.1 create/update request still accepts both fields
   (`handlers/governance.go`), but the read-back shape after the limits move is not covered here.

### Log identity (caller email and client IP)

v2.5.0 adds `user_email` and `client_ip` columns to LLM, MCP and relay logs. Kobe's config
(`kobe.bifrostConfig` in `charts/kobe/templates/_models.tpl`) records neither:

- `logs_store.enabled: false` and `client.enable_logging: false`: no log rows are written at all,
  so neither column is ever filled.
- `client_ip` is opt-in on top of that (`logs_store.capture_client_ip`, default false,
  `framework/logstore/config.go:24`); Kobe does not set it. Even if it did, the caller Bifrost sees
  is the shim pod: the gateway forwards no `X-Forwarded-For`/`X-Real-IP` (header allowlist in
  `services/model-gateway/src/headers.ts`).
- `user_email` comes from a request-context value set by Bifrost's user-auth flows; Kobe's calls
  carry only a virtual key, which has no user email.

The settings that keep them off are the two above (`logs_store.enabled: false`,
`client.enable_logging: false`); keep them, and never add `capture_client_ip`. Bifrost's own
telemetry plugins (which could carry a user email attribute) are not configured by the chart.

### Recommendation

**Go for v2.5.1** (supersedes Dependabot #456's v2.4.0; close #456 with a pointer when the bump
lands). No gateway change is required: every field the gateway writes reaches the provider as
written on both versions, the decoder is unchanged, and the only body difference (Ollama `xhigh`
passed through) affects only models without a thinking control and is the documented fix. In the
bump PR:

- update `images/bifrost/Dockerfile`, `charts/kobe/values.yaml` and the `_models.tpl` default to
  `v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8`
  (`charts/kobe/tests/models.test.ts` checks they agree) and check the licence (docs/licensing.md);
- run `bifrost.int.test.ts` against v2.5.1 and re-run `tools/bifrost-capture` (expect only the
  Ollama `xhigh` rows to differ);
- deploy: back up the Bifrost PVC first; keep Bifrost's MCP gateway, MCP Apps, A2A, relays and
  semantic cache off (the chart configures none of them).

Optional follow-ups for the coordinator: keep `reasoning.summary` on Responses (section 2), and
rewrite `stream_options` on the parsed body where one exists (section 3).
