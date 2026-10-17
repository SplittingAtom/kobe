"use client";

import { useState, type FormEvent } from "react";
import {
  getTeamWebSearch,
  putTeamWebSearch,
  type TeamWebSearch,
} from "../../../lib/admin/api/team/web-search";
import { Button, Checkbox, Notice, PageHeader } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

const PROVIDER_LABELS: Record<string, string> = { brave: "Brave", tavily: "Tavily", exa: "Exa" };

/**
 * Team opt-in to web search (`/v1/team/web-search`, KOBE-113 API). Off by default. The toggle is
 * shown only while the site offers a provider; otherwise the page says a site admin must
 * set one up.
 */
export function TeamWebSearchPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamWebSearch(teamId));
  return (
    <>
      <PageHeader title="Web search" />
      <ResourceView state={state} label="web search">
        {(setting) =>
          setting.available ? (
            <WebSearchForm teamId={teamId} setting={setting} onSaved={reload} />
          ) : (
            <Notice>
              <p>
                The site admin has not set up a web search provider, so web search is not available
                to teams yet.
              </p>
            </Notice>
          )
        }
      </ResourceView>
    </>
  );
}

function WebSearchForm({
  teamId,
  setting,
  onSaved,
}: {
  readonly teamId: string;
  readonly setting: TeamWebSearch;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [enabled, setEnabled] = useState(setting.enabled);
  const provider = setting.provider
    ? (PROVIDER_LABELS[setting.provider] ?? setting.provider)
    : "the configured provider";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putTeamWebSearch(teamId, enabled),
      (saved) =>
        saved.enabled ? "Web search is on for this team." : "Web search is off for this team.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Web search">
      <Checkbox
        label="Allow web search for this team's agents"
        hint={`When on, the text of agents' search queries is sent to ${provider}, the provider your site admin configured, and leaves this site. Off by default; do not turn it on if queries could contain information that must stay inside.`}
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <div className="my-4">
        <Button
          type="submit"
          variant="primary"
          disabled={mutation.pending || enabled === setting.enabled}
        >
          Save
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
