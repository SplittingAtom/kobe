# KOBE-42: Budgets, warnings, finish-current-step stop, rate limits

- **Status:** in review
- **Branch / worktree:** `kobe-42-budgets` in `../Kobe-wt42` (based on `kobe-43-run-usage`, PR #56)
- **Depends on:** KOBE-40 (shim seams), KOBE-30 (`stopForBudget`), KOBE-37 (approval expiry),
  KOBE-43 (`run_usage`)

## Brief and spec (D30, D6, D8)

Dollar budgets, monthly with an optional daily cap, at install, team and user-in-team levels. At
80 % warn the user and team admin; at 100 % the in-flight run finishes its current model step,
then ends ("Team budget reached"), new runs are blocked, pending approvals expire. Per-user
request rate limits at the gateway. Enforce per sandbox/user/team in `CallGate` (the run id is
advisory, KOBE-41), Bifrost limits as a backstop if they work with logging off. Audit
`models.budget.changed`, `models.budget.reached`. UI in the team and install consoles. Gate 2:
"budget stops a run after its current step" in a db test and in `e2e/run.sh`.

## Design

```
shim: call ─▶ CallGate (BudgetGate) ─▶ Bifrost ─▶ provider
              │ 402 budget_exhausted / 429 rate_limited        │ usage → run_usage (KOBE-43)
              │ state: loadMemberBudgetState (cached 1 s,      │   trigger → model_spend_daily (team)
              │ dropped on spend:/budgets: hints)              │           + install_model_spend_daily
              ▼                                                ▼ NOTIFY spend:<team>
server: BudgetMonitor (LISTEN + 30 s sweep) ── 80/100 % ─▶ budget_alerts (once per period)
              │                                             ├─ budget_alert_emails (outbox)
              │                                             └─ audit models.budget.reached (100 %)
              └─ used up ─▶ orchestrator.stopForBudget ─▶ queued runs end, running: run.stop after_step
        run start: RunBudgetGate (same numbers) ─▶ 429 budget_exhausted
```

- **Data** (`packages/db` `schema/budgets.ts`, migrations `0046_budgets`, `0047_budgets_rls`):
  `install_model_limits` † (one row: monthly/daily USD, per-user requests per minute, default 60),
  `team_budgets` (team, RLS: the team row with an optional lower rate, and member rows),
  `model_spend_daily` (team, RLS: cost and calls per UTC day and user) and
  `install_model_spend_daily` † (per day), both kept by a statement-level `AFTER INSERT` trigger on
  `run_usage` (transition table; invoker's rights, so the team row passes RLS; the migration
  backfills existing ledger rows team by team), `budget_alerts` † (scope, team, user, period,
  threshold; `UNIQUE NULLS NOT DISTINCT`: once per budget and period across replicas) and
  `budget_alert_emails` † (outbox). Shared reads in `@kobe/db` `models/budgets.ts`
  (`loadTeamBudgetLines`, `loadMemberBudgetState`, `exhaustedLine`, `percentUsed`): one source of
  numbers for the shim, the run gate and the monitor. A budget check reads ≤ 31 small rows.
- **Shim** (`services/model-gateway/src/budget-gate.ts`): `BudgetGate` implements `CallGate`.
  Used-up budget at any level (widest named) → 402 `budget_exhausted` "Your team's monthly model
  budget is used up."; per-member token bucket at the effective rate → 429 `rate_limited` with
  Retry-After. The ledger writer flushes right after each call and then NOTIFYs `spend:<team>`;
  shims drop that team's cached states (`ModelsListener`), the server's monitor evaluates.
- **Server** (`services/server/src/budgets/`): `BudgetMonitor` (every replica; evaluations are
  idempotent: alerts unique, `stopForBudget` idempotent) records thresholds, queues emails
  (team admins; plus the member for their own budget; install admins for the install budget),
  audits `models.budget.reached` at 100 %, and calls `stopForBudget` for every used-up level
  (install: every team, at once when it is first reached). `DB_RUN_BUDGET_GATE` is the
  orchestrator's `RunBudgetGate`. `outbox.ts` delivers emails at least once (lease, backoff,
  `failed` after 8 attempts, inactive recipients `skipped`).
- **Finish-current-step:** unchanged KOBE-30 machinery (`after_step` stop at Pi's `turn_end`,
  queued runs end at once, approvals expire). New in `run-state.ts`: a run with a pending budget
  stop that **fails** (its next model call refused by the shim before the stop reached Pi) also
  ends `budget_stopped`. Without a pending stop, the refusal fails the run with its own clear
  message (`model_budget_exhausted`).
- **Rate limits:** the per-user rate (install's, or the team's lower one) is enforced per shim
  replica and pushed by the gateway sync as each member's virtual-key `rate_limit`
  (`request_max_limit`, `1m`): Bifrost enforces it install-wide (one Bifrost replica). The
  reconciler compares the observed limit (`vkDiffers`), so an unchanged rate writes nothing.
- **API:** `GET /v1/team/budgets`, `PUT /v1/team/budgets/team`, `PUT|DELETE
/v1/team/budgets/members/:userId` (`team.budgets.manage`), `GET /v1/team/budgets/status` (every
  member: their applicable budgets and state), `GET|PUT /v1/install/budget` (new
  `install.budgets.manage`, Admin).
- **Web:** team console **Budgets** (team budget, rate, member budgets with spend), install console
  **Usage and spend** gains the install budget form, chat banner at 80 % / 100 %.

## Bifrost with `enable_logging: false` (brief: verify)

- Read in Bifrost v2.2.5's source (`plugins/governance/main.go` `PostLLMHook` → `postHookWorker` →
  `UsageTracker`): governance accounting (budgets and rate limits) runs in the governance plugin
  itself and does not depend on the logging plugin; the "batch accounting sweeper not wired"
  warning concerns batch APIs only.
- **Rate limits: verified against the real binary** (`bifrost.int.test.ts` "KOBE-42: enforces a
  member's request rate on the virtual key with logging off", run locally with
  `KOBE_TEST_BIFROST_BIN`: 2/min → third call 429; an unchanged limit is not rewritten).
- **Dollar budgets: not pushed to Bifrost.** Bifrost prices calls with its own model price list
  (`modelCatalog.CalculateCost`), which has no entries for models it does not know (Ollama Cloud,
  self-hosted) and differs from the admin-set catalog prices, so its budgets would trip at other
  amounts than Kobe shows, or never. Kobe's ledger and gate are the dollar enforcement.

## Decisions

- **Periods are UTC** calendar months/days (no install time zone setting exists).
- **Unpriced models cost nothing** against dollar budgets (tokens are still counted, KOBE-43); a
  `$0` budget allows nothing. Open question 1.
- **Who is warned by email:** team admins (team and member budgets), the member (own budget),
  install admins (install budget). In-app: every member sees the chat banner for the budgets that
  apply to them (install, team, own), and team admins the console. D7 lists SMTP for
  notifications; D30 says "warn the user and team admin".
- **Rate limit semantics:** per user and team (bucket key team:user), not per sandbox; the
  KOBE-40 per-sandbox request rate (10/s) remains the abuse bound.
- **Audit:** `models.budget.changed` (scope any: install without team, team/user with team) and
  `models.budget.reached` (system, once per budget and period). The 80 % warning is not audited
  (it is in `budget_alerts`).
- **Order of stops:** the widest used-up scope names the stop (install > team > user).

## User decisions

- **2026-10-04 (via the coordinator): token budgets beside dollar budgets.** Open question 1
  (unpriced models are free against dollar budgets) is answered with token budgets: per period
  (monthly, optional daily cap), at install, team, default-member and member levels, enforced by the
  same call gate, run gate and monitor (80 % warnings, finish-current-step stop, audit, UI).
  Per-model prices stay optional. **Tokens counted:** input + output + cache reads + cache writes —
  every token a call processed, the same for every provider; token budgets exist mainly for
  models without prices, where cached tokens cost the same capacity, and counting them keeps one
  simple rule. Built: `*_tokens` columns on `install_model_limits` and `team_budgets`,
  `tokens` on both daily counters (trigger), `unit` on budget lines and alerts. Tests: db "a token
  budget caps a model without prices", server "a token budget stops a run on a model without
  prices" (run ends `budget_stopped`, alerts and audit in tokens, status shows both units),
  model-gateway `budget.db.test.ts` (the real shim refuses with 402 after the ledger shows the
  token budget used up, through the `spend:` hint; a raised budget through `budgets:`).

## Independent security review (coordinator) — resolutions

- **HIGH-1 forgeable/tamperable budget data** (`0047_budgets_rls.sql`):
  - spend counters (`model_spend_daily`, `install_model_spend_daily`) accept writes only from the
    `run_usage` trigger (`kobe_spend_guard`: trigger depth 2) or a team cascade; the ledger itself
    is append-only (KOBE-43);
  - `budget_alerts` is insert-only and a `BEFORE INSERT` trigger verifies each row: the current
    UTC period, the limit as configured now (member default included), the spend recomputed from
    the counters (the row's own amount is replaced), and a team's row only in its own context;
    a forged row can only be a true alert;
  - `budget_alert_emails` rows come only from the `AFTER INSERT` trigger on `budget_alerts`
    (recipients chosen in SQL; a guard refuses direct inserts); delivery may update the status
    columns only (column grant);
  - RLS on both: a team's alerts and emails in its own context only, the install's everywhere;
    the outbox delivers per context;
  - `install_model_limits` changes require `updated_by` to be an active install admin (asserted by
    the server like the legal-hold and break-glass ids) and are audited by the API. **Residual:**
    the app role can still change budgets through the statements the admin API uses (as it can
    every install setting); there are no SECURITY DEFINER functions by catalog rule.
  - Tests: db "integrity against the app role" (forged alerts, tampered counters, direct emails,
    install limits by a non-admin — all refused; cross-team alert reads hidden).
- **MEDIUM-2 overshoot:** the gate reserves an admitted call's possible cost (input estimate +
  the output it allows, dollars at the catalog price) at its install, team and member levels and
  refuses when spend + reservations reach a budget (bound as built: re-review below). Test: `budget-gate.test.ts` "reserves an admitted call's possible cost".
- **MEDIUM-3 one sandbox exhausting a shared budget:** optional default member budget per team
  (`member_default`, no default value). Test: server "the team's default member budget caps a
  member without one of their own".
- **MEDIUM-4 per-replica rate:** documented (effective ≤ replicas × rate); Bifrost's virtual-key
  limit is the install-wide backstop, pushed on every sync pass (a rate change bumps the desired
  version; verified against the real binary).
- **MEDIUM-5:** stops run before alerts; each alert is isolated (a failure is logged, the rest go on).
- **LOW-6a:** team admins see the install budget in percent only (no amounts). **6b:** an active run
  already budget-stopping is skipped (no repeated `run.stop`), and a pending user abort is never
  downgraded (tests: Gate 2 "a repeated evaluation neither re-requests nor re-sends the stop").
  **6c:** only Kobe's `budget_exhausted` or Bifrost's `policy_budget_exceeded` map to
  `model_budget_exhausted` (a provider's own 402 is `model_error`; the shim's Gemini errors carry
  the code as an ErrorInfo `reason`). **6d:** an 80 % email is skipped once its 100 % alert
  exists, and at most 20 budget emails per recipient per UTC day. UTC is stated in the UI.
- **Tests:** the Gate 2 e2e is deterministic (the fake model's tool step runs 3 s, so the stop
  reaches Pi during the step); a db test drives the real shim gate (402) through the NOTIFY path.

## Re-review (coordinator) — resolutions

- **HIGH (depth guards spoofable as superuser):** closed by the existing revoke in `migrate.ts`
  (CREATE on schema public; CREATE, TEMPORARY on the database, from PUBLIC) and the app role's lack
  of TRIGGER: proven for the real app role by `app-role-capabilities.db.test.ts` (#56; the temp
  table, pg_temp function and own-trigger steps are refused). The guards say they rely on it.
  `pg_trigger_depth` guards in the repo: `0005_conversations_rls.sql` (run/thread seq counters),
  `0020_agent_versions_rls.sql` (published agent versions), `0045_run_usage_rls.sql` (#56),
  `0047_budgets_rls.sql` (`kobe_spend_guard`, `kobe_budget_email_guard`). None changed beyond the
  comments; the GUC hardening was skipped (the coordinator's call: revoke + test suffice).
- **MEDIUM (reservation fairness):** on a shared line (install, team) each member's in-flight
  reservations count only up to a quarter of what is left (`MEMBER_SHARE`); a member whose own
  reservations reach that share is refused (429 `too_many_calls_in_flight`), not everyone else.
  Test: `budget-gate.test.ts` "one member cannot hold a shared budget with reservations".
- **MEDIUM (release timing):** a call whose ledger row is on its way keeps its reservation until
  the sink reports the row written (`onWritten` → drop the cached spend, then `settle(callIds)`),
  or 30 s if the write is lost. Test: "keeps a written call's reservation until its ledger row
  lands". **The overshoot bound, as built:** a call is admitted only while spend plus the in-flight
  reservations (each call's input estimate + output allowance, fairly shared) stay under the
  budget, and both the reservation and the recorded spend cover a call until its row lands. Per
  shim replica a budget is exceeded by at most the last admitted call's reservation, plus what a
  call's real usage exceeds its reservation (input underestimated by size / 4, e.g. images;
  output beyond the 65,536 ceiling, #56 residual). Replicas do not share reservations: with R
  replicas, up to about the budget that was left, per replica (follow-up ticket: Postgres-backed
  reservations).
- **Install limits:** the updater id is caller-supplied (residual, unchanged; above).

## Self security review (security-reviewer agent) — resolutions

- **H1** install-wide tables writable by the app role from any team context: kept as the repo's
  model (no `SECURITY DEFINER` functions is a catalog rule; the trigger runs with the invoker's
  rights, so the app role writes `install_model_spend_daily`; a compromised server path can do
  far worse). Added `budget_alerts_crossed` (a threshold row can only record a crossed threshold,
  so an early forged row cannot pre-empt the real alert).
- **H2** unpriced models are free against dollar budgets: by design (prices optional, brief);
  open question 1; the budgets page says so.
- **M1** overshoot: a budget is judged before a call from what the ledger holds; calls in flight
  (≤ the per-sandbox concurrency, 16) can each finish past it. Documented bound, as D30 asks the
  current step to finish.
- **M2** rate-limit buckets evict the least recently used member instead of clearing all; per
  replica by design, Bifrost's virtual-key limit is the install-wide backstop.
- **M3** one member can use up the team's budget: per-member budgets exist for that; no default.
- **M4** install spend leaked to teams in dollars: the team view shows the install budget in
  percent only; the member status gives no install amounts.
- **M5** the monitor skips a recorded alert before computing recipients; sweeps don't overlap.
- **M6** only `completed` or `model_budget_exhausted` failures become `budget_stopped` under a
  pending stop; other failures keep their code (test "another failure while a budget stop is
  pending keeps its own code"; the fake sandbox now holds its `run.stop` answer as the real agent
  does).
- **L6** malformed budget hints are ignored (no cache flush). Kept: L1 (concurrent first
  insert of a budget row → one 500, retry works), L2 (`run_usage` is append-only: the app never
  updates or deletes it), L3 (the 60/min default is in the install guide), L4, L5 (the real
  Bifrost response shape is covered by `bifrost.int.test.ts`).

## Contract changes (`packages/protocol`, flagged)

1. `MODEL_RUN_ERROR_CODES` gains `model_budget_exhausted` (and its copy in the sandbox agent's
   `kobe-models/protocol.ts`): kobe-models maps the shim's 402 `budget_exhausted` and Bifrost's
   `policy_budget_exceeded` to it (never retried); the server shows its own message.

## For downstream tickets

- **KOBE-44 (admin UI):** catalog prices are editable through the catalog API (KOBE-43); budgets
  have their own pages now.
- **KOBE-64 (schedules):** scheduled runs go through the same run gate (blocked at 100 %).
- **KOBE-71 (Pi on its own uid):** per-run budgets become possible once the run id is
  trustworthy; today budgets are install/team/user only.

## Open questions

1. ~~Unpriced models and dollar budgets~~ — decided: token budgets (User decisions).
2. Install time zone for budget periods (UTC today).

## Evidence

| Item                 | Evidence                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate 2 (db)          | server `budgets.db.test.ts` "finishes the step in flight, ends the run budget_stopped, warns, emails and refuses new runs" (two replicas, real wire: queued run ends, `run.stop after_step`, Pi's step completes and its text is kept, `run.budget_stopped` with the team message, 429 for new runs) |
| Gate 2 (e2e)         | `e2e/run.sh` KOBE-42 block: real Pi + fake model tool step through shim and Bifrost; run ends `run.budget_stopped`, one model call in the ledger, `models.budget.reached` once, next message 429                                                                                                     |
| Refused next call    | server "a step whose next model call the gateway refused still ends budget_stopped"; "without a pending stop … fails the run with a clear message"                                                                                                                                                   |
| Member budgets       | server "a member's own budget stops only that member's runs"; API test (team admin only, validation, audit, member status sees own only)                                                                                                                                                             |
| Counters, state, RLS | db `budgets.db.test.ts` (trigger per day/user and install day, UTC day boundary, RLS, team/member lines, widest exhausted, uniqueness); probe fixtures `team_budgets`, `model_spend_daily`                                                                                                           |
| Call gate            | model-gateway `budget-gate.test.ts` (402 widest scope, cache + invalidation, per-member rate 429 + Retry-After, zero budget)                                                                                                                                                                         |
| Bifrost backstop     | `reconcile.test.ts` "pushes each member's request rate…"; `bifrost.int.test.ts` real binary (local)                                                                                                                                                                                                  |
| kobe-models mapping  | sandbox-agent `errors.test.ts` (402 / `budget_exhausted` / `policy_budget_exceeded` → `model_budget_exhausted`, not transient)                                                                                                                                                                       |
| UI                   | web `budgets-pages.test.tsx` (team page, member budgets, install budget, banner text), `conversation.test.tsx` banner, `usage-pages.test.tsx`                                                                                                                                                        |

## After KOBE-43 merged (#56)

- Took main's run_usage code and migrations (0044/0045); this branch adds only `0046_budgets`,
  `0047_budgets_rls`. Budgets never read the float `cost_usd`: spend comes from the daily counters
  the run_usage trigger sums in numeric, and the used-up test (`lineUsedUp`, gate, monitor, new-run
  gate) compares the numeric text exactly (`spentExact` vs `limitExact`) and token counts as
  integers. Floats stay for display, percentages and in-flight estimates.

## DB review of #61 — resolutions

- **HIGH 1:** prices load before the check; check + reserve have no await between them. Test:
  "admits at most what a nearly used-up limit allows under concurrent calls".
- **HIGH 2:** `TtlCache` generation counter: invalidation clears in-flight loads and a load from an
  older generation is not cached. Test: `cache.test.ts` "does not cache a load that began before an
  invalidation".
- **MEDIUM:** the member share caps a first call too when others hold reservations; overshoot
  comment corrected (per replica, up to about the budget left; no cross-replica reservations).
- **MEDIUM:** warning thresholds compare exactly (`thresholdReached`, integer math on numeric text).
- **MEDIUM:** `kobe_budget_alert_verify` requires a `team_members` row for a user-scope alert.
