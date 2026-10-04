"use client";

import { useState, type FormEvent } from "react";
import {
  getRetentionMaximum,
  putRetentionMaximum,
  type RetentionMaximum,
} from "../../../lib/admin/api/install/retention";
import {
  PERIOD_LABELS,
  RETENTION_PERIODS,
  type RetentionPeriod,
} from "../../../lib/admin/api/team/retention";
import { MutationStatus } from "../error-notice";
import { ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/** The install's retention maximum (spec D6/D18; `/v1/install/retention`, KOBE-18). */
export function RetentionMaximumPage() {
  const { state, reload } = useResource(getRetentionMaximum);
  return (
    <>
      <h1>Retention maximum</h1>
      <p className={styles.hint}>
        The longest any team may keep conversations. Teams choose their own period within it; a team
        that chose longer is capped at this maximum from the next nightly run (its choice is kept,
        so raising the maximum again restores it). Legal holds suspend every deletion.
      </p>
      <ResourceView state={state} label="retention maximum">
        {(current) => <MaximumForm current={current} onSaved={reload} />}
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

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const lowering =
      RETENTION_PERIODS.indexOf(maximum) < RETENTION_PERIODS.indexOf(current.maximum);
    if (
      lowering &&
      !confirmed(
        `Cap every team at ${PERIOD_LABELS[maximum].toLowerCase()}? Older conversations are deleted for good at the next nightly run.`,
      )
    ) {
      return;
    }
    const done = await mutation.run(
      () => putRetentionMaximum(maximum),
      (saved) => `Retention maximum: ${PERIOD_LABELS[saved.maximum].toLowerCase()}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Retention maximum">
      <fieldset>
        <legend>Teams may keep conversations at most</legend>
        {RETENTION_PERIODS.map((p) => (
          <label key={p}>
            <input
              type="radio"
              name="maximum"
              value={p}
              checked={maximum === p}
              onChange={() => setMaximum(p)}
            />{" "}
            {PERIOD_LABELS[p]}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={mutation.pending || maximum === current.maximum}>
        Save
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
