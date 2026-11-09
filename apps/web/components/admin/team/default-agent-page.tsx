"use client";

import type { TeamDefaultAgent } from "@kobe/protocol";
import { useState, type FormEvent } from "react";
import { getTeamDefaultAgent, setTeamDefaultAgent } from "../../../lib/agents/roster-api";
import { Button, Field, Notice, PageHeader, Select } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/** The select's value for "no team default": the site default applies. */
const SITE_DEFAULT = "";

const GROUPS = [
  { id: "team", label: "Team roster" },
  { id: "site", label: "Site roster" },
] as const;

/**
 * The team's default agent for new conversations (KOBE-571, spec agents-roster §7.7): a team admin
 * picks it from the team's roster (Team and Site tabs: published, active here); without one, new
 * conversations start with the site default (the gallery agent Kobe). Audited by the server.
 */
export function TeamDefaultAgentPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamDefaultAgent(teamId));
  return (
    <>
      <PageHeader title="Default agent" />
      <ResourceView state={state} label="the default agent">
        {(current) => <DefaultAgentForm teamId={teamId} current={current} onSaved={reload} />}
      </ResourceView>
    </>
  );
}

function DefaultAgentForm({
  teamId,
  current,
  onSaved,
}: {
  readonly teamId: string;
  readonly current: TeamDefaultAgent;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const saved = current.agentId ?? SITE_DEFAULT;
  const [choice, setChoice] = useState(current.unavailable ? SITE_DEFAULT : saved);
  const nameOf = (id: string) => current.options.find((o) => o.agentId === id)?.name ?? id;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const agentId = choice === SITE_DEFAULT ? null : choice;
    const done = await mutation.run(
      () => setTeamDefaultAgent(teamId, agentId),
      () =>
        agentId === null
          ? "New conversations start with the site default."
          : `New conversations in this team start with ${nameOf(agentId)}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Default agent">
      {current.unavailable && (
        <Notice tone="warn">
          <p>
            The chosen default agent is no longer on the team&apos;s roster or can&apos;t run here,
            so new conversations start with the site default. Choose another one.
          </p>
        </Notice>
      )}
      <Field
        label="New conversations start with"
        hint="Members can still pick any agent they can run. If the default can't run for a member, the site default applies."
      >
        <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value={SITE_DEFAULT}>The site default (Kobe)</option>
          {GROUPS.map((g) => {
            const options = current.options.filter((o) => o.group === g.id);
            if (options.length === 0) return null;
            return (
              <optgroup key={g.id} label={g.label}>
                {options.map((o) => (
                  <option key={o.agentId} value={o.agentId}>
                    {`${o.name} (v${o.versionInEffect})`}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </Select>
      </Field>
      <div className="my-4">
        <Button
          type="submit"
          variant="primary"
          disabled={mutation.pending || (choice === saved && !current.unavailable)}
        >
          Save
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
