"use client";

import { useState } from "react";
import { listTeamModels, modelName } from "../../lib/admin/api/team/models";
import {
  MANIFEST_LICENSES,
  manifestWrittenNotice,
  type ManifestDraftChoice,
  type ManifestLicense,
} from "../../lib/skills/manifest-choice";
import { createManifestDraft, type PromoteSource } from "../../lib/skills/promotions-api";
import { MutationStatus } from "../admin/error-notice";
import { useMutation, useResource } from "../admin/use-resource";
import { useNavigate } from "../shell/use-navigate";
import { Button, Select } from "../ui/console";
import { draftHref } from "./draft-href";

/**
 * The choice behind Create kobe.skill.yaml (KOBE-564): the model that writes it (the team
 * default preselected; only models the team enables are offered) and the author's license (never
 * the model's). `onCreate` runs the call; the caller shows its outcome.
 */
export function ManifestChoiceForm({
  teamId,
  intro,
  pending,
  done,
  onCreate,
}: {
  readonly teamId: string;
  readonly intro: string;
  readonly pending: boolean;
  /** The file was made: the controls stay but the button is spent. */
  readonly done: boolean;
  readonly onCreate: (choice: ManifestDraftChoice) => void;
}) {
  const models = useResource(() => listTeamModels(teamId)).state;
  const [model, setModel] = useState<string>("");
  const [license, setLicense] = useState<ManifestLicense>("Proprietary");
  const enabled = models.status === "ready" ? models.data.models.filter((m) => m.enabled) : [];
  const defaultModel = models.status === "ready" ? models.data.default : null;
  const teamDefault = enabled.find((m) => m.alias === defaultModel);
  const defaultName = teamDefault ? modelName(teamDefault) : null;
  return (
    <div className="flex flex-col gap-2 text-sm" role="group" aria-label="Create kobe.skill.yaml">
      <p className="m-0">{intro}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span>Model</span>
          <Select
            aria-label="Model for the manifest"
            value={model}
            disabled={models.status !== "ready" || pending}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">
              {defaultName ? `Team default (${defaultName})` : "Team default"}
            </option>
            {enabled
              .filter((m) => m.alias !== defaultModel)
              .map((m) => (
                <option key={m.alias} value={m.alias}>
                  {modelName(m)}
                </option>
              ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span>License</span>
          <Select
            aria-label="License"
            value={license}
            disabled={pending}
            onChange={(e) => setLicense(e.target.value as ManifestLicense)}
          >
            {MANIFEST_LICENSES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <Button
          size="sm"
          disabled={pending || done || models.status === "loading"}
          onClick={() => onCreate({ model: model === "" ? undefined : model, license })}
        >
          Create kobe.skill.yaml
        </Button>
      </div>
    </div>
  );
}

/**
 * Create kobe.skill.yaml from the Promote panel (KOBE-564): offered when the Site refuses a
 * version for having no manifest. Kobe drafts the file with the chosen model and forks the
 * version into a Workbench draft of the member's; the editor opens on it: review, Save version,
 * run the evals again, then promote the new version.
 */
export function CreateManifest({
  teamId,
  source,
}: {
  readonly teamId: string;
  readonly source: PromoteSource;
}) {
  const mutation = useMutation();
  const navigate = useNavigate();
  const create = (choice: ManifestDraftChoice) =>
    mutation.run(
      async () => {
        const res = await createManifestDraft(teamId, source, choice);
        if (res.ok) navigate(draftHref(res.data.draft.id));
        return res;
      },
      (made) => `${manifestWrittenNotice(made)} Opening the draft…`,
    );
  return (
    <div className="flex flex-col gap-2">
      <ManifestChoiceForm
        teamId={teamId}
        intro="Kobe can write kobe.skill.yaml for this version with a model of your choice, into a new Workbench draft. Save that draft as the next version and promote it."
        pending={mutation.pending}
        done={mutation.notice !== null}
        onCreate={(choice) => void create(choice)}
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </div>
  );
}
