"use client";

import { useState, type FormEvent } from "react";
import {
  deleteSiteWebSearch,
  getSiteWebSearch,
  putSiteWebSearch,
  type SiteWebSearch,
  type WebSearchProviderId,
} from "../../../lib/admin/api/site/web-search";
import {
  Button,
  Checkbox,
  ChoiceGroup,
  Field,
  Select,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/**
 * Web search provider (`/v1/site/web-search`, KOBE-113): which provider the `web_search` tool
 * uses and its API key. The key is write-only: after saving, only a masked hint is shown.
 */
export function WebSearchSection() {
  const { state, reload } = useResource(getSiteWebSearch);
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
  readonly setting: SiteWebSearch;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
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
      () => putSiteWebSearch({ provider, apiKey: apiKey || undefined, enabled }),
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

  async function onRemove(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: "Remove the web search provider and its key?",
        confirmLabel: "Remove provider",
      },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => deleteSiteWebSearch(),
        () => "Web search provider removed.",
      )
    ) {
      onSaved();
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Web search">
      <ChoiceGroup legend="Web search" stacked className="my-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Search provider">
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value as WebSearchProviderId | "")}
            >
              <option value="">Not set</option>
              {setting.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="API key">
            <TextInput
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={setting.hint ?? ""}
              aria-describedby="web-search-hint"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        </div>
        <Checkbox
          className="mt-2"
          label="Offer web search to teams"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <p id="web-search-hint" className="m-0 mt-1 text-sm text-console-muted">
          {setting.hint
            ? `A key ending ${setting.hint} is stored. Leave the field empty to keep it. `
            : ""}
          The key is stored encrypted and is never shown again.
          {chosen ? ` Turning this on adds ${chosen.domain} to the egress ceiling.` : ""} Each team
          still chooses whether to use it.
        </p>
      </ChoiceGroup>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={mutation.pending || !canSave}>
          Save web search
        </Button>
        {setting.configured && (
          <Button
            variant="danger"
            disabled={mutation.pending}
            onClick={(e) => void onRemove(eventTrigger(e))}
          >
            Remove provider
          </Button>
        )}
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {confirmDialog}
    </form>
  );
}
