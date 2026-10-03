# KOBE-40: Bifrost deployment and config sync

- **Status:** in review
- **Branch / worktree:** `kobe-40-bifrost` in `../Kobe-wt40`
- **Depends on:** KOBE-6, KOBE-24, KOBE-22, KOBE-38, KOBE-15, KOBE-20 (merged)

## Acceptance criteria (Hadron)

1. **ac-1** Config changes in the admin UI propagate to Bifrost within 10 s.
2. **ac-2** A revoked session token cannot call Bifrost.
3. **ac-3** Providers verified: OpenAI-compatible, Anthropic native, Gemini, Ollama.

Plus the coordinator's brief: pinned image with a license check; the server as the source of truth
(provider keys sealed and never logged, install catalog, team enablement) synced to Bifrost with
LISTEN/NOTIFY invalidation; sandboxes reach Bifrost only with their model-gateway token mapped to
(team, user, sandbox, run); seams for KOBE-42/43; chart NetworkPolicies (ingress on Bifrost's side,
Bifrost's own egress); a minimal audited install admin API; fake upstream in unit and e2e tests.

## Design

```
sandbox ──(kobe.model-gateway token)──▶ model-gateway shim ──(x-bf-vk: member's VK)──▶ Bifrost ──(provider key)──▶ provider
                                              │ liveness, VK (Postgres)                ▲ admin API (push)
                                              └──────── kobe_models hints ──────── server (gateway sync, leader)
```

- **Bifrost** (`docker.io/maximhq/bifrost:v2.2.5@sha256:6585…f115`, Apache-2.0): one replica,
  `Recreate`, SQLite store on a 1 Gi PVC, secret-free `config.json` from a ConfigMap
  (`enforce_auth_on_inference`, no direct keys, **no request logging**, admin API behind a
  password, encryption key from env). Kobe owns it: anything not desired is removed.
- **Push, not pull.** Bifrost has no clean pull source (config.json is read at startup only), so
  the server reconciles it through Bifrost's admin API (`services/server/src/models/`):
  `desired.ts` (Kobe rows → desired state, pure), `reconcile.ts` (observe, diff, apply; idempotent,
  keeps going past failures, new key before old key), `bifrost-admin.ts` (typed admin client; admin
  calls use `Authorization: Bearer base64(user:pass)` — Bifrost treats plain Basic as an inference
  credential), `sync.ts` (`ModelGatewaySync`). Hierarchy (D30): customer `kobe-install`, team
  `kobe-team-<team id>`, virtual key `kobe-vk-<team>-<user>` per active member, allowed exactly the
  team's enabled catalog models (`provider_configs[].allowed_models`, `key_ids: ["*"]`).
- **Sync loop.** Every server replica LISTENs on `kobe_models`; the one holding session advisory
  lock `0x6b6f62650040` (on its LISTEN connection; released if it dies) runs passes on every hint
  (debounced 250 ms), every 30 s, and on taking the lead; failures retry with backoff (2 s → 30 s).
  Each admin change bumps `model_gateway_state.desired_version` + NOTIFY `config` in its
  transaction; a successful pass records `synced_version` (`GET /v1/install/models` →
  `gateway.in_sync`, `last_error`).
- **Virtual keys.** Bifrost generates VK ids and values (its API cannot set them), so the sync
  stores each member's `{vk_id, value}` in `model_gateway_keys` (team table, RLS), the value sealed
  with the **virtual-key secret** (AES-256-GCM, HKDF per purpose, AAD `vk:<team>:<user>`), and
  NOTIFYs `keys:<team>` when a team's keys change.
- **Model-gateway shim** (`services/model-gateway`, new image `kobe-model-gateway`): the only
  model endpoint sandboxes can reach (`model-gateway.kobe.internal:80`). Per call: token from any
  SDK's key header (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `api-key`, `?key=`;
  two different ones → 401) verified with `@kobe/session-token` for `kobe.model-gateway` only →
  inference-path allowlist (else 404) → principal: active member, sandbox not
  destroyed/hibernated/replaced, member's VK (cached `cacheTtlSeconds`, 5 s; `keys:<team>` drops
  entries) → optional `x-kobe-run-id` must be leased to this sandbox → per-sandbox/total
  concurrency → `CallGate` → body ≤ 32 MiB → forwarded with an **allowlist** of headers plus
  `x-bf-vk` (credentials, cookies, every `x-bf-*` stripped; only `alt=sse` query kept) → response
  streamed unbuffered, `x-bf-*`/cookies dropped; a client that disconnects cancels the upstream.
  If Bifrost answers 401 `access_not_found` (it lost its store), the shim NOTIFYs `resync`, reloads
  the key and retries once, else 503 `model_gateway_resyncing` with `Retry-After`. Errors use each
  SDK's error shape (OpenAI / Anthropic / Gemini).
- **Data** (`packages/db`, migrations `0030_models`, `0031_models_rls`): `model_providers` †
  (kind openai | anthropic | gemini | ollama | openai_compatible; vendor kinds once, id = kind;
  `api_key_enc` sealed with the **provider-key secret**, AAD `provider:<id>`; `key_revision`),
  `model_catalog` † (alias → provider + model; provider delete RESTRICTed; alias delete cascades
  into `team_models`), `team_models` (team, RLS; one default per team, partial unique index),
  `model_gateway_keys` (team, RLS), `model_gateway_state` † (one row; app role SELECT/UPDATE only).
  Shared helpers in `@kobe/db` `models/` (`SecretBox`, channel/hint names, `bumpModelsConfig`,
  `loadGatewayPrincipal`, `isRunLeasedTo`, `gatewayProviderName`).
- **API** (server): `/v1/install/models` (GET: providers, catalog, gateway status, `configured`),
  `POST /providers`, `PATCH /providers/:id` (`api_key: null` clears it for keyless kinds),
  `DELETE /providers/:id` (409 while catalog entries use it), `POST /catalog`,
  `PATCH|DELETE /catalog/:alias` — `install.models.manage`; `/v1/team/models` (GET `team.read`,
  `PUT /:alias {enabled, is_default?}` `team.models.manage`). Keys are write-only (`key_set`).
- **Chart:** `model-keys-secret.yaml` (generated, kept: `bifrost-admin-password` → Bifrost +
  server, `bifrost-encryption-key` → Bifrost, `provider-keys` → server, `virtual-keys` → server +
  shim; or `bifrost.keysSecret`), `bifrost.yaml`, `model-gateway` Deployment/Service
  (`services.yaml`), `model-gateway-networkpolicy.yaml` (ingress: team namespaces on 8080; egress:
  DNS, Bifrost, Postgres), Bifrost policy in `networkpolicies.yaml` (ingress: shim and server pods
  on 8080 only; egress: DNS + public IPv4 on `allowedPorts` + `extraEgress`), `_models.tpl`.
  `_sandbox.tpl`: the `modelGateway` endpoint is now the shim, `sandbox.modelGatewayAccess`
  defaults to **true**; sandbox RBAC reads the shim's Service instead of Bifrost's.

## Decisions

- **Separate shim service** rather than a Bifrost plugin (Go, custom image) or a route on the
  server's sandbox port (would put a streaming proxy next to every session key). It holds only its
  own session key and the virtual-key secret (KOBE-22: "give each service only its own key").
- **Revocation = the principal is no longer live**: user deactivated or removed from the team, or
  the KOBE-25 `sandboxes` row is destroyed, hibernated or names another sandbox. No row yet / no
  sandbox id yet counts as live (tokens are only minted for live claims, KOBE-22; KOBE-25 writes
  the row on wake). Latency ≤ `cacheTtlSeconds` (5 s); the sync also deletes a former member's VK
  (≤ 30 s), so Bifrost itself refuses it then. There is no per-token (jti) revocation list.
- **One Bifrost replica with persistence on by default.** VK values are per store; several
  independent replicas would hold different values, and a shared Postgres store would leave each
  replica's in-memory governance cache stale. Persistence keeps VKs and (KOBE-42) budget counters
  across restarts; without it the sync rebuilds within seconds (new VKs; counters reset).
- **Provider naming:** vendor kinds are Bifrost's own providers (`openai`, `anthropic`, `gemini`,
  `ollama`, one each); OpenAI-compatible endpoints are custom providers `kobe-<id>` (keyless
  allowed). Models are addressed as `<gateway provider>/<model>` (`gateway_model` in the API).
  Bifrost key names (`kobe-<id>-<hmac fingerprint>`) carry an HMAC of the key material (provider
  -key secret), so a changed key or Ollama URL is pushed although Bifrost redacts values on read.
- **Run attribution is optional now** (`x-kobe-run-id`, verified against `sandbox_run_leases`):
  tokens are per sandbox, a sandbox runs several threads, and Pi's per-run headers are KOBE-41's
  wiring. Attribution to (team, user, sandbox) is always there (token + VK).
- **No request logging in Bifrost** (`enable_logging: false`): prompts never land in Bifrost's
  store; usage comes from Pi (`run_usage`, KOBE-43). Bifrost warns "batch accounting sweeper not
  wired: logging plugin not found" at start (harmless for v1; see KOBE-42 below).
- **Audit actions** in a new `models` category (category = first action segment):
  `models.provider.added|changed|removed`, `models.catalog.changed`, `models.team.changed` — the
  audit-log doc's suggested `team.models.changed` became `models.team.changed` so one category
  holds the area. Never the key (only `keySet` / `keyChanged`).
- **Admin UI not built** (KOBE-44); the API is complete for it.

## Open questions (for Chris or the coordinator)

1. Bifrost image digest pins the multi-arch index of `v2.2.5`; upgrades bump tag and digest
   together (`charts/kobe/values.yaml`, `_models.tpl` defaults). Dependabot does not track it.
2. The shim connects to Postgres as the app role (like the egress proxy): same "dedicated
   least-privilege role" question as KOBE-38 open question 3.
3. Changing `provider-keys` loses every stored provider key (re-enter them); rotating
   `bifrost-encryption-key` needs a fresh Bifrost store (delete the PVC; the sync rebuilds it).
   A rotation procedure (dual secrets) is not built.

## For downstream tickets

- **KOBE-41 (Pi wiring):** sandboxes call `KOBE_MODEL_GATEWAY_URL` (`http://model-gateway.kobe.internal:80`)
  with the `kobe.model-gateway` session token as the API key, re-traded before `expires_at` (15
  min). Base URLs: OpenAI-style providers `…:80/v1` (chat completions, responses), Anthropic
  native `…:80/anthropic` (the SDK appends `/v1/messages`; `anthropic-version`/`anthropic-beta`
  are forwarded, so prompt caching works), Gemini `…:80/genai` (`/v1beta/models/<gateway
provider>/<model>:generateContent|streamGenerateContent?alt=sse`). The model id is the catalog's
  `gateway_model` (`<gateway provider>/<model>`, e.g. `anthropic/claude-sonnet-4-5`,
  `kobe-vllm/qwen3`); aliases and the team default come from `GET /v1/team/models` (server-side;
  the sandbox has no user session). Send `x-kobe-run-id: <run id>` per run if Pi can set headers
  (verified against the run lease; enables run attribution). Errors: 401 `invalid_session_token`
  (re-trade), 401 `session_revoked`, 403 from Bifrost for a model the team has not enabled, 429
  `too_many_concurrent_calls`, 503 `model_access_pending`/`model_gateway_resyncing` with
  `Retry-After`.
- **KOBE-42 (budgets, rate limits, finish-current-step):** two seams. (1) `GovernanceLimitsSource`
  (`services/server/src/models/desired.ts`): budgets/rate limits for the customer (install), each
  team and each member's VK; the reconciler passes them on create/update (today a VK with limits
  is PUT on every pass — add a comparison of observed budgets in `reconcile.ts` `vkDiffers`, and
  team/customer updates). (2) `CallGate` (`services/model-gateway/src/seams.ts`): refuse a call
  before it reaches Bifrost (e.g. a `budget_stopped` run, rate limits with a clear error); calls in
  flight are never cut, so the current step finishes. Bifrost's refusals (budget/rate-limit
  errors) are passed through with their status and recorded as `errorType` in the `UsageSink`.
  Verify Bifrost's budget accounting with `enable_logging: false` (see Decisions). Audit:
  `models.budget.changed`, `models.budget.reached`.
- **KOBE-43 (run_usage):** the `UsageSink` seam gets one record per call: team, user, sandbox,
  run (if sent), route, model, status, bytes, duration, Bifrost error type, aborted; default is a
  JSON log line. The authoritative per-message usage is Pi's over the wire (D30).
- **KOBE-44 (admin UI):** API above; providers show `key_set`/`key_revision` only (keys
  write-only); `gateway.in_sync`/`last_error` for a status badge; team page: `GET/PUT
/v1/team/models`. Nav entries in the KOBE-20 registry (`apps/web/lib/admin/nav/*`).
- **KOBE-25/28:** the shim treats a `sandboxes` row with state `hibernated`/`destroyed` or another
  `sandbox_id` as revoked; offboarding (KOBE-28) should keep that row (or delete membership).

## Evidence (acceptance criteria → test or command output)

| AC / item                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 within 10 s           | server `models.db.test.ts` "propagates an admin change through LISTEN/NOTIFY within 10 s (leader only)" (also failover to the follower); e2e "the change reached Bifrost within 10 s" (team API disables a model → refused by Bifrost) and "Bifrost reflects the configuration (gateway in sync)"                                                                                                                |
| ac-2 revoked token         | model-gateway `model-gateway.db.test.ts` (Postgres principal store: hibernated, destroyed, member removed → 401 with the same unexpired token); `gateway.test.ts` "refuses a revoked principal…"; packages/db `models.db.test.ts` gateway principal suite; e2e "a revoked session token (member removed) is refused (401)"; server `models.db.test.ts` "removes a former member's and a deactivated user's keys" |
| ac-3 providers             | `services/server/src/models/bifrost.int.test.ts` against the real Bifrost v2.2.5 binary (`KOBE_TEST_BIFROST_BIN`, run locally: 1 passed): OpenAI, Anthropic native, Gemini, Ollama, OpenAI-compatible each answered through a member's VK; refusals without key / disabled model / disabled provider / removed member; e2e: the five kinds through the shim from a sandbox-like gVisor pod to the fake upstream  |
| token-only access          | `gateway.test.ts` authentication suite (none, forged, other audience, expired, Basic, conflicting credentials → 401); e2e no token / forged / egress-audience token → 401                                                                                                                                                                                                                                        |
| inference paths only       | `routes.test.ts`, `gateway.test.ts` "serves inference paths only…"; e2e `/api/providers` through the shim → 404                                                                                                                                                                                                                                                                                                  |
| secrets never in sandboxes | provider keys sealed (`secret-box.test.ts`, server db test reads the column), never returned or audited (server db test, e2e), reach only the upstream (`bifrost.int.test.ts`, e2e `/_seen`: provider keys yes, `sk-bf-`/JWTs no); shim strips credentials and `x-bf-*` (`gateway.test.ts`)                                                                                                                      |
| NetworkPolicy              | chart `tests/models.test.ts` (Bifrost ingress = shim + server only; Bifrost egress; shim ingress = team namespaces); e2e "sandboxes reach the model-gateway shim", "cannot reach Bifrost directly", "Bifrost refuses other pods of the release namespace", "Bifrost is not reachable from other namespaces"                                                                                                      |
| image pin + license        | chart test "runs the pinned Apache-2.0 image by digest"; `docs/licensing.md`; upstream LICENSE Apache-2.0                                                                                                                                                                                                                                                                                                        |
| audit                      | packages/db `events.test.ts` (taxonomy, documented); server `models.db.test.ts` (provider/catalog/team events, no key)                                                                                                                                                                                                                                                                                           |
| local checks               | `pnpm build typecheck format:check license:check` ok; `pnpm lint` ok except `@kobe/chart` (Helm 4, pre-existing); `pnpm test --concurrency=2` ok; `test:db` db 429, server 486, model-gateway 3 passed; `db:check` no changes; `scripts/check-public-hygiene.sh` ok                                                                                                                                              |
