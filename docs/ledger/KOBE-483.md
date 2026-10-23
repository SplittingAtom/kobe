# KOBE-483: A late frame for a just-ended run closes the whole sandbox connection

- **Status:** in review (group-43, not pushed)
- **Branch / worktree:** `group-43-late-frame` in `../Kobe-wt483`
- **Depends on:** none

## Cause (confirmed)

- gate1 server logs (both occurrences, 18:46 and 18:59): `sandbox connected … interrupted: 1`
  0.5-1.7 s before `lease violation unknown_run pi.ui_request` on the **same new connection**. The
  reconnect's hello found a run leased to the sandbox that the agent no longer offered (it was
  stopping it) and interrupted it, so the new connection never held a lease for it.
- The agent aborts runs the hello.ack does not list, but Pi still emits a UI request
  (`setStatus`/`notify`) while aborting; the thread still holds the run, so the agent sent
  `pi.ui_request` naming it on the new connection → `unknown_run` → close → every run on that
  connection interrupted.
- On one connection the server already kept ended leases (late frames answered `run_not_active`);
  the gap was runs that ended _without_ a live lease on the connection (hello interrupt, or an ended
  lease evicted by the 256 cap). The KOBE-429 pacer widens the window: queued frames of a run go
  out after the run ended.

- Trigger (coordinator, gate1): the server closes every sandbox connection `unauthorized`
  ("session token expired") 13 min after it opened (token `exp` + 60 s grace), since KOBE-24
  (2026-10-02), so it predates Wave 2. The agent traded for fresh tokens but only used them on the
  next dial. The forced reconnect interrupts a run being started or stopped, and the late frame of
  that run then closed the new connection too.

## Decisions

- Server: `RecentlyEndedRuns` (`sandbox-wire/recently-ended.ts`), 30 s grace, at most 256 runs per
  connection. Filled with runs the hello interrupted (DB-verified as leased to this sandbox) and
  every ended lease. A frame naming such a run on its own thread is dropped (`run_not_active`, debug
  log, `lateFrames` metric), never processed. Another thread → `unknown_thread`, any other run or
  after the window → `unknown_run`; both still close with `lease_violation`.
- Agent: `WireClient.endRun(runId)` on run end (Stop/abort/finish), for runs the hello.ack does not
  list (before aborting them) and on abandon. It withdraws the run's frames still waiting in the
  pacer (`SendPacer.dropTagged`) and refuses later ones. `pi.event` (outbox-journaled, acked late
  by the server) and `trace.spans` (tolerated late) are kept.

- In-band renewal: new sandbox → server frame `session.renew {token}` behind hello capability
  `session_renew` (protocol `session-renew-frames.ts`). The agent's `WireClient` reads its token
  every 30 s (which also makes the session client trade near expiry) and hands each new one to the
  live connection once. The server verifies it like an upgrade token. The same (sandbox, team,
  user, eval thread) moves the expiry timer to the new `exp` and revalidates at once (liveness,
  account, membership: a renewal never outlives offboarding). Another identity closes
  `unauthorized`. An invalid, expired or older token is ignored; the third invalid one closes
  `unauthorized`. Without the capability nothing
  changes. Revocation (`access revoked`, `sandbox_destroyed`) still closes at once: not deferred
  to a run boundary, since it is a security close.

## Evidence

- Repro first (failed before the fix): `agent.wire.test.ts` "never names a run the server no longer
  lists…" (fake Pi `status-hang` emits setStatus while aborting); `sandbox-wire.db.test.ts`
  "drops a pi.ui_request of a run the reconnect just interrupted…" (closed with lease_violation).
- ac-1: same file, Stop + late `pi.ui_request` on the holding connection and the reconnect case:
  connection stays, nothing answered.
- ac-2: same tests: a run never leased, or the right run on another thread, still closes; existing
  compromised-sandbox suite unchanged and green.
- ac-3: `wire/pacer.test.ts`, `wire/client.pacing.test.ts` (queued frames of an ended run dropped,
  later ones refused, events and other runs delivered). gate1 u21/status-cues rerun pending a
  deploy.
- Renewal: `sandbox-wire-limits.db.test.ts` (2 s tokens renewed in band: open after 4.5 s, then
  closes once renewals stop; invalid renewal ignored; another identity closes; no capability, no
  renewal), `wire/client.pacing.test.ts` (each fresh token sent once, never the dialled one),
  `session-renew-frames.test.ts`.
- CI (PR #373): `kobe-exec.real-pi.test.ts` reuses one run id for two runs; `endRun` kept the id
  "ended", so the second run's `policy.check` was dropped and its tool failed. `WireClient.startRun`
  clears it when a run starts (`agent.runs.test.ts` "relays the checks of a run started again…").
