# KOBE-219: C1 auto-titles: server post-run title call, title usage kind, rename lock, hover card

- **Status:** done on branch, awaiting the coordinator's Opus review (no PR: group G3)
- **Branch / worktree:** `group-3-phase-c-org` in `../Kobe-g3` (group G3, Phase C)
- **Depends on:** KOBE-234 (contract, gateway side, 0099/0100, `runEpilogue`), KOBE-215/292
  (`title_locked`, rename locks / clearing unlocks)
- **Migrations:** none

## What it does

1. **Announce** (`sandbox-wire/run-state.ts` `epilogueOf`, `threads/title.ts` `wantsTitleInTx`): in
   the transaction that completes a run, `run.completed.epilogue: ["title"]` when this server can
   make server calls, the run is a message run, the thread has no title, is not `title_locked`,
   not a test thread, not in Trash, and the run is among its first three completed message runs.
   The ingest passes the wire's `serverCalls` purposes (`WireContext.serverCalls`).
2. **Call** (`server-calls/service.ts`, after commit, from the wire's run-ended hook in `deps.ts`,
   on `BackgroundTasks`): reads what `run.completed` announced, then `runEpilogue` with the title
   step: `loadTitleSource` (lease member, `pinnedModel` → thread alias → team default through
   `resolveRunModel`; first user message + start of the answer, 2,000 chars each) and
   `models/gateway-client.ts`: a `title` server-call token (TTL 30 s, `max_output_tokens` =
   `SERVER_CALL_LIMITS.title`), `POST <gateway>/v1/chat/completions`, `stream: false`, the
   epilogue's 15 s signal, no retries, `redirect: "manual"`, span `server_call.title` with
   `traceparent`. Headers: `content-type`, `x-kobe-server-call`, trace context. Nothing else.
3. **Save** (`saveGeneratedTitle`): `normaliseTitle` (first line, no quotes, Markdown, `Title:`
   label or trailing punctuation, ≤ 80 chars at a word boundary, `generatedTitleSchema`), then
   `UPDATE threads … WHERE team_id AND id AND title IS NULL AND NOT title_locked` (lock_timeout
   5 s); `thread.updated` only when a row changed. Failures: `{purpose, run_id, code}` at warn
   (`ServerCallError.code` is the gateway's code or `http_<status>`, `timeout`, `bad_reply`).
4. **Stream** (`event-stream/stream.ts`, `routes/run-events.ts`, `read.ts` `epilogue()`): after
   an announcing `run.completed` the SSE response stays open until each announced event was sent
   or `SERVER_CALL_EPILOGUE_MAX_MS` passed (`epilogueOpen`); a reconnect past the terminal gets
   `decideStreamOpen({..., epilogue_open})` and waits the same way; otherwise 204.
5. **Web**: `lib/chat/stream.ts` keeps listening after such a `run.completed` (closes when all
   arrived, at the window, or on an error: never reconnects); the controller applies
   `thread.updated` to the header (`summary.title`) and tells the session, and `chat-app.tsx`
   reloads the rail list. New threads are **created untitled** (else the server never titles
   them); the rail shows the first line from the session (`provisionalTitle`) until then.
6. **Hover card** (`components/shell/rail-thread-card.tsx`, Radix HoverCard, 600 ms, pointer or
   focus): first user message (280 chars, `…` when cut), agent (name / "No agent"), last
   activity (relative, full date on hover), message count; read on open from the new
   `GET /v1/threads/{id}/card` (`threads/card.ts`, `threads/messages.ts`; OpenAPI updated).
7. **Usage**: `runsUsageIn` and `latestCallIn` read `kind = 'run'` only; team and site reports gain
   `by_kind`; the dashboard shows "By kind" (Runs / Titles / Follow-ups).
8. **Chart**: model-gateway NetworkPolicy ingress also admits the server's pods on 8080;
   `KOBE_MODEL_GATEWAY_URL` (`http://<release>-model-gateway`) in the server's env only (not the
   scheduler). The server has no restricted egress, so no egress rule. Config: plain origin only.

## Decisions

- **Created untitled.** The web used to send the first line as the title on create; with it no
  thread would ever be auto-titled (ac-4: "the thread has no title"). The first line is now a
  session-only placeholder in the rail; after a reload an untitled thread whose title call failed
  shows "Untitled conversation".
- **Card by its own route**, read when it opens, not in the list (message count and first
  message per row would cost every list read).
- **Message count** = user messages + assistant messages whose `stopReason` is not `toolUse`, on
  every branch (what a member would call messages). An offloaded body (D15) has no inline text,
  so it neither feeds the title prompt nor the card's first message.
- **Member** = the run's lease user (what the gateway's `serverCallRunMatches` checks).
- No model-specific knobs (`reasoning_effort` left out: providers differ on it).

## Review (Opus, changes requested) and fixes

- **H1** reasoning models: reuse the catalog's `reasoning` flag (KOBE-259, already editable in
  Site > Models; no migration). `SERVER_CALL_LIMITS` gains `reasoning_max_output_tokens` (title
  512, follow-ups 768) and `SERVER_CALL_REASONING_EFFORT = "low"`; the server sends both only for
  a flagged model (`title-source.ts`); the gateway reads the flagged models with the principal
  (`GatewayPrincipal.reasoningModels`) and refuses the larger cap or a `reasoning_effort` for any
  other model (`checkServerCallBody`). Design doc updated.
- **M1** an empty reply is `empty_content`; unusable replies and nothing-to-call cases are logged
  `server call skipped` (the gateway's skip line) with code and model.
- **M2** `finish_reason: length` → `truncated`, never saved.
- **M3** fallback title = first line of the first prompt (same guard): at run end when no call
  will come (titles not configured, past three attempts), after the epilogue when the last attempt
  failed or skipped, at once for `no_model` / `no_lease`; announced with `thread.updated` there.
  So a 402 on all three attempts now ends with the first line as the title (ac-9 test adjusted).
- **L1** controls, format characters and separators stripped; `generatedTitleSchema` refuses them.
- **L2** a reply holding a link (`://`, `www.`, `[..](`) is `schema_reject`.
- **L3** the Markdown export escapes Markdown punctuation in the heading.
- **L4** the card's count reads at most 1,000 message entries (`message_count_capped`, "1000+").

## Deploy step (coordinator)

After G3 is on gate1: Site > Models > `glm-5.3-flash` → tick "Reasons before answering"
(`model_catalog.reasoning = true`). Without it gate1's titles come back empty and the threads get
the fallback title after three runs.

## Open questions

- Follow-ups (KOBE-222) inherit the reasoning headroom (768) and effort; untested until 222.

## Evidence

- ac-1, ac-5, ac-9: `services/server/src/thread-title.db.test.ts` (scripted sandbox → run end →
  fake gateway that verifies the token like the real one and writes the `title` row with
  `recordModelUsage`): titled once with `thread.updated` after `run.completed`; second run
  announces and calls nothing; renamed before the run: nothing announced or called; renamed during
  the call: rename wins, no event; gateway 402 on four runs: no title, every run `completed`, no
  `run.failed`, three attempts, the fourth not announced; usage row `kind = title`,
  `sandbox_id` NULL; thread usage `runs: []`. Unit: `threads/title.test.ts`.
- ac-2: `apps/web/components/chat/threads.test.tsx` (rail button and header follow
  `thread.updated`, no PATCH), `lib/chat/thread-controller.test.ts`, `thread-list-adapter.test.ts`.
- ac-3: `thread-title.db.test.ts` (card route: 280-char cut, count 4, 404 for a teammate),
  `threads.test.tsx` (hover shows the four fields).
- ac-4, ac-8: `services/server/src/models/gateway-client.test.ts` (token alone; no
  `authorization`, `x-api-key`, `x-goog-api-key`, `api-key`, run token, run id, `?key=`; no
  session-key master, provider-key secret or provider key anywhere in the request; 402 → code;
  timeout; no redirects), `thread-title.db.test.ts` (claims, body, headers end to end),
  `charts/kobe/tests/models.test.ts` (ingress from server pods; URL on server only).
- ac-6: `event-stream/stream.test.ts` (open until `thread.updated`, closes at the window, replay,
  reconnect state), `thread-title.db.test.ts` (reconnect after `run.completed` streams the title,
  then 204), `apps/web/lib/chat/stream.test.ts`.
- ac-7: `services/server/src/usage.db.test.ts` ("usage kinds"), `usage-pages.test.tsx`.
- Browser: `e2e/browser/tests/auto-title.spec.ts` (title in header, API and rail; hover card).
  **It fails until G3 is deployed** (gate1 runs main); the coordinator runs it after the deploy.
- Commands: `pnpm verify`; `@kobe/db`, `@kobe/model-gateway`, `@kobe/server` `test:db`.
