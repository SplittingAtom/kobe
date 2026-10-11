# KOBE-246: flaky clock tests

Tests only; no product code changed.

- model-gateway `reservations.db.test.ts`: the gate's release/settle `end()` is fire-and-forget and the
  test slept 100 ms for it to land, so a slow DB lost the race. The test now tracks each `end()` promise
  and awaits it. A new test covers the KOBE-120 hold: with `settleHoldMs` 1.5 s a settled call still
  counts, then is admitted once the DB-clock expiry passes (bounded poll).
- server `egress-requests.db.test.ts` "retries a failed email from the sweep": an unsettled send from an
  earlier test could consume `failNext`, and `sweep() === 1` counts due rows of every team. The test now
  settles first, and asserts this request's own row (pending/attempts 1, then sent/attempts 2).
  Cause inferred from code (no failing log was retrievable); both files ran 10x green locally.
