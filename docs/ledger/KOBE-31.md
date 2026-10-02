# KOBE-31: Kobe Event Stream (SSE with seq resume)

- **Status:** in review
- **Branch / worktree:** `kobe-31-event-stream` in `../Kobe-wt31`
- **Depends on:** KOBE-29 (schema), KOBE-14 (authz), contracts (`@kobe/protocol` events + SSE)

## Acceptance criteria (derived from spec D5, D9, D16–D18, D23, §5.2, §6.1, §6.2, U2, U4, Gate 1; Hadron unreachable)

1. **ac-1 Append before fan-out.** One append API for producers (KOBE-30 orchestrator, KOBE-24 sandbox
   registry): validates every event against `@kobe/protocol` (`type`, strict payload), writes
   `run_events` under the team's RLS (seq from the KOBE-29 trigger, gapless, commit order = seq
   order), small multi-row batches, and only then hints fan-out. A terminal `run.*` event is the
   last event of its run. Usable inside the caller's own transaction (KOBE-24 updates
   `runs.sandbox_seq` in the same transaction).
2. **ac-2 Postgres-only fan-out.** `LISTEN/NOTIFY` hint, no Redis; Postgres is the record and
   readers always re-read from it. NOTIFY payloads carry ids only (no team content). One dedicated
   LISTEN connection per server process (not per stream); reconnects with backoff and resyncs every
   stream after a reconnect.
3. **ac-3 SSE endpoint with seq resume (§6.1/§6.2).** `GET /v1/runs/{id}/events?starting_after=`:
   `text/event-stream`, `retry:` first, one frame per event (`id: seq`, `event: type`, `data:`
   envelope) via `formatSseEvent`; cursor = max(`starting_after`, `Last-Event-ID`); malformed cursor
   → 400; ended run with nothing after the cursor → 204; compacted run → 410 `events_compacted`;
   closes after the terminal event. Resume after a disconnect at any point is gapless and
   duplicate-free under concurrent appends (U4, Gate 1 "refresh mid-run resumes gapless").
4. **ac-4 Authorization.** Signed-in session, active team (D9), live membership, and thread
   visibility: in v1 a run's events are visible to the thread's owner only (D8/D23: team admins
   cannot read members' threads; project sharing arrives with KOBE-57). Unknown run, another team's
   run and a teammate's private run all get the same 404. A stream stops when the session is
   revoked or the membership removed (checked periodically while streaming).
5. **ac-5 Keep-alive.** `: keepalive` comments every `SSE_KEEPALIVE_MS` (15 s); each keep-alive
   tick also re-reads Postgres, so a lost hint delays an event by at most one tick.
6. **ac-6 Backpressure and slow consumers.** Events are read from Postgres only when the client can
   take them (pull-based stream), so per-connection memory is bounded (one page ≤ 50 rows and
   ≤ 1 MiB) however far the client falls behind; a client that stops reading is disconnected after
   a stall timeout and resumes from its cursor; per-user concurrent stream cap per replica.
7. **ac-7 Multi-replica.** Any replica serves any stream: events appended through one server
   instance reach streams held by another instance on the same database.
8. **ac-8 Delta batching.** A helper coalesces consecutive `text.delta`/`reasoning.delta` of the same
   message part into one event per 50–100 ms window (KOBE-29 guidance), preserves event order,
   flushes before any other event, writes batches of tens of rows, and pushes back on producers
   when writes fall behind.
9. **ac-9 Isolation at scale (U2, Gate 1).** Two teams × five users stream concurrently; each user
   receives exactly their own run's events, gapless; nobody can open another user's or team's run.

## Plan

- `services/server/src/event-stream/`: `append.ts` (validate + insert + NOTIFY in the same
  transaction), `notify.ts` (channel + id-only payload codec), `hub.ts` (LISTEN connection,
  per-run subscribers, reconnect/resync), `read.ts` (authorization load + paged reads),
  `stream.ts` (pull-based SSE ReadableStream: replay + live, keep-alive, stall detection,
  revalidation), `batcher.ts` (delta coalescing), `visibility.ts`.
- Route module `routes/run-events.ts`, mounted with one line in `app.ts`; the hub lives on
  `ServerDeps` (closed with it) and is closed first on SIGTERM so clients reconnect elsewhere.
- Tests: unit (batcher, notify codec, stream state machine with a fake source), DB integration
  (`event-stream.db.test.ts`: resume under concurrent appends with random disconnects, two
  replicas, cross-team/teammate 404, slow consumer over real HTTP, terminal close, 204/410,
  revocation, listener reconnect, 2 teams × 5 users).

## Decisions

1. **Append path (`event-stream/append.ts`).** `appendRunEvents(db, teamId, runId, events)` owns its
   `withTeam` transaction (`lock_timeout` 5 s); `appendRunEventsInTx(tx, …)` joins the caller's
   (KOBE-24 writes `runs.sandbox_seq` in the same transaction). Each event is validated with
   `parseEventPayload` (strict) before any write; U+0000 is refused (jsonb can't store it); at most
   `MAX_APPEND_BATCH` = 64 rows per call. The run row is locked `FOR NO KEY UPDATE` first and the
   append is refused once the run's last event is terminal (`run_finished`); a terminal event must
   be last in its batch. So a terminal event is always the final event of a run, which is what lets
   the stream close on it and the 204 rule hold.
2. **NOTIFY in the same transaction as the insert.** `pg_notify('kobe_run_events', '<run_id>:<seq>')`
   is queued inside the append transaction: Postgres delivers it only on commit, in commit order,
   and never for a rolled-back append. Payload = run id + last seq only (any session on the
   database may LISTEN on any channel, so no team id, text or titles). Readers never use the hint
   for content; they re-read `run_events` under their own team's RLS.
3. **One LISTEN connection per process (`event-stream/hub.ts`)**, a dedicated `pg.Client` with the
   app role, outside the query pool, started lazily on the first stream. Postgres connections per
   replica = pool (10) + 1, whatever the number of streams. Reconnects with jittered exponential
   backoff (250 ms → 10 s); after every (re)connect all subscribers re-read once (hints sent before
   LISTEN took effect are not delivered); while down, all subscribers are polled every 1 s; a
   `SELECT 1` ping every 30 s (10 s query timeout) catches half-open TCP. The LISTEN connection must
   reach Postgres directly or via a session-mode pooler (not PgBouncer transaction mode).
4. **Stream = pull-based `ReadableStream` (`event-stream/stream.ts`).** Postgres is the buffer: a page
   (≤ 50 rows, ≤ 1 MiB by `pg_column_size`) is read only when the HTTP layer asks for the next chunk
   (@hono/node-server waits for socket `drain`), and hints received meanwhile only set a flag. The
   subscription is registered before the first read, every read is `seq > lastSent`, and run state +
   events come from one statement (one snapshot), so replay → live is gapless and duplicate-free.
   Close after the terminal event, or when the run is ended and fully delivered, deleted, compacted,
   or access is lost. Read errors close the stream (EventSource resumes with `Last-Event-ID`).
5. **Keep-alive tick = safety poll.** Every `SSE_KEEPALIVE_MS` (15 s) the stream sends `: keepalive`
   (only when the client has taken the previous chunk) and re-reads Postgres, so even a lost hint
   costs at most one tick.
6. **Slow consumers.** A client that hasn't taken the last chunk for 60 s is dropped: the route
   destroys the Node response (ending the stream alone never reaches a client whose socket doesn't
   drain), freeing the subscription and slot; the client resumes from its cursor. Measured: a paused
   client on loopback got 250 × 8 KB events into socket buffers, then the server stopped reading
   Postgres (`event-stream-scale.db.test.ts`). Per user, 16 concurrent streams per replica (429
   `too_many_streams`).
7. **Authorization.** `requireSession` → `requireTeam` (active team, live membership) →
   `team.chat` → run joined to its thread under the team's RLS → `canWatchThread` (owner only in
   v1; `event-stream/visibility.ts` is where project sharing (KOBE-57) and break-glass go). Unknown
   id, malformed id, other team's run, teammate's run, team admin on a member's run: identical 404
   `not_found`. While streaming, every 30 s: session row live, still a member, run still visible;
   otherwise the stream ends. Active-team switches in another tab do not end a running stream (the
   user still belongs to that team); a reconnect then gets `requireTeam`'s 409 `team_mismatch` /
   404, as for every other team-scoped GET.
8. **Errors:** 400 `invalid_cursor`; 404 `not_found`; 410 `{"error":{"code":"events_compacted"}}`
   (shape fixed by the contract); 204 empty; 429 `too_many_streams`; other codes from KOBE-14
   middleware (401, 403, 409).
9. **Delta batching (`event-stream/batcher.ts`).** `createRunEventBatcher({ write })` merges adjacent
   `text.delta`/`reasoning.delta` of the same (message_id, content_index) for 75 ms (default) up to
   16 Ki chars, writes any other event immediately together with what precedes it, writes ≤ 50
   events per transaction, one write in flight, `push()` waits when 256 events are pending, failure
   is sticky (callers re-send from their wire cursor with a new batcher). 400 deltas → < 60 rows in
   the e2e test.
10. **Cursor beyond `last_seq` on an active run** is accepted (stream waits for seq > cursor), as the
    contract's `decideStreamOpen` allows; such a cursor can only come from a client bug since seq
    is issued on commit. Ended runs answer 204 per the contract.
11. `pg` moved from devDependencies to dependencies of `@kobe/server` (MIT; already in the lockfile).

## For KOBE-24 / KOBE-30 / KOBE-32

- **KOBE-30 (orchestrator):** end a run by setting its terminal status **and** appending its
  terminal event (`run.completed` / `run.failed` / `run.interrupted` / `run.budget_stopped`) in the
  **same transaction** (`withTeam` + `appendRunEventsInTx`); readers treat "ended + caught up" as the
  end of the stream. After the terminal event, appends fail with `run_finished`. Lock order: a
  transaction that writes the thread (entries, leaf, status) must do so **before** appending (the
  append locks the run row).
- **KOBE-24 (sandbox registry):** feed translated Pi events through `createRunEventBatcher` with
  `write: (evs) => withTeam(db, team, tx => { appendRunEventsInTx(tx, team, run, evs); update
runs.sandbox_seq })`, ack wire frames only after the write resolves, and await `push()` to pause
  the socket under backpressure. Never hold the append transaction across network I/O.
  `thread_entries` inserts (entry.committed) go before the append in the same transaction.
- **KOBE-32 (web):** `GET /v1/runs/{id}/events` uses the session cookie; `X-Kobe-Team` is optional on
  GET (EventSource can't set headers). The server sends `retry: 2000`, keep-alives, closes after the
  terminal event and answers 204 on reconnect; 410 → render the thread from entries; 404/409 → stop.
  Drop `seq <= last seen`.
- Everything is exported from `services/server/src/event-stream/index.ts`.

## Open questions (for Chris or the coordinator)

1. Visibility is owner-only until projects (KOBE-57) define read access for threads shared to a
   project; KOBE-34 (Thread API, parallel) should use the same rule — consolidate
   `canWatchThread` with its thread read check when both are merged.
2. NOTIFY serializes committing notifier transactions on a database-wide lock at commit. With
   delta batching (≈ 10–20 commits/s per streaming run) this is fine for the Gate 1 scale; at very
   high concurrency the fallback is to NOTIFY from a separate short statement after commit. Not
   needed now.
3. While the LISTEN connection is down, every stream polls once a second (load spike on a
   struggling database). Acceptable for v1; could back off or poll per run instead of per stream.
4. No `packages/protocol` issues found; contract used as is.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/event-stream.db.test.ts` › "append (ac-1)": envelopes + gapless seq,
  rejections before writing (unknown type, bad payload, U+0000, >64, terminal-not-last), other
  team's run → `run_not_found`, after terminal → `run_finished`, NOTIFY only on commit with
  `<run_id>:<seq>` payload.
- ac-2: › "delivers live events from another replica through NOTIFY, not polling" (keep-alive 10 s,
  delivery < 2 s); `event-stream-scale.db.test.ts` › "LISTEN connection loss" (backend terminated →
  event still delivered < 5 s, hub back to `listening`, NOTIFY latency < 2 s again);
  `event-stream/notify.test.ts` (id-only codec, malformed payloads ignored).
- ac-3: › "GET /v1/runs/{id}/events (ac-3)": headers, `retry:`, §6.2 framing, close after terminal;
  max(starting_after, Last-Event-ID), malformed cursors 400; 204; 410 for any cursor; "resumes
  gapless and duplicate-free after disconnects at random points under concurrent appends" (3
  concurrent writers on 2 replicas, reader cancels after 1–40 events and reconnects alternating
  replicas; received seqs == DB seqs == 1..n); `event-stream/stream.test.ts` (paging, interleaving).
- ac-4: › "authorization (ac-4)": identical 404 for unknown / malformed / other-team / teammate /
  team admin; 401 without session, 409 without active team; stream ends after member removal
  (< 3 s) and after session revocation.
- ac-5: `stream.test.ts` › "sends keep-alives while idle and re-reads on each (lost hints still
  arrive)".
- ac-6: `stream.test.ts` › "does not read ahead for a client that is not reading" (≤ 1 read while
  1000 events + hints arrive), "errors the stream for a client that stops reading";
  `event-stream-scale.db.test.ts` › "does not read ahead … disconnects it, and the client resumes
  gapless" (real HTTP, 4000 × 8 KB events, paused client dropped, slot freed, resume gapless) and
  "serves a lagging but steady reader"; per-user cap 429 + slot freed on disconnect.
- ac-7: › "delivers live events from another replica" and the random-disconnect test (appends and
  streams spread over two app instances on one database).
- ac-8: `event-stream/batcher.test.ts` (9 cases: coalescing, ordering, flush-before-other, size cap,
  batch split, in-flight isolation, backpressure, sticky failure, close);
  `event-stream.db.test.ts` › "delta batching end to end".
- ac-9: `event-stream-scale.db.test.ts` › "two teams × five users stream concurrently" (10 streams
  over 2 replicas, 60 events each + terminal, each gets exactly its own run 1..61; 90 cross-user
  opens all 404).
- `pnpm build test typecheck format:check` green; `lint` green except pre-existing `@kobe/chart`
  (Helm 4 `license` field); `pnpm --filter @kobe/server test:db` 70/70 (event-stream files stable
  over 3 repeated runs); `pnpm --filter @kobe/db test:db` 114/114.
