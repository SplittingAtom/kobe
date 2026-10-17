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
import { Button, ChoiceGroup, Notice, PageHeader, Radio, useConfirm } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

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
      <PageHeader
        title="Retention"
        description="How long the team keeps conversations after their last activity. Every night, threads past the period are deleted for good with their messages, run history, uploads and artifacts. A shorter period takes effect 7 days after you save it (members see a notice and can export their conversations; you can cancel meanwhile); a longer one at once. Each member's Trash is emptied after 30 days whatever you choose. You can't read or delete members' conversations yourself; data under a legal hold is never deleted."
      />
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
  const [confirm, confirmDialog] = useConfirm();
  const [period, setPeriod] = useState<RetentionPeriod>(
    retention.allowed.includes(retention.period) ? retention.period : retention.effective,
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      RANK[period] < RANK[retention.effective] &&
      !(await confirm({
        title: `Keep conversations for ${periodText(period)} only?`,
        description:
          "In 7 days, older ones start being deleted for good every night. Members are told and can export theirs first.",
        confirmLabel: `Keep for ${periodText(period)}`,
      }))
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
        <Notice tone="warn" role="status">
          <p>
            Conversations older than {periodText(retention.upcoming.period)} will be deleted from{" "}
            <DateTime value={retention.upcoming.effectiveAt} />
            {retention.pending ? "." : " (the site maximum was lowered)."}
          </p>
        </Notice>
      )}
      {retention.pending && (
        <p className="flex flex-wrap items-center gap-2">
          <span>
            Pending change: {PERIOD_LABELS[retention.pending.period]}, from{" "}
            <DateTime value={retention.pending.effectiveAt} />.
          </span>
          <Button size="sm" onClick={() => void cancel()} disabled={mutation.pending}>
            Cancel change
          </Button>
        </p>
      )}
      {retention.effective !== retention.period && !retention.pending && (
        <p className="text-sm text-console-muted">
          The site keeps conversations at most {periodText(retention.maximum)}, so that applies
          instead of the team&apos;s choice ({periodText(retention.period)}).
        </p>
      )}
      <ChoiceGroup
        className="my-4"
        legend="Keep conversations for"
        hint={`Site maximum: ${periodText(retention.maximum)}. In force now: ${periodText(retention.effective)}.`}
      >
        {retention.allowed.map((p) => (
          <Radio
            key={p}
            name="period"
            value={p}
            label={PERIOD_LABELS[p]}
            checked={period === p}
            onChange={() => setPeriod(p)}
          />
        ))}
      </ChoiceGroup>
      <Button
        type="submit"
        variant="primary"
        disabled={mutation.pending || period === retention.period}
      >
        Save
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {confirmDialog}
    </form>
  );
}
