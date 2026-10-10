"use client";

import { useState, type FormEvent } from "react";
import {
  deleteInstallWebSearch,
  getInstallWebSearch,
  putInstallWebSearch,
  type InstallWebSearch,
  type WebSearchProviderId,
} from "../../../lib/admin/api/install/web-search";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/**
 * Web search provider (`/v1/install/web-search`, KOBE-113): which provider the `web_search` tool
 * uses and its API key. The key is write-only: after saving, only a masked hint is shown.
 */
export function WebSearchSection() {
  const { state, reload } = useResource(getInstallWebSearch);
  return (
    <ResourceView state={state} label="web search">
      {(setting) => (
        <WebSearchForm key={setting.updatedAt ?? "none"} setting={setting} onSaved={reload} />
      )}
    </ResourceView>
  );
}

function WebSearchForm({
  setting,
  onSaved,
}: {
  readonly setting: InstallWebSearch;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [provider, setProvider] = useState<WebSearchProviderId | "">(setting.provider ?? "");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(setting.configured ? setting.enabled : true);
  const chosen = setting.providers.find((p) => p.id === provider);
  // A key is needed for a first provider or a different one; otherwise the stored key is kept.
  const needsKey = provider !== setting.provider;
  const canSave = provider !== "" && (!needsKey || apiKey.length > 0);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (provider === "") return;
    const done = await mutation.run(
      () => putInstallWebSearch({ provider, apiKey: apiKey || undefined, enabled }),
      (saved) =>
        saved.enabled
          ? `Web search is on with ${chosen?.label ?? provider}. Team admins can now turn it on for their teams.`
          : "Web search is saved but off for every team.",
    );
    if (done) {
      setApiKey("");
      onSaved();
    }
  }

  async function onRemove() {
    if (!window.confirm("Remove the web search provider and its key?")) return;
    if (
      await mutation.run(
        () => deleteInstallWebSearch(),
        () => "Web search provider removed.",
      )
    ) {
      onSaved();
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Web search">
      <fieldset>
        <legend>Web search</legend>
        <label>
          Search provider{" "}
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as WebSearchProviderId | "")}
          >
            <option value="">Not set</option>
            {setting.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          API key{" "}
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={setting.hint ?? ""}
            aria-describedby="web-search-hint"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{" "}
          Offer web search to teams
        </label>
        <p id="web-search-hint" className={styles.hint}>
          {setting.hint
            ? `A key ending ${setting.hint} is stored. Leave the field empty to keep it. `
            : ""}
          The key is stored encrypted and is never shown again.
          {chosen ? ` Turning this on adds ${chosen.domain} to the egress ceiling.` : ""} Each team
          still chooses whether to use it.
        </p>
      </fieldset>
      <button type="submit" disabled={mutation.pending || !canSave}>
        Save web search
      </button>
      {setting.configured && (
        <button type="button" disabled={mutation.pending} onClick={onRemove}>
          Remove provider
        </button>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
