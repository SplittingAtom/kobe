"use client";

import { useState, type FormEvent } from "react";
import {
  PERIOD_LABELS,
  getTeamRetention,
  putTeamRetention,
  type RetentionPeriod,
  type TeamRetention,
} from "../../../lib/admin/api/team/retention";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/** Order of the periods, for "is this shorter than what applies now". */
const RANK: Readonly<Record<RetentionPeriod, number>> = { "30d": 0, "90d": 1, "1y": 2, forever: 3 };

/** Team retention period (spec D18; `/v1/team/retention`, KOBE-18). */
export function TeamRetentionPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamRetention(teamId));
  return (
    <>
      <h1>Retention</h1>
      <p className={styles.hint}>
        How long the team keeps conversations after their last activity. Every night, threads past
        the period are deleted for good with their messages, run history, uploads and artifacts.
        Each member&apos;s Trash is emptied after 30 days whatever you choose. You can&apos;t read
        or delete members&apos; conversations yourself; data under a legal hold is never deleted.
      </p>
      <ResourceView state={state} label="retention">
        {(retention) => <RetentionForm teamId={teamId} retention={retention} onSaved={reload} />}
      </ResourceView>
    </>
  );
}

function RetentionForm({
  teamId,
  retention,
  onSaved,
}: {
  readonly teamId: string;
  readonly retention: TeamRetention;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [period, setPeriod] = useState<RetentionPeriod>(
    retention.allowed.includes(retention.period) ? retention.period : retention.effective,
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      RANK[period] < RANK[retention.effective] &&
      !confirmed(
        `Keep conversations for ${PERIOD_LABELS[period].toLowerCase()} only? Older ones are deleted for good at the next nightly run.`,
      )
    ) {
      return;
    }
    const done = await mutation.run(
      () => putTeamRetention(teamId, period),
      (saved) =>
        saved.effective === "forever"
          ? "The team keeps conversations forever."
          : `The team keeps conversations for ${PERIOD_LABELS[saved.effective].toLowerCase()} after their last activity.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Retention period">
      {retention.effective !== retention.period && (
        <p className={styles.banner} role="status">
          The install keeps conversations at most {PERIOD_LABELS[retention.maximum].toLowerCase()},
          so that applies instead of the team&apos;s choice (
          {PERIOD_LABELS[retention.period].toLowerCase()}).
        </p>
      )}
      <fieldset>
        <legend>Keep conversations for</legend>
        {retention.allowed.map((p) => (
          <label key={p}>
            <input
              type="radio"
              name="period"
              value={p}
              checked={period === p}
              onChange={() => setPeriod(p)}
            />{" "}
            {PERIOD_LABELS[p]}
          </label>
        ))}
        <p className={styles.hint}>
          Install maximum: {PERIOD_LABELS[retention.maximum].toLowerCase()}. Currently applied:{" "}
          {PERIOD_LABELS[retention.effective].toLowerCase()}.
        </p>
      </fieldset>
      <button type="submit" disabled={mutation.pending || period === retention.period}>
        Save
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
