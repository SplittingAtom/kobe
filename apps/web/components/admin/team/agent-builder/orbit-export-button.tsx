"use client";

import { exportTeamAgentToOrbit } from "../../../../lib/admin/api/team/agent-builder";
import { ErrorNotice } from "../../error-notice";
import { useMutation } from "../../use-resource";

/** Hands `text` to the browser as a file download. */
function saveAsFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * "Export to Orbit" for one published version: fetches the YAML and downloads it. A refusal (for
 * example a model the team hasn't enabled) shows the server's reason instead of saving a file.
 */
export function OrbitExportButton({
  teamId,
  agentId,
  agentSlug,
  version,
  label = "Export to Orbit",
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly version: number;
  readonly label?: string;
}) {
  const mutation = useMutation();
  return (
    <>
      <button
        type="button"
        disabled={mutation.pending}
        onClick={() =>
          void mutation.run(async () => {
            const res = await exportTeamAgentToOrbit(teamId, agentId, version);
            if (res.ok) {
              saveAsFile(res.data.text, res.data.filename ?? `${agentSlug}-v${version}.orbit.yaml`);
            }
            return res;
          })
        }
      >
        {label}
      </button>
      {mutation.error && <ErrorNotice error={mutation.error} />}
    </>
  );
}
