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
