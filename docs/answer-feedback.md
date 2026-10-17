# Answer feedback

Members rate an agent's answers with thumbs up or down (KOBE-275). Kobe can't retrain models, so
ratings are a quality signal for agent builders and, with tracing, a way to line a bad answer up
with what the agent did.

## Rating

- Every answer (an ended run) in a conversation the member can read can be rated, by its owner and
  by readers of a project- or team-shared conversation. Each member rates for themselves; nobody
  sees another member's rating, the conversation's owner included.
- A thumbs down can carry reasons (wrong, didn't follow instructions, unsafe, too slow, other) and
  a comment of up to 500 characters, shown to its author only.
- Click the pressed thumb to clear a rating. Ratings are not audited per click.
- Ratings are conversation content: they go with the conversation (Trash purge, retention, team
  delete), appear in the member's own export (`feedback.json`) and are readable by an install admin
  only under break-glass.
- Under a legal hold a member changes or clears a rating as usual; Kobe keeps the old values aside
  for the hold and purges them in the retention pass once the hold is released.

## Totals for agent owners

`GET /v1/agents/{id}/feedback?window=7|30|90` gives an agent's owners (and the team's admins) the
ratings in the active team per published version, model, reason and day, as counts only: never a
comment, a conversation or a member. To keep counts from pointing at one person:

- only preset windows: the last 7, 30 (default) or 90 finished UTC days, ending at the start of
  today (today's ratings count tomorrow); no custom ranges;
- a number is shown only when at least 5 members other than the viewer rated (`min_raters`);
  below that the totals say "not enough ratings yet";
- a breakdown (versions, a version's models or reasons, the days) is shown only when every one of
  its cells reaches that minimum, so a hidden cell can't be worked out as the total minus the rest.

**Residual risk (accepted):** comparing nested windows (7 vs 30 days), or the same window on
different days, can still narrow down who rated what over time. Exact counts can't fully prevent
that; the minimum of 5 raters plus fixed windows is the accepted trade-off.

## Tracing

With a Langfuse tracing backend, each rating is also a score on the run's trace (ids and reason
codes; the comment only with `telemetry.captureContent`): see [tracing.md](tracing.md).

## Sharing a thumbs down as an eval case

A rating only improves an agent if its next version is tested against it (KOBE-276). On a thumbs
down in your own conversation, **Share as an eval case…** opens a preview of exactly what the
agent's owner gets:

- the prompt, the answer, your reasons and comment; earlier exchanges (up to two), this answer's
  tool outputs (up to four) and the names of files you attached are added only when you tick
  them, never the files themselves. Long text is cut (6,000 characters for the prompt and the
  answer, 1,500 for an earlier turn or a tool output), and the preview says so;
- nothing is shared until **Share**: the server stores the copy only if it is still exactly what
  the preview showed (its digest), so a rating edited in between asks you to look again;
- the case is a copy owned by the agent: it keeps no link into the conversation and outlives it;
  only the conversation's owner shares its exchanges (a reader of a shared conversation can't),
  and only their own words: earlier exchanges come only from prompts sent in this conversation,
  so a fork of someone else's conversation adds none of theirs; gallery agents take no cases.

The agent's owner (a team agent's builder-owner while they may still build, a personal agent's
owner; not team admins who don't own it) lists the cases with the day they were shared, never who
shared them, and accepts (with an expected behaviour or rubric of up to 2,000 characters),
dismisses or reopens each. A case shows up for the owner only once the UTC day it was shared has
ended, ordered by day and then at random, so watching the list doesn't tell when a case came in.
**Residual (accepted):** in a small team the day, the agent version and what the text says can
still point to one member; the preview warns that the text may identify you.
Install admins read cases only under break-glass (a team grant, or a user grant for that member's
cases). Sharing and withdrawing are not audited (the audit log would name you to team admins); the
owner's reviews are, by id and status.

**Withdraw** deletes the copy. Clearing your rating doesn't withdraw it: `GET /v1/eval-cases`
lists your cases whether or not the rating still exists, and `DELETE /v1/eval-cases/{id}`
withdraws one (the settings page follows). Cases are in your export (`eval-cases.json`), are
purged once older than the team's retention period, go with a departed member's data at
offboarding (unaudited on their own, so the audit log never names a sharer) and with the team.
Under a legal hold a withdrawal answers as usual while Kobe keeps the copy aside for the hold; the
retention pass purges it after the release. A case a hold keeps past the retention period, or
past its sharer's membership, is shown to nobody and runs in no eval, exactly as if purged.

### How accepted cases count in the pre-publish gate

With the team's Orbit gate on (KOBE-93), every gated publish of the agent freezes its accepted
cases (at most 20) into the eval and runs them in the same Job, next to the scenario pack, with no
credential beyond the eval's own gateway token. Case text is in no Kubernetes object: the Job
fetches it from the model gateway with that token (`GET /kobe/eval-cases`), which reads it from
Postgres only while the eval runs, for the member who started it; it lives in the pod's memory
and a temporary log directory deleted when the run ends. A case withdrawn or dismissed mid-eval
is not served, and the eval errors (publish again). Cases on a team agent whose owner left or may
no longer build are left out of the gate (nobody could dismiss them); they run again once the
agent has such an owner. Each case replays the prompt (and earlier turns)
against the new version, with simulated tools that return the shared tool outputs; the eval's
model then grades the new answer against the expected behaviour (pass or fail).

- The pack's attack success rate and the cases' **failure rate** (failed ÷ graded) are each held
  to the team's threshold; either above it blocks the publish. With a threshold of 0 any failed
  case blocks; with three cases each one is worth a third.
- The grader gets one retry when its reply has no verdict line.
- A case that can't be graded, or a result that doesn't cover exactly the frozen cases, errors the
  eval (fail closed: nothing is published; publish again to retry).
- The eval's report and the builder's view hold case ids and outcomes only, never case text.
- Known limits: the grader is the agent's own model (the eval token allows no other); tools are
  simulated, so a case tests the answer, not the tool calls; a rollback to a version that already
  passed under the current threshold is not re-run against newer cases. With tracing content
  capture on (`telemetry.captureContent`), the eval's model calls, case text and grader prompts
  included, reach the tracing backend like any model call.
