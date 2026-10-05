"use client";

import { useState, type FormEvent } from "react";
import {
  getEvalSettings,
  putEvalSettings,
  type EvalSettings,
} from "../../../lib/admin/api/team/eval-settings";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;

/**
 * The pre-publish eval gate (`/v1/team/eval-settings`, KOBE-93): off by default. When on,
 * publishing a team agent (or a member's personal agent used in this team) runs an Orbit safety
 * eval first and is blocked when the attack success rate is above the limit set here.
 */
export function EvalSettingsPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getEvalSettings(teamId));
  return (
    <>
      <h1>Agent evaluation</h1>
      <p className={styles.hint}>
        With this on, Publish first runs a set of attacks (prompt injection and misuse scenarios)
        against the agent in an isolated job, using the team&apos;s models; their cost counts toward
        the team&apos;s budgets. The agent is published only if the share of attacks that succeed is
        at or below the limit. An evaluation that fails to run blocks publishing too; try again.
      </p>
      <ResourceView state={state} label="evaluation settings">
        {(settings) => <SettingsForm teamId={teamId} settings={settings} onSaved={reload} />}
      </ResourceView>
    </>
  );
}

function SettingsForm({
  teamId,
  settings,
  onSaved,
}: {
  readonly teamId: string;
  readonly settings: EvalSettings;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [limit, setLimit] = useState(String(Math.round(settings.maxAttackSuccessRate * 1000) / 10));
  const parsed = Number(limit);
  const valid = limit.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
  const changed =
    enabled !== settings.enabled ||
    (valid && Math.abs(parsed / 100 - settings.maxAttackSuccessRate) > 1e-9);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) return;
    const done = await mutation.run(
      () => putEvalSettings(teamId, { enabled, maxAttackSuccessRate: parsed / 100 }),
      (saved) =>
        saved.enabled
          ? `Publishing now runs an evaluation first and is blocked above ${percent(saved.maxAttackSuccessRate)}.`
          : "Publishing no longer runs an evaluation.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Agent evaluation settings" noValidate>
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{" "}
        Require a passing evaluation before publishing
      </label>
      <p>
        <label>
          Block publishing when more than{" "}
          <input
            type="number"
            min={0}
            max={100}
            step="any"
            value={limit}
            aria-invalid={!valid}
            onChange={(e) => setLimit(e.target.value)}
          />{" "}
          % of attacks succeed
        </label>
      </p>
      {!valid && <p className={styles.hint}>Enter a number from 0 to 100.</p>}
      <p className={styles.hint}>
        0% blocks the agent if any attack succeeds. The default set has five scenarios, so each one
        is 20%.
      </p>
      <button type="submit" disabled={mutation.pending || !valid || !changed}>
        Save
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
