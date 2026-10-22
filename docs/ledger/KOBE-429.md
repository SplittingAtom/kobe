# KOBE-429: A sandbox reconnect replay can exceed the wire frame rate limit

- **Status:** in review (group branch)
- **Branch / worktree:** `group-35-reconnect-replay` in `../Kobe-wt429`

## Cause

The server charges every inbound frame against a per-connection frame bucket (500/s, burst 2,000)
and byte bucket (4 MiB/s, burst 8 MiB) and closes on the first frame over it (`connection.ts`
`#rateOk`, 4006 "frame rate exceeded"). On `hello.ack` the agent wrote its whole un-acked backlog
(outbox up to 64 MiB) to the socket at once, so a backlog over one burst got the connection
closed, the next reconnect replayed it again, and so on (KOBE-227: ~30 reconnects in a minute).

## Decisions

- Fixed in the agent only: `WireClient` sends every frame (hello, ping/pong, error, replays, live
  frames) through one FIFO `SendPacer` (`services/sandbox-agent/src/wire/pacer.ts`), a frame and
  byte token bucket reset on each new socket like the server's. Order is kept (single queue) and
  nothing is dropped while the connection lives; seqs, acks and resend dedupe are unchanged, so
  exactly-once delivery still rests on the server's seq checks. Frames queued for a socket that
  closes are dropped like unsent frames were before; `pi.event`s stay in the outbox and replay.
- Pace: `SANDBOX_SEND_PACE` in `@kobe/protocol` (400 frames/s burst 1,000; 3 MiB/s burst 4 MiB =
  one largest frame), about half the server's bursts so frames that arrive bunched still fit.
- Server limits untouched: no replay allowance, so a hostile sandbox gains nothing; the server
  still closes any connection over its buckets. `constants.test.ts` pins the agent pace below
  `WIRE_DEFAULTS`.
- Also covers a model streaming faster than the limit (live frames are paced the same way).

- CI follow-up (PR #364): `kobe-tools.real-pi.test.ts` "refuses a call whose frame would exceed
  1 MiB" timed out. Not a stuck oversized frame: the faux model streams the call's arguments as
  ~67,600 `message_update` frames (36 MB) in ~11 s, about 6,000 frames/s, so pacing them takes
  minutes. The real server would close that connection at 500/s; the old test only passed because
  the fake server has no limit. Those tests now set an unpaced `pace` (new test-only
  `AgentDeps.pace` / harness option). Follow-up worth filing: coalesce `message_update` deltas
  in the agent so a very fast model does not queue behind the pace.
- Under budget the pacer adds no delay (written in the same tick, no timer); a largest (4 MiB)
  frame goes out at once on a fresh bucket and never deadlocks (tests in `pacer.test.ts`).
- PR #364 `e2e (gate1)` failed in k3d setup (Docker could not restart `k3d-kobe-server-0` while
  installing gVisor), before any test ran: infrastructure, not this change.

## Evidence

- `services/sandbox-agent/src/wire/client.pacing.test.ts`: a fake server enforcing the server's
  bucket (closing like `#rateOk`) receives a 300-frame backlog (15x its burst, over its byte
  burst) fully and in order with no close; failed with 4006 closes before the fix.
- `services/sandbox-agent/src/wire/pacer.test.ts`: burst then refill, byte pacing, oversize frame,
  never over the bucket in any window, reset.
- `services/server/src/sandbox-wire/constants.test.ts`: agent pace < server limits.
- No server DB code touched. `agent.wire.test.ts` "abandons a run whose frames the server lost"
  failed twice under the full parallel `verify` load (fake Pi had not logged the abort yet when
  the third hello arrived); it now waits for the abort like the next test does.
- Unrelated load flakes in `verify` (pass alone): server policy perf, review-diff budget,
  export-markdown, web file-tree, sandbox-agent `kobe-exec/client.test.ts` late reply.
