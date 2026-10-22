# KOBE-417: Idle sandboxes poll POST /v1/sandbox/session ~2/s (409) and each poll is a trace

- **Status:** in review (group 36)
- **Branch / worktree:** `group-36-idle-session-polls` in `../Kobe-wt417`
- **Depends on:** none

## Plan

Long-poll the unassigned session exchange on the server, have the agent use it (with a backoff
fallback), and keep routine `sandbox_unassigned` answers out of tracing.

## Decisions

- **Long-poll, not a signal.** The claim → pod adoption is done by the agent-sandbox controller
  (it labels the warm pod with the claim UID), so the server has no in-process event to wake on.
  The route holds a request carrying `Prefer: wait=<s>` (RFC 7240) and re-runs
  `identifyBootstrapToken` every 1 s (`SESSION_WAIT.recheckMs`) for at most 20 s
  (`SESSION_WAIT.maxWaitMs`, also the cap on the client's ask); then 409 `sandbox_unassigned`
  with `Preference-Applied: wait=<s>` and `retry_after_ms: 250`. Stops early when the client goes
  away or identification fails (401/503 as before). Without `Prefer` the answer is immediate with
  `retry_after_ms: 2000` (older agents unchanged). The rate limiter takes one token per request.
- **Agent** (`services/sandbox-agent/src/session/exchange.ts`): first attempt as before (2 s
  timeout, fast cold-start retries). After its first `sandbox_unassigned` it asks with
  `Prefer: wait=20` (timeout 2 s + 20 s) and, after a held answer, asks again within ~0.25 s.
  If the server does not hold the request, exponential backoff with equal jitter, 2 s doubling to
  a 60 s cap (`UNASSIGNED_BACKOFF`). Transport failures now back off on consecutive failures since
  the last server answer, not total attempts, so a server restart after a long idle wait retries
  in ~0.25 s instead of up to 30 s.
- **Requests per idle pod:** one every 2 s → one every ~20 s (≈10×). Server-side rechecks stay
  in-process (TokenReview + pod/claim GETs once a second per held pod, previously once per 2 s per
  HTTP request).
- **Telemetry:** `skipRequestTrace(c)` in `@kobe/telemetry` (hono.ts): the request span is never
  ended, so never exported. Only for leaf handlers (no child spans); a 5xx or throw after marking
  is still traced. The session route marks only `sandbox_unassigned`; grants (200), 401, 429 and
  503 keep their spans.

## Evidence (acceptance criteria → test or command output)

- ac-1 (code): `services/server/src/routes/sandbox.test.ts` "leaves routine sandbox_unassigned
  answers untraced" / "still traces grants and refusals"; `packages/telemetry/src/http.test.ts`
  "skipRequestTrace (KOBE-417)". Langfuse check on gate1 after deploy (count `POST
/v1/sandbox/session` in `events_core` per hour; expect ~0 with 5 warm sandboxes).
- ac-2: `sandbox.test.ts` "long-poll while unassigned" (claim at 4.5 s answered at the 5 s
  recheck); `exchange.test.ts` "SessionClient while its warm-pool pod is unassigned".
- Claim → ready latency (claim → 200 at the agent), real timers, local HTTP, 12 trials each with
  the claim at a random 3–7 s: old 2 s poll mean 971 ms, max 1868 ms (43 requests); long-poll
  mean 677 ms, max 979 ms (24 requests). Bounded by the 1 s recheck instead of the 2 s poll.
