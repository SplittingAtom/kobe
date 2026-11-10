# KOBE-414: Research: how Bifrost v2.2.5 decodes and rewrites reasoning fields, go/no-go for v2.5.1

- **Status:** in review (research done; no PR opened by the ticket agent)
- **Branch / worktree:** `kobe-414-bifrost-research` in `../Kobe-wt414`
- **Depends on:** none (supersedes Dependabot #456's v2.4.0)

## Plan

Read Bifrost's decoder at `transports/v2.2.5` and `transports/v2.5.1`; run both images against a
capture server with bodies produced by the gateway's own rewrite functions; list the gateway's body
writers; write the design note with a go/no-go.

## Decisions

- Kobe's levels are off/low/medium/high (`THINKING_LEVELS`), so the matrix covers those four, not
  the minimal/xhigh/max names in the brief; `xhigh` is tested only on models without a control.
- The capture harness is committed (`tools/bifrost-capture/`, no infra details; Docker host from
  `DOCKER_HOST`). The Bifrost config in it runs without virtual keys (governance does not touch
  bodies).
- No gateway code changed: the only append path (`withStreamUsage`) gives the intended result under
  Bifrost's merge-into decoding.

## Open questions (for Chris or the coordinator)

- File optional follow-ups? (1) keep Pi's `reasoning.summary` on `/v1/responses` (the gateway drops
  it today, so OpenAI returns no reasoning summary); (2) set `stream_options` on the parsed body
  where `applyThinking` already parsed it instead of splicing.
- The v2.5.1 bump PR must run `bifrost.int.test.ts` against v2.5.1: the
  `move_config_json_vk_limits_to_model_configs` migration moves virtual-key limits, and the
  read-back shape Kobe compares was not checked here.

## Evidence (acceptance criteria → test or command output)

- **ac-1** sonic `ConfigDefault` (case-insensitive; last-wins scalars; merge-into objects): source
  lines in `docs/design/bifrost-request-rewrite.md` §1, a Go probe against the pinned sonic version
  (identical to `encoding/json`), and the duplicate-key cases through both images.
- **ac-2** 52 cases × 2 images via `tools/bifrost-capture/run.sh`; tables in §2. Bifrost changes:
  model prefix stripped, `thinking.display` dropped before Opus 4.7, Ollama
  `max_completion_tokens` → `max_tokens`, Responses `reasoning.summary: null` added, Ollama
  Responses converted to chat, `interleaved-thinking` beta header on budget thinking. Only
  difference v2.2.5 → v2.5.1: Ollama `xhigh` no longer rewritten to `high`.
- **ac-3** §3: `applyThinking` parse-and-rewrite; `withStreamUsage` append (safe, described);
  server-call, output limits, `topLevelModel`, usage: read only.
- **ac-4** §4: migrations (76 new config-store entries, 17 non-rollbackable; back up the PVC), log
  identity (off: `logs_store.enabled: false`, `client.enable_logging: false`, no
  `capture_client_ip`), **go for v2.5.1**.
- Docker host cleaned: containers, networks and the v2.5.1 image removed (the v2.2.5 image was there
  before and stays).
