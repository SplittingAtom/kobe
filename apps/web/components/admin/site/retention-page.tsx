"use client";

import { useState, type FormEvent } from "react";
import {
  cancelRetentionMaximumChange,
  getRetentionMaximum,
  putRetentionMaximum,
  type RetentionMaximum,
} from "../../../lib/admin/api/site/retention";
import {
  PERIOD_LABELS,
  RETENTION_PERIODS,
  type RetentionPeriod,
} from "../../../lib/admin/api/team/retention";
import {
  Button,
  ChoiceGroup,
  Notice,
  PageHeader,
  Radio,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/** The site's retention maximum (spec D6/D18; `/v1/site/retention`, KOBE-18). */
export function RetentionMaximumPage() {
  const { state, reload } = useResource(getRetentionMaximum);
  return (
    <>
      <PageHeader
        title="Retention maximum"
        description="The longest any team may keep conversations. Teams choose their own period within it; a team that chose longer is capped at this maximum from the next nightly run (its choice is kept, so raising the maximum again restores it). Legal holds suspend every deletion."
      />
      <ResourceView state={state} label="retention maximum">
        {(current) => (
          <>
            {current.paused && (
              <Notice tone="warn" role="alert">
                <p>
                  Retention is paused (KOBE_RETENTION_PAUSED): no nightly deletion, offboarding
                  purge or workspace cleanup runs. Resume it with the chart value
                  retention.paused=false once the bucket is reconciled after a restore.
                </p>
              </Notice>
            )}
            <MaximumForm current={current} onSaved={reload} />
          </>
        )}
      </ResourceView>
    </>
  );
}

function MaximumForm({
  current,
  onSaved,
}: {
  readonly current: RetentionMaximum;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [maximum, setMaximum] = useState<RetentionPeriod>(current.maximum);
  const [confirm, confirmDialog] = useConfirm();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trigger = eventTrigger(e);
    const lowering =
      RETENTION_PERIODS.indexOf(maximum) < RETENTION_PERIODS.indexOf(current.applied);
    if (
      lowering &&
      !(await confirm(
        {
          title: `Cap every team at ${PERIOD_LABELS[maximum].toLowerCase()}?`,
          description: "In 7 days, older conversations start being deleted for good every night.",
          confirmLabel: `Cap at ${PERIOD_LABELS[maximum].toLowerCase()}`,
        },
        trigger,
      ))
    ) {
      return;
    }
    const done = await mutation.run(
      () => putRetentionMaximum(maximum),
      (saved) =>
        saved.pending
          ? `Scheduled: from ${new Date(saved.pending.effectiveAt).toUTCString()}, the maximum is ${PERIOD_LABELS[saved.pending.maximum].toLowerCase()}. You can cancel until then.`
          : `Retention maximum: ${PERIOD_LABELS[saved.maximum].toLowerCase()}.`,
    );
    if (done) onSaved();
  }

  async function cancel() {
    const done = await mutation.run(
      () => cancelRetentionMaximumChange(),
      (kept) => `Cancelled: the maximum stays ${PERIOD_LABELS[kept.maximum].toLowerCase()}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Retention maximum">
      {current.pending && (
        <Notice tone="warn" role="status">
          <p className="flex flex-wrap items-center gap-2">
            <span>
              Pending change: {PERIOD_LABELS[current.pending.maximum]}, from{" "}
              <DateTime value={current.pending.effectiveAt} /> (in force until then:{" "}
              {PERIOD_LABELS[current.applied].toLowerCase()}).
            </span>
            <Button size="sm" onClick={() => void cancel()} disabled={mutation.pending}>
              Cancel change
            </Button>
          </p>
        </Notice>
      )}
      <ChoiceGroup className="my-4" legend="Teams may keep conversations at most">
        {RETENTION_PERIODS.map((p) => (
          <Radio
            key={p}
            name="maximum"
            value={p}
            label={PERIOD_LABELS[p]}
            checked={maximum === p}
            onChange={() => setMaximum(p)}
          />
        ))}
      </ChoiceGroup>
      <Button
        type="submit"
        variant="primary"
        disabled={mutation.pending || maximum === current.maximum}
      >
        Save
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {confirmDialog}
    </form>
  );
}
