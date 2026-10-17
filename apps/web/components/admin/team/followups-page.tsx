"use client";

import { useState, type FormEvent } from "react";
import {
  getTeamSettings,
  putTeamSettings,
  type TeamChatSettings,
} from "../../../lib/admin/api/team/settings";
import { Button, Checkbox, PageHeader } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/**
 * The team's follow-up suggestions switch (`/v1/team/settings`, KOBE-222, CE21). Off by default.
 * When on, the server asks the thread's model for three follow-ups after each completed run a
 * member started, charged to that member as `followups` usage and skipped once any of their
 * budgets is at 80 %.
 */
export function TeamFollowupsPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamSettings(teamId));
  return (
    <>
      <PageHeader title="Follow-ups" />
      <ResourceView state={state} label="follow-up settings">
        {(settings) => <FollowupsForm teamId={teamId} settings={settings} onSaved={reload} />}
      </ResourceView>
    </>
  );
}

function FollowupsForm({
  teamId,
  settings,
  onSaved,
}: {
  readonly teamId: string;
  readonly settings: TeamChatSettings;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [enabled, setEnabled] = useState(settings.followupsEnabled);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putTeamSettings(teamId, { followupsEnabled: enabled }),
      (saved) =>
        saved.followupsEnabled
          ? "Follow-up suggestions are on for this team."
          : "Follow-up suggestions are off for this team.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Follow-ups">
      <Checkbox
        label="Suggest follow-up messages after each answer"
        hint="After each answer the conversation's model is asked for three short follow-ups, shown above the message box until the next message. Each one is a small model call charged to the member as follow-ups usage; it is skipped once any of their budgets is at 80 %, and never for scheduled runs. Off by default."
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <div className="my-4">
        <Button
          type="submit"
          variant="primary"
          disabled={mutation.pending || enabled === settings.followupsEnabled}
        >
          Save
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
