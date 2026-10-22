"use client";

/**
 * A text artifact (markdown, code, csv) in the file editor's UI (KOBE-485): Rendered (the file
 * editor's safe renderers) and Raw (CodeMirror, read-only). An artifact is never edited in place;
 * the thread's owner gets Edit as file, which asks the server to copy the shown version into
 * their workspace (`artifacts/<slug>.<ext>`) and opens that file in its own, editable tab. Shared
 * readers get the read-only view only (the server refuses them too).
 */
import { useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { artifactPreview, type ArtifactDetailView } from "../../lib/chat/artifacts";
import { describeFileError } from "../../lib/files/format";
import { ErrorNotice } from "../admin/error-notice";
import { BUTTON, TextModeBody, TextModeToolbar, type TextMode } from "../files/text-modes";
import { useArtifactPanel } from "./artifact-state";
import { useChatSession } from "./kobe-runtime";

type CopyState =
  { readonly status: "idle" | "copying" } | { readonly status: "error"; readonly error: ApiError };

/** Edit as file: the server copies the version, then its file opens in its own tab. */
function useEditAsFile(artifactId: string, version: number) {
  const session = useChatSession();
  const panel = useArtifactPanel();
  const [state, setState] = useState<CopyState>({ status: "idle" });
  const copy = async () => {
    setState({ status: "copying" });
    const res = await session.api.artifactEditAsFile(artifactId, version);
    if (!res.ok) {
      setState({ status: "error", error: describeFileError(res.error) });
      return;
    }
    setState({ status: "idle" });
    panel?.openFile(res.data.path);
  };
  return { state, copy };
}

export function ArtifactTextView({
  artifact,
  version,
  text,
  canEdit,
  mode,
  onMode,
}: {
  readonly artifact: ArtifactDetailView;
  readonly version: number;
  readonly text: string;
  /** The viewer owns the thread: Edit as file is offered. */
  readonly canEdit: boolean;
  /** Rendered or Raw: kept by the tab across versions. */
  readonly mode: TextMode;
  onMode(mode: TextMode): void;
}) {
  const { state, copy } = useEditAsFile(artifact.id, version);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <TextModeToolbar label={`${artifact.title} view`} mode={mode} onMode={onMode}>
        {canEdit && (
          <button
            type="button"
            className={`${BUTTON} ms-auto`}
            disabled={state.status === "copying"}
            title={`Copy version ${version} into your workspace to edit it`}
            onClick={() => void copy()}
          >
            {state.status === "copying" ? "Copying…" : "Edit as file"}
          </button>
        )}
      </TextModeToolbar>
      {state.status === "error" && <ErrorNotice error={state.error} />}
      <TextModeBody
        mode={mode}
        text={text}
        preview={artifactPreview(artifact.kind, artifact.language)}
        label={`${artifact.title} (version ${version}, read-only)`}
        readOnly
      />
    </div>
  );
}
