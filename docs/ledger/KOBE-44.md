# KOBE-44: Model catalog and team model admin UI

- **Status:** in review (PR #58)
- **Branch / worktree:** `kobe-44-model-admin-ui` in `../Kobe-wt44`
- **Depends on:** KOBE-40 (model admin API, Bifrost sync), KOBE-41 (run model resolution),
  KOBE-20 (consoles, nav registry), KOBE-32 (web chat) — all merged

## Acceptance criteria (coordinator brief; spec D6, D8, D30)

1. **ac-1 Install console, Models section.** Providers: add, edit, remove; keys write-only (only
   "set / not set" shown); changing a keyed provider's endpoint needs the key again, explained in
   the UI. Gateway sync status (`in_sync`, last error). Catalog: add, edit, remove aliases mapped to
   a provider and model, with a model picker when the provider can list models through the server
   (a new endpoint if needed: install admin only, audited when it uses the key, never returning it).
2. **ac-2 Team console, Models section.** Enable/disable catalog models and pick the default
   (`team.models.manage`).
3. **ac-3 Chat model picker.** Choose the thread's model from the team's enabled models (default:
   the team default), stored on the thread by the server and passed as the run's requested alias
   (KOBE-41's resolution). A model the team disabled later fails the run with the existing error
   and shows as unavailable in the picker. Consistent with assistant-ui's composer.
4. **ac-4 Tests.** Component tests, server route tests, DB tests for the new storage; e2e API check.
5. Handles the real test install: Ollama Cloud (`ollama`, `https://ollama.com`, API key;
   `kimi-k2.7-code` default, `glm-5.3`) and OpenAI-compatible endpoints.

## Design

```
install console ──/v1/install/models──▶ server ──admin API (/api/models, refresh-models)──▶ Bifrost ──key──▶ provider
team console ─────/v1/team/models─────▶ server (team_models, RLS)
chat composer ── POST/PATCH /v1/threads {model} ──▶ threads.model_alias ──▶ run start: requested alias
                                                                             (thread > agent pin > team default)
```

- **Storage:** `threads.model_alias text NULL` (migration `0041_thread_model`, check = the catalog
  alias pattern). No foreign key on purpose: an alias the team disables or the install removes
  stays chosen and the run fails `agent_model_not_enabled` (user decision: never fall back
  silently). Threads are already a team table (RLS, team_id); every query keeps its explicit
  `team_id` predicate.
- **Thread API:** `POST /v1/threads {model?}` and `PATCH /v1/threads/{id} {model: alias|null}`
  (owner only, like every change); the alias must be enabled for the team when it is chosen
  (409 `model_not_enabled`), null = the team default. Summaries (`GET`, list, search, break-glass
  reads) carry `model`. Queued runs use the model current when they start.
- **Run resolution (`runs/lifecycle.ts requestedModel`):** the thread's choice, else the agent's
  pin (KOBE-47), else none → KOBE-41's `resolveRunModel` (team default). A thread choice the team no
  longer enables fails the run `agent_model_not_enabled` with a thread-worded message
  (`threadModelNotEnabled`); nothing is woken. A recovery re-send keeps `run.started.model`.
- **Model listing (`models/discovery.ts`):** `GET /v1/install/models/providers/{id}/models` reads
  Bifrost's model cache (`GET /api/models?provider=…`) and the key's discovery status
  (`GET /api/providers/{p}/keys` → `status`, `description`); `POST …/models/refresh` has Bifrost
  run the provider's list-models call now (`POST /api/providers/{p}/refresh-models`). Install
  `install.models.manage` only (the route's middleware). Model ids are normalized (own gateway
  prefix dropped, `PROVIDER_MODEL_PATTERN` only, ≤ 1000, sorted). A provider's failure is reported
  as one of a few fixed reasons (`failureReason`: refused key, rate limit, no model list at that
  URL, unreachable, other); its own text is never passed on (providers echo key fragments).
  Errors: 404 unknown provider, 409 `provider_not_synced` (Bifrost doesn't have it yet), 503
  `gateway_unavailable`, 429 refresh limit (6/min per provider, Postgres counter shared by
  replicas). Audit `models.provider.models_refreshed` {providerId, kind, outcome ok|failed|
  unavailable, models count} — never the provider's answer or the key.
- **Web:** `lib/admin/api/{install,team}/models.ts`; install page `components/admin/install/
models-page.tsx` (gateway status), `model-providers.tsx`, `model-catalog.tsx` (with
  `ModelIdField`: free-text input + `<datalist>` of the listed models + "Ask the provider for its
  models"), `model-kinds.ts` (per-kind rules and hints: Ollama Cloud vs local Ollama,
  OpenAI-compatible root URL without `/v1`, private-network note); team page
  `components/admin/team/models-page.tsx`; both nav entries flipped to READY. Chat:
  `components/chat/model-picker.tsx` in the composer's action bar; `ChatApi.createThread(title,
model)`, `setThreadModel`, `listModels`; `ChatSession` draft model + 30 s model-list cache;
  `ThreadController.setModel`.

## Decisions

1. **Model listing goes through Bifrost, not from the server to the provider.** Bifrost already
   holds the key and is the only component whose NetworkPolicy reaches providers (incl.
   `extraEgress` for private endpoints); the server never sends a provider key anywhere itself, so
   there is no new SSRF or key-exfiltration path from the server. A plain list read uses Bifrost's
   cache (no provider call, not audited); only a refresh makes a provider call with the key
   (audited, rate-limited).
2. **Thread choice beats the agent's pin** (thread > agent > team default): the person picked the
   model for this conversation. Both fail the same way when the team doesn't enable the alias.
   Flagged for KOBE-47.
3. **Same error code for a disabled thread choice** (`agent_model_not_enabled`, as the brief asks
   for "the existing clear error"), with its own message naming the conversation's model. The
   picker re-reads the team's models when a run fails with that code.
4. **A thread's model change is audited** (`thread.model_changed` {threadId, from, to}, like
   `thread.agent_switched`); choosing one at creation is part of creating the thread (not audited,
   like creation itself).
5. **The picker is a native `<select>`** in the composer action bar (assistant-ui ships no model
   selector component in 0.15; its shadcn registry one is a Select in the same place). Native gives
   keyboard and screen-reader support; arrowing through options does change the model (cheap and
   reversible), unlike the team console where "Make default" is a button (KOBE-20's rule: no
   privileged change from a select/radio).
6. **Client checks are courtesy only:** the endpoint-change rule disables Save until the key is
   re-entered and says why; the http-with-key warning doesn't block (operators may allow unsafe
   endpoints for test installs); the server's refusals are shown as they come.
7. `gateway_unavailable` and `models_not_configured` join the 5xx codes whose server message is
   shown (`lib/api/client.ts`).

## For downstream tickets

- **KOBE-47 (agent resolution):** put the agent's alias in `AgentResolution.config.model.alias`
  as before; a thread's own `model_alias` wins over it (`requestedModel` in `runs/lifecycle.ts`).
  If agents should be able to forbid a thread override, that's the place.
- **KOBE-42 (budgets):** nothing new; per-thread model choice changes which model a run is charged
  to, not who pays.
- **KOBE-57 (projects):** readers of a shared thread get 403 `read_only` on `PATCH {model}` like
  any change; the picker shows the server's error.
- **Catalog capability flags** (KOBE-41's follow-up: reasoning, context window) are not built.

## Open questions (for Chris or the coordinator)

1. Thread choice vs agent pin precedence (decision 2): chosen as thread > agent.
2. Should a refresh also be offered automatically right after a provider is added? Today the
   catalog form reads Bifrost's cache, which Bifrost fills on its own discovery; "Ask the provider"
   is one click.

## Self-review (security-reviewer agent: 0 CRITICAL/HIGH, 1 MEDIUM, 6 LOW) — resolution

- MEDIUM provider error text could carry key fragments past a length-based scrubber → replaced by
  fixed reasons (`failureReason`, test "turns provider error text into fixed reasons").
- LOW thread model change not audited → `thread.model_changed` (test in `thread-model.db.test.ts`).
- LOW kept: no limit on the cached list read (above); the shared `hitRateLimit` advances its window
  on refused hits (pre-existing helper); `truncated` means "may have been cut"; rate-limited
  refreshes are not audited (no provider call happens).

## Risks

- Bifrost's `GET /api/models` includes datasheet models for vendor providers (pricing catalog),
  so the picker can suggest a model the key can't use; the field stays free text and the gateway
  refuses an unusable model at run time.
- `GET …/providers/{id}/models` is not rate-limited (install admins only; reads Bifrost's cache,
  two admin calls). The refresh is.

## Evidence (acceptance criteria → test or command output)

| AC      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1    | `apps/web/components/admin/models-pages.test.tsx` (install: only `key_set`/revision shown, no team header; failing sync with last error; add Ollama Cloud with endpoint + password-typed key (exact POST body); OpenAI-compatible id + private network, vendor kinds offered once; endpoint change on a keyed provider disables Save with the explanation until the key is re-entered (exact PATCH body); server refusal `key_required_for_new_endpoint` shown; catalog add with the picker (cached list → "Ask the provider" → datalist → POST body); provider refusal explained; edit/remove catalog; gateway not configured). Server `models-discovery.db.test.ts` (install admins only, 409 before sync, read never calls out, refresh lists Ollama Cloud models with prefix dropped/invalid skipped, key never in responses or audit, refused key scrubbed, audit outcomes, rate limit, 503, 404); `models/bifrost-admin.test.ts` (admin client calls) |
| ac-2    | `models-pages.test.tsx` team suite (enable/disable/make default, exact PUT bodies, `X-Kobe-Team` on every call, no "Make default" for a disabled model, warning before disabling the default, "No default" banner)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ac-3    | Server `thread-model.db.test.ts` (stored and shown in GET/list/search; only enabled aliases, 409 otherwise, 400 malformed; owner only, other team 404; run.start/run.started carry the thread's model ahead of the agent pin and default; disabled later → run fails `agent_model_not_enabled` with the thread message, nothing woken, picking another works). Web `components/chat/model-picker.test.tsx` (team default + enabled only; new conversation created with the choice; PATCH on an open thread and back to default; disabled choice shown "(unavailable)" with the way out; re-read after a run fails for the model; server refusal shown; hidden when the list can't be read)                                                                                                                                                                                                                                                                  |
| ac-4    | `lib/admin/api/models.test.ts`; e2e `run.sh` KOBE-44 checks (thread created with `qwen` stores it, `run.started.model=qwen`, completed through that provider; a disabled alias can't be chosen, 409)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| screens | Screenshots of each screen (production build against a mock API) attached to the report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
