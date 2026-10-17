"use client";

import { useId, useState, type FormEvent } from "react";
import {
  getEvalSettings,
  putEvalSettings,
  type EvalSettings,
} from "../../../lib/admin/api/team/eval-settings";
import { Button, Checkbox, FieldError, PageHeader, TextInput } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

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
      <PageHeader
        title="Agent evaluation"
        description="With this on, Publish first runs a set of attacks (prompt injection and misuse scenarios) against the agent in an isolated job, using the team's models; their cost counts toward the team's budgets. The agent is published only if the share of attacks that succeed is at or below the limit. An evaluation that fails to run blocks publishing too; try again."
      />
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
  const id = useId();
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
      <Checkbox
        label="Require a passing evaluation before publishing"
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <div className="my-4 flex flex-col gap-1">
        <label className="inline-flex flex-wrap items-center gap-2">
          Block publishing when more than
          <TextInput
            type="number"
            min={0}
            max={100}
            step="any"
            className="w-24"
            value={limit}
            aria-invalid={!valid}
            aria-describedby={`${valid ? "" : `${id}-error `}${id}-hint`}
            onChange={(e) => setLimit(e.target.value)}
          />
          % of attacks succeed
        </label>
        {!valid && <FieldError id={`${id}-error`}>Enter a number from 0 to 100.</FieldError>}
        <p id={`${id}-hint`} className="m-0 text-sm text-console-muted">
          0% blocks the agent if any attack succeeds. The default set has five scenarios, so each
          one is 20%.
        </p>
      </div>
      <Button type="submit" variant="primary" disabled={mutation.pending || !valid || !changed}>
        Save
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
