"use client";

import { useState } from "react";
import {
  FEEDBACK_DEFAULT_WINDOW_DAYS,
  FEEDBACK_WINDOWS_DAYS,
  getAgentFeedbackTotals,
  type AgentFeedbackTotals,
  type FeedbackWindowDays,
} from "../../../../lib/admin/api/feedback-totals";
import { ErrorNotice } from "../../error-notice";
import { useResource } from "../../use-resource";
import { Field, Notice, Section, Select } from "../../../ui/console";
import {
  DaysTable,
  ModelsTable,
  NOT_ENOUGH_TO_BREAK_DOWN,
  rateLabel,
  VersionsTable,
} from "./quality-tables";
import { RatingsChart } from "./ratings-chart";

export const QUALITY_HEADING = "quality-heading";

/** Who isn't shown the totals (members, other builders) or a gone agent: no section at all. */
const HIDDEN = new Set([403, 404]);

/**
 * The agent's answer ratings (KOBE-275), for whoever the server lets read them (the agent's
 * owners and, for team agents, team admins): thumbs up and down per published version, model and
 * reason, and per day, over a fixed window of finished UTC days. Counts only: the answer holds no
 * member, comment or conversation, so nothing here links to one. Every number stands on enough
 * other raters; below that the page says so instead of showing a number.
 */
export function AgentQuality({
  teamId,
  agentId,
}: {
  readonly teamId: string;
  readonly agentId: string;
}) {
  const [windowDays, setWindowDays] = useState<FeedbackWindowDays>(FEEDBACK_DEFAULT_WINDOW_DAYS);
  const { state, reload } = useResource(() => getAgentFeedbackTotals(teamId, agentId, windowDays));
  // Nothing until the server answers (a reload keeps the last answer on screen), and nothing for
  // those it refuses.
  if (state.status === "loading") return null;
  if (state.status === "error" && HIDDEN.has(state.error.status)) return null;
  return (
    <Section
      id={QUALITY_HEADING}
      title="Ratings"
      description="Members' thumbs up and down on this agent's answers in this team, as counts only: never who rated or what they wrote. Days are UTC and end at the start of today, so today's ratings count tomorrow."
    >
      <Field label="Period" className="mb-3 max-w-56">
        <Select
          value={String(windowDays)}
          onChange={(e) => {
            setWindowDays(Number(e.target.value) as FeedbackWindowDays);
            reload();
          }}
        >
          {FEEDBACK_WINDOWS_DAYS.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </Select>
      </Field>
      {state.status === "error" && <ErrorNotice error={state.error} />}
      {state.status === "ready" && <QualityBody totals={state.data} />}
    </Section>
  );
}

function QualityBody({ totals }: { readonly totals: AgentFeedbackTotals }) {
  const { totals: t, minRaters } = totals;
  if (!t.enough) {
    return (
      <Notice tone="info" role="status">
        <p>
          Not enough ratings yet. Numbers show once at least {minRaters} members other than you have
          rated this agent&apos;s answers in this period.
        </p>
      </Notice>
    );
  }
  return (
    <>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 [&_dd]:m-0 [&_dd]:tabular-nums [&_dt]:font-medium">
        <dt>Thumbs up</dt>
        <dd>{t.up}</dd>
        <dt>Thumbs down</dt>
        <dd>{t.down}</dd>
        <dt>Positive</dt>
        <dd>{rateLabel(t.rate)}</dd>
      </dl>
      <h3 className="m-0 mt-4 mb-2 text-lg font-semibold">By version and model</h3>
      {totals.versions === null ? (
        <p className="m-0 text-sm text-console-muted">{NOT_ENOUGH_TO_BREAK_DOWN} by version.</p>
      ) : (
        <>
          <VersionsTable versions={totals.versions} />
          <ModelsTable versions={totals.versions} />
        </>
      )}
      <h3 className="m-0 mt-4 mb-2 text-lg font-semibold">By day</h3>
      {totals.series === null ? (
        <p className="m-0 text-sm text-console-muted">{NOT_ENOUGH_TO_BREAK_DOWN} by day.</p>
      ) : (
        <>
          <RatingsChart days={totals.series} />
          <DaysTable series={totals.series} />
        </>
      )}
    </>
  );
}
