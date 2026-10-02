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
5. **ac-5 Keep-alive.** `: keepalive` comments every `SSE_KEEPALIVE_MS` (15 s); a periodic safety
   re-read of Postgres bounds the delay of an event whose hint was lost.
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
   app role, outside the query pools, started lazily on the first stream. Postgres connections per
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
5. **Keep-alive and safety read.** Every `SSE_KEEPALIVE_MS` (15 s) the stream sends `: keepalive`
   (only when the client has taken the previous chunk); it re-reads Postgres on its own only after
   60 s without a read (review MEDIUM-3), so a hint lost on a seemingly healthy connection costs at
   most 60 s, and the hub's ping (30 s + 10 s timeout) bounds that case further.
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
   `not_found`. While streaming, every 30 s (one statement): session row live, role still holds
   `team.chat`, run still visible; otherwise the stream ends (max latency 45 s). Active-team switches in another tab do not end a running stream (the
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
10. **Cursor beyond `last_seq` on an active run → 400 `invalid_cursor`** (review MEDIUM-2; was:
    accepted). No honest client holds a seq the run hasn't issued (seq is assigned on commit), and a
    non-200 stops EventSource, so a bad cursor can't cause a reconnect loop. Ended runs still
    answer 204 per the contract. The reader compares `seq > $after::bigint`, so any safe-integer
    cursor is accepted by SQL.
11. `pg` moved from devDependencies to dependencies of `@kobe/server` (MIT; already in the lockfile).

## Review round 1 (coordinator DB review of PR #18) — resolution

1. **HIGH run_finished race:** the lock and the last-event check were one statement; a statement
   that waits on a row lock in READ COMMITTED re-checks only the locked row, while the
   `run_events` subselect kept its pre-wait snapshot, so an append queued behind a terminal append
   saw no terminal and wrote after it. Now: `SELECT … FOR NO KEY UPDATE` first, then a **separate**
   statement (fresh snapshot, includes everything committed before the lock was granted) reads the
   last event's type. Test (red before the fix, both `run.completed` and `run.interrupted`): A
   appends the terminal and holds its transaction; B (another replica's pool) appends a delta and
   is observed waiting on a lock in `pg_stat_activity`; A commits; B fails `run_finished`; only seq 1
   exists.
2. **MEDIUM cursor > int4:** decision 10 above; `::bigint` in the page query; tests for `3` (last+1),
   `2147483648`, `9007199254740991` on an active run (400), reader with 2^40 (no throw), ended run
   with a huge cursor (204).
3. **MEDIUM DB cost:** streams no longer use the API pool. `createStreamReader` owns a dedicated
   pool (`STREAM_POOL_MAX` = 4, `application_name = kobe-event-stream`); each read is one read-only
   transaction in **3 round trips** (`BEGIN READ ONLY; SELECT set_config('kobe.team_id', '<uuid>',
true)` as one simple query with a regex-validated UUID literal, the statement, COMMIT) instead of
   ~5 via `withTeam`. **Coalescing:** concurrent `readPage` calls for the same (team, run, cursor)
   share one query, so the caught-up watchers of a run cost one read per wake-up. **Jitter:** hub
   resyncs (after reconnect, and the polling while down) fire one random delay per run within 1 s
   (reconnect) / the poll interval, so watchers of one run still coalesce and different runs spread
   out. **Fewer reads:** keep-alive ticks no longer re-read; a stream re-reads on its own only after
   `safetyReadMs` = 60 s without a read. **Revalidation** is one statement (session live, role,
   thread owner) on the stream pool every 30 s.
   **Numbers per replica:** connections = API pool 10 + stream pool 4 + LISTEN 1. A streaming run
   commits ≈ 13×/s (75 ms batching) → ≈ 13 coalesced reads/s per replica that has watchers of it
   (3 round trips each, ≤ 50 rows). An idle stream costs 1 read / 60 s + 1 revalidation / 30 s
   (≈ 0.05 statements/s), so 1,000 idle streams ≈ 50 statements/s on 4 connections. Listener
   outage: ≤ 1 read per watched run per second.
4. **MEDIUM NOTIFY serialization (no change):** every notifying commit takes a database-wide lock
   to append to the notification queue. Accepted threshold: fine up to ~100 concurrently streaming
   runs (≈ 1,300 notifying commits/s at 75 ms batching; each holds the lock for microseconds).
   Planned mitigation beyond that: widen the batch window under load (100–250 ms) and/or move
   NOTIFY to a per-process coalescer that sends one `pg_notify` per run per 50 ms after commit
   (outside the append transaction) — readers already treat hints as optional (safety read +
   resync), so correctness doesn't depend on the in-transaction NOTIFY.
5. LOW connect timeout: LISTEN client `connectionTimeoutMillis` 10 s; ping/LISTEN/probe
   `query_timeout` = `pingTimeoutMs` (10 s); a lost client's socket is destroyed (end() never
   returns on a half-open socket).
6. LOW payload cap: `MAX_EVENT_PAYLOAD_BYTES` = 256 KiB (UTF-8 JSON) per event → `payload_too_large`.
   **For the protocol owner:** `tool.call.input`, `approval.requested.input` and
   `entry.committed.payload` have no size bound in `@kobe/protocol`; consider bounding them there
   (large entries go by `blob_ref`).
7. LOW revalidation checks `team.chat` (role from the same statement) besides session, membership and
   visibility. **Max revocation latency = `revalidateMs` + `keepaliveMs` = 30 s + 15 s = 45 s**
   (revalidation is evaluated on keep-alive ticks); every new connection is checked at once.
8. LOW `withAppendTx(db, teamId, fn)` = `withTeam` + `SET LOCAL lock_timeout = '5s'`, exported for
   `appendRunEventsInTx` callers; `appendRunEvents` uses it.
9. LOW the random-resume test uses a seeded PRNG (`KOBE_TEST_SEED`, seed in the assertion message);
   half-open test: a TCP proxy silently swallows the LISTEN connection's traffic → ping times out →
   hub goes down, reconnects, resyncs, and a NOTIFY is heard again.
10. LOW **LISTEN needs a session-mode connection**: direct to Postgres or a session-mode pooler, never
    PgBouncer `pool_mode=transaction`. Detected on every (re)connect: the hub `pg_notify`s a
    `probe:<nonce>` to itself and requires the echo within `pingTimeoutMs`; otherwise it logs
    "LISTEN connection does not receive notifications … (not transaction mode)", stays in polling
    mode and retries with backoff. (Not tested against a real transaction pooler; the probe path
    runs on every connect in the tests.)

## For KOBE-24 / KOBE-30 / KOBE-32

- **KOBE-30 (orchestrator):** end a run by setting its terminal status **and** appending its
  terminal event (`run.completed` / `run.failed` / `run.interrupted` / `run.budget_stopped`) in the
  **same transaction** (`withAppendTx` + `appendRunEventsInTx`); readers treat "ended + caught up" as the
  end of the stream. After the terminal event, appends fail with `run_finished`. Lock order: a
  transaction that writes the thread (entries, leaf, status) must do so **before** appending (the
  append locks the run row).
- **KOBE-24 (sandbox registry):** feed translated Pi events through `createRunEventBatcher` with
  `write: (evs) => withAppendTx(db, team, tx => { appendRunEventsInTx(tx, team, run, evs); update
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
2. NOTIFY serialization: accepted threshold and mitigation in review item 4.
3. Protocol: event payloads without a size bound (review item 6); the server caps at 256 KiB.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/event-stream.db.test.ts` › "append (ac-1)": envelopes + gapless seq,
  rejections before writing (unknown type, bad payload, > 256 KiB, U+0000, >64, terminal-not-last),
  other team's run → `run_not_found`, after terminal → `run_finished`, the two-transaction race
  behind a terminal event → `run_finished`, NOTIFY only on commit with `<run_id>:<seq>` payload.
- ac-2: › "delivers live events from another replica through NOTIFY, not polling" (keep-alive 10 s,
  delivery < 2 s); `event-stream-scale.db.test.ts` › "LISTEN connection loss" (backend terminated →
  event still delivered < 5 s, hub back to `listening`, NOTIFY latency < 2 s again) and
  "half-open LISTEN connection" (ping timeout → reconnect → resync → hint);
  `event-stream/notify.test.ts` (id-only codec, malformed payloads ignored).
- ac-3: › "GET /v1/runs/{id}/events (ac-3)": headers, `retry:`, §6.2 framing, close after terminal;
  max(starting_after, Last-Event-ID), malformed cursors 400, cursor beyond last seq / int4 400;
  204; 410 for any cursor; coalesced reads on the stream pool; "resumes
  gapless and duplicate-free after disconnects at random points under concurrent appends" (3
  concurrent writers on 2 replicas, reader cancels after 1–40 events and reconnects alternating
  replicas; received seqs == DB seqs == 1..n); `event-stream/stream.test.ts` (paging, interleaving).
- ac-4: › "authorization (ac-4)": identical 404 for unknown / malformed / other-team / teammate /
  team admin; 401 without session, 409 without active team; stream ends after member removal
  (< 3 s) and after session revocation.
- ac-5: `stream.test.ts` › "sends keep-alives while idle and re-reads after safetyReadMs (lost
  hints still arrive)", "does not query Postgres on keep-alive ticks before safetyReadMs".
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
- Review round 1: `pnpm --filter @kobe/server test:db` 75/75 (event-stream files 25/25, three
  repeated runs); unit 34 event-stream tests.
