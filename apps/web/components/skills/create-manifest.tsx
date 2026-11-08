"use client";

import { useState } from "react";
import { listTeamModels, modelName } from "../../lib/admin/api/team/models";
import {
  MANIFEST_LICENSES,
  createManifestDraft,
  type ManifestLicense,
  type PromoteSource,
} from "../../lib/skills/promotions-api";
import { MutationStatus } from "../admin/error-notice";
import { useMutation, useResource } from "../admin/use-resource";
import { useNavigate } from "../shell/use-navigate";
import { Button, Select } from "../ui/console";
import { draftHref } from "./draft-href";

/**
 * Create kobe.skill.yaml (KOBE-564): offered by the Promote panel when the Site refuses a version
 * for having no manifest. The member picks the model that writes it (the team default is
 * preselected; only models the team enables are offered) and their license (never the model's
 * choice), Kobe drafts the file and forks the version into a Workbench draft of theirs, and the
 * editor opens on it: review, Save version, run the evals again, then promote the new version.
 */
export function CreateManifest({
  teamId,
  source,
}: {
  readonly teamId: string;
  readonly source: PromoteSource;
}) {
  const models = useResource(() => listTeamModels(teamId)).state;
  const [model, setModel] = useState<string>("");
  const [license, setLicense] = useState<ManifestLicense>("Proprietary");
  const mutation = useMutation();
  const navigate = useNavigate();
  const enabled = models.status === "ready" ? models.data.models.filter((m) => m.enabled) : [];
  const defaultModel = models.status === "ready" ? models.data.default : null;
  const teamDefault = enabled.find((m) => m.alias === defaultModel);
  const defaultName = teamDefault ? modelName(teamDefault) : null;
  const create = () =>
    mutation.run(
      async () => {
        const res = await createManifestDraft(teamId, source, {
          model: model === "" ? undefined : model,
          license,
        });
        if (res.ok) navigate(draftHref(res.data.draft.id));
        return res;
      },
      (made) =>
        made.source === "model"
          ? `kobe.skill.yaml written by ${made.model}. Opening the draft…`
          : `${made.model} gave no usable answer; kobe.skill.yaml starts from the SKILL.md description. Opening the draft…`,
    );
  return (
    <div className="flex flex-col gap-2 text-sm" role="group" aria-label="Create kobe.skill.yaml">
      <p className="m-0">
        Kobe can write kobe.skill.yaml for this version with a model of your choice, into a new
        Workbench draft. Save that draft as the next version and promote it.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span>Model</span>
          <Select
            aria-label="Model for the manifest"
            value={model}
            disabled={models.status !== "ready" || mutation.pending}
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
            disabled={mutation.pending}
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
          disabled={mutation.pending || models.status === "loading" || mutation.notice !== null}
          onClick={() => void create()}
        >
          Create kobe.skill.yaml
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </div>
  );
}
