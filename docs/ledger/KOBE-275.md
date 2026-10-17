# KOBE-275: Answer feedback: thumbs up/down per answer, agent-owner quality totals, Langfuse scores

- **Status:** implemented on `group-2-quality` (not pushed); console page waits for G7; gate1 checks pending
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2` (group branch with KOBE-274, no own PR)
- **Depends on:** KOBE-274 (run trace ids), KOBE-273 (gate1 Langfuse), KOBE-221 (team share)

## Plan

1. Contract `packages/protocol/src/feedback.ts` (body, rating, thread list, totals, error codes).
2. DB: `answer_feedback` (0108 generated), RLS / break-glass / hold guards (0109 custom), probe.
3. Server: rate / change / clear / list routes, owner totals, export, Langfuse score queue.
4. Web chat: thumbs, reason chips and comment on each answer. 5. Browser e2e spec. 6. Docs.

## Decisions

- **Readers rate (departs from Chris's default "owner only"):** the ticket's scope says "read-only
  threads (shared to a project) can be rated by the viewer for themselves"; the spec says nothing
  about feedback. So whoever can read the thread (`findThread`: owner, project readers, team-share
  readers) rates it, each for themselves. Nobody sees another member's rating, the thread owner
  included. Chris: say if you want owner-only after all (one check in `feedback/store.ts`).
- **One row per (run, member)**, `answer_feedback` keyed (team_id, id), unique (team_id, run_id,
  user_id); composite FKs to runs, threads and (MATCH SIMPLE) thread_entries, all ON DELETE CASCADE,
  so ratings go with the run/thread (Trash purge, retention, Delete forever) and team. Only ended
  `message` runs; Trash and builder test threads refused (`thread_in_trash`, `test_thread`).
- **Reasons and comment only on a thumbs down** (checked in zod and SQL). Reasons are a closed set
  (`wrong`, `ignored_instructions`, `unsafe`, `too_slow`, `other`); comment 1..500 chars, no control
  characters except newline/tab.
- **Agent snapshot** (scope, id, version, model alias) taken at the first rating from the run's
  `run.started` event; after D18 compaction (7 days) the thread's pin, model unknown (null).
  Changes keep it. No FK on it: totals survive an archived agent.
- **Clear works after losing access:** `DELETE` touches only the caller's own row, so a reader
  whose share ended can still take back their comment; always 204 (no oracle).
- **Legal hold:** while a hold covers the thread's owner, change, clear and purge of its ratings are
  refused (KH001 → 409 `legal_hold`), TRUNCATE while any hold is active; new ratings still insert.
  Only the owner's hold counts, not the rater's: otherwise a held rater would make the retention
  purge of someone else's thread fail on every pass. Same message pattern as project files.
- **Break-glass:** `break_glass_read` policy shaped like artifacts' (thread-bound). No break-glass
  read kind exposes ratings yet (none needed for v1; the policy keeps the rule "content readable
  only under a grant").
- **Not audited** per click (ticket); reading totals needs no break-glass (counts only).
- **Export:** `feedback.json` in the member's thread export lists their own ratings in the team
  (with comments), on their threads and on threads shared with them; never another member's.
- **Totals** (`GET /v1/agents/{id}/feedback?from&to&bucket`, same range rules as usage): per
  version up/down/rate, reason counts, by model alias, and a series by `updated_at`. Who: team agent
  → whoever may edit it (builder-owner) or team admins; personal → its owner; gallery → team admins.
  The SQL selects no comment, thread, run, entry or user column (test greps the response).
- **Langfuse:** Langfuse's public scores API (OTLP has no scores) with the exporter's own endpoint and
  headers, on only when `KOBE_OTEL_ENDPOINT` ends in `/api/public/otel`. Score id = the rating's id
  (change → upsert, clear → delete), trace id = `runTraceId(run)`, `BOOLEAN` 1/0, metadata ids and
  reason codes (no rater id), comment only with `captureContent`. After commit, a bounded per-replica
  queue that re-reads the row (order-free, coalescing, failures logged and dropped). Server only.
- **assistant-ui feedback primitives not used:** they submit through a runtime adapter, keep state
  in runtime message metadata (rebuilt from our projection) and can't clear or take reasons. Own
  buttons with `aria-pressed`, commands `rate-up` / `rate-down` (`readOnlySafe`).
- **For KOBE-276:** `answer_feedback.id` is stable while the rating exists. Suggested case table:
  `(team_id, feedback_id) → answer_feedback ON DELETE SET NULL (feedback_id)` (SQL-only, like
  `threads.schedule_id`), with the copied exchange and the member's consent on the case itself; the
  rating's `run_id` / `entry_id` / `reasons` locate and label the exchange. No consent flag here.

## Remaining console work (after G7 merges, on its primitives)

The agent console's quality view; the API is done and tested (`answer-feedback.db.test.ts`):

- A **Quality** (or Ratings) section on the agent's page, shown when `GET /v1/agents/{id}/feedback`
  answers 200 (403 for members and non-owner builders: hide it; 404: no agent).
- Web client: `agentFeedbackTotals(agentId, {from, to, bucket})` → `AgentFeedbackTotals`
  (`@kobe/protocol`), camelized like the usage console's client.
- Content: totals (up, down, rate), a per-version table (version, up, down, rate, top reasons from
  `reasons`), a by-model breakdown per version (`models`, null = "unknown"), a series chart of
  `series` (up/down per bucket) with the usage console's range picker (30 days default, max 400).
- Empty state ("No ratings yet"); never link to threads or members (none are in the answer).

## Open questions (for Chris or the coordinator)

- Readers may rate (above): confirm or switch to owner-only.
- The migration normally lands in its own PR first (ac-2); on the group branch it is its own commits
  (`9e53b109`). Opus DB review of 0108/0109 pending.
- gate1: deploy the group branch, then run `e2e/browser/tests/answer-feedback.spec.ts` and check the
  score on the run's trace in Langfuse (ac-5).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/answer-feedback.db.test.ts` (rate, change, clear, reload, one per run
  and member, readers, other team, Trash), `apps/web/components/chat/answer-feedback.test.tsx`;
  browser spec `e2e/browser/tests/answer-feedback.spec.ts` (gate1, pending).
- ac-2: `packages/db/drizzle/0108_answer_feedback.sql`, `0109_answer_feedback_rls.sql`;
  `packages/db/src/answer-feedback.db.test.ts`; probe fixture `probe-fixtures/conversations.ts`
  (probe and catalog suites green); Opus DB review pending.
- ac-3: API and tests met (`answer-feedback.db.test.ts` "totals", `agents/feedback-routes.test.ts`);
  the console page waits for G7 (above).
- ac-4: Trash purge pass and legal hold, export (`answer-feedback.db.test.ts`); run, thread and team
  cascades and hold guards (`packages/db/src/answer-feedback.db.test.ts`).
- ac-5: `packages/telemetry/src/scores.test.ts`, `services/server/src/feedback/scores.test.ts`,
  `answer-feedback.db.test.ts` "Langfuse scores" and "score export queue"; gate1 check pending.
