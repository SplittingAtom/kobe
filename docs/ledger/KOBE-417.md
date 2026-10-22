# KOBE-417: Idle sandboxes poll POST /v1/sandbox/session ~2/s (409) and each poll is a trace

- **Status:** in review (group 36)
- **Branch / worktree:** `group-36-idle-session-polls` in `../Kobe-wt417`
- **Depends on:** none

## Plan

Long-poll the unassigned session exchange on the server, have the agent use it (with a backoff
fallback), and keep routine `sandbox_unassigned` answers out of tracing.

## Decisions

- **Long-poll, not a signal.** The claim → pod adoption is done by the agent-sandbox controller
  (it labels the warm pod with the claim UID); nothing server-side records it and the kube client
  has no watch, so the server has no event to wake on. The route holds a request carrying
  `Prefer: wait=<s>` (RFC 7240) for at most 20 s (`SESSION_WAIT` in
  `services/server/src/sandbox/session-hold.ts`, also the cap on the client's ask), then answers
  409 `sandbox_unassigned` with `Preference-Applied: wait=<s>` and `retry_after_ms: 250`.
  Without `Prefer` the answer is immediate with `retry_after_ms: 2000` (older agents unchanged).
- **Review once, recheck the pod (review fix 1).** `identifyBootstrapToken` (TokenReview +
  RuntimeClass + Pod + Namespace) runs once per request; during the hold
  `provider.recheckAssignment` does one Pod GET every 2 s, and the full claim + isolation checks
  only once the pod carries a claim label. The hold ends by the token's `exp` (read from the
  already reviewed JWT), so the next request re-reviews a rotated token. A pod gone or replaced
  mid-hold → 401.
- **Holds per pod (review fix 2):** at most 2 concurrent holds per `namespace/pod`; extra
  requests get an immediate, unheld 409 (the agent then backs off). The rate limiter still takes
  one token per request.
- **Shutdown (review fix 3):** `index.ts` aborts a `closing` signal before closing the sandbox
  listener: held requests answer 409 (held) at once so the agent re-asks another replica in
  ~0.25 s; no new holds start.
- **Agent** (`services/sandbox-agent/src/session/exchange.ts`): first attempt as before (2 s
  timeout, fast cold-start retries). After its first `sandbox_unassigned` it asks with
  `Prefer: wait=20` (timeout 2 s + 20 s) and, after a held answer, asks again within ~0.25 s.
  If the server does not hold the request, exponential backoff with equal jitter, 2 s doubling to
  a 60 s cap (`UNASSIGNED_BACKOFF`). Transport failures now back off on consecutive failures since
  the last server answer, not total attempts, so a server restart after a long idle wait retries
  in ~0.25 s instead of up to 30 s.
- **Per idle pod per minute:** HTTP requests 30 → 3; apiserver calls 120 (30 identifies × 4)
  → 42 (3 identifies × 4 + 30 pod GETs); the first cut of this fix (full identify every 1 s) was 240. Test: `sandbox.test.ts` "costs ~42 apiserver calls per idle pod per minute".
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
- Claim → ready latency (claim → 200 at the agent), real timers, local HTTP, 16 trials each with
  the claim at a random 3–7 s: old 2 s poll mean 964 ms, max 1633 ms; long-poll with the 2 s pod
  recheck mean 1013 ms, max 1977 ms (unchanged: both bounded by 2 s). The first cut's 1 s recheck
  gave mean 677 / max 979 ms at 240 apiserver calls per minute; `recheckMs` is the knob.
