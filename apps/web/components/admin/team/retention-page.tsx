"use client";

import { useState, type FormEvent } from "react";
import {
  PERIOD_LABELS,
  cancelTeamRetentionChange,
  getTeamRetention,
  periodText,
  putTeamRetention,
  type RetentionPeriod,
  type TeamRetention,
} from "../../../lib/admin/api/team/retention";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/** Order of the periods, for "is this shorter than what applies now". */
const RANK: Readonly<Record<RetentionPeriod, number>> = { "30d": 0, "90d": 1, "1y": 2, forever: 3 };

/**
 * Team retention period (spec D18; `/v1/team/retention`, KOBE-18). A shorter period applies after
 * a 7-day grace period, cancellable here; a longer one at once (user decision 2026-10-04).
 */
export function TeamRetentionPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamRetention(teamId));
  return (
    <>
      <h1>Retention</h1>
      <p className={styles.hint}>
        How long the team keeps conversations after their last activity. Every night, threads past
        the period are deleted for good with their messages, run history, uploads and artifacts. A
        shorter period takes effect 7 days after you save it (members see a notice and can export
        their conversations; you can cancel meanwhile); a longer one at once. Each member&apos;s
        Trash is emptied after 30 days whatever you choose. You can&apos;t read or delete
        members&apos; conversations yourself; data under a legal hold is never deleted.
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
        `Keep conversations for ${periodText(period)} only? In 7 days, older ones start being deleted for good every night. Members are told and can export theirs first.`,
      )
    ) {
      return;
    }
    const done = await mutation.run(
      () => putTeamRetention(teamId, period),
      (saved) =>
        saved.pending
          ? `Scheduled: from ${new Date(saved.pending.effectiveAt).toUTCString()}, the team keeps conversations for ${periodText(saved.pending.period)}. You can cancel until then.`
          : saved.effective === "forever"
            ? "The team keeps conversations forever."
            : `The team keeps conversations for ${periodText(saved.effective)} after their last activity.`,
    );
    if (done) onSaved();
  }

  async function cancel() {
    const done = await mutation.run(
      () => cancelTeamRetentionChange(teamId),
      (kept) =>
        kept.period === "forever"
          ? "Cancelled: the team keeps conversations forever."
          : `Cancelled: the team keeps conversations for ${periodText(kept.period)}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Retention period">
      {retention.upcoming && (
        <p className={styles.banner} role="status">
          Conversations older than {periodText(retention.upcoming.period)} will be deleted from{" "}
          <DateTime value={retention.upcoming.effectiveAt} />
          {retention.pending ? "." : " (the install maximum was lowered)."}
        </p>
      )}
      {retention.pending && (
        <p>
          Pending change: {PERIOD_LABELS[retention.pending.period]}, from{" "}
          <DateTime value={retention.pending.effectiveAt} />.{" "}
          <button type="button" onClick={() => void cancel()} disabled={mutation.pending}>
            Cancel change
          </button>
        </p>
      )}
      {retention.effective !== retention.period && !retention.pending && (
        <p className={styles.hint}>
          The install keeps conversations at most {periodText(retention.maximum)}, so that applies
          instead of the team&apos;s choice ({periodText(retention.period)}).
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
          Install maximum: {periodText(retention.maximum)}. In force now:{" "}
          {periodText(retention.effective)}.
        </p>
      </fieldset>
      <button type="submit" disabled={mutation.pending || period === retention.period}>
        Save
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
