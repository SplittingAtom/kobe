"use client";

import { useState, type FormEvent } from "react";
import {
  getTeamWebSearch,
  putTeamWebSearch,
  type TeamWebSearch,
} from "../../../lib/admin/api/team/web-search";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

const PROVIDER_LABELS: Record<string, string> = { brave: "Brave", tavily: "Tavily", exa: "Exa" };

/**
 * Team opt-in to web search (`/v1/team/web-search`, KOBE-113 API). Off by default. The toggle is
 * shown only while the install offers a provider; otherwise the page says an install admin must
 * set one up.
 */
export function TeamWebSearchPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamWebSearch(teamId));
  return (
    <>
      <h1>Web search</h1>
      <ResourceView state={state} label="web search">
        {(setting) =>
          setting.available ? (
            <WebSearchForm teamId={teamId} setting={setting} onSaved={reload} />
          ) : (
            <p>
              The install admin has not set up a web search provider, so web search is not available
              to teams yet.
            </p>
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
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{" "}
        Allow web search for this team&apos;s agents
      </label>
      <p className={styles.hint}>
        When on, the text of agents&apos; search queries is sent to {provider}, the provider your
        install admin configured, and leaves this install. Off by default; do not turn it on if
        queries could contain information that must stay inside.
      </p>
      <button type="submit" disabled={mutation.pending || enabled === setting.enabled}>
        Save
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
