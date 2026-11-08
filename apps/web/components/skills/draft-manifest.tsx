"use client";

import { useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { manifestWrittenNotice, type ManifestDraftChoice } from "../../lib/skills/manifest-choice";
import { ErrorNotice } from "../admin/error-notice";
import { Notice } from "../ui/console";
import { ManifestChoiceForm } from "./create-manifest";
import { MANIFEST, type DraftEditor } from "./use-draft-editor";

/**
 * Create kobe.skill.yaml in the Workbench editor (KOBE-564): under the file tree while the draft
 * has none. The chosen model drafts it from the draft's SKILL.md and files, it is written at the
 * revision the author sees (pending edits first, like any change), and the tree opens on it. Its
 * version is a placeholder that Save version writes.
 */
export function DraftManifest({
  teamId,
  editor,
  onCreated,
}: {
  readonly teamId: string;
  readonly editor: DraftEditor;
  /** The file is in the tree: open it. */
  readonly onCreated: (path: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const create = editor.createManifest;
  const has = editor.files.some((f) => f.path === MANIFEST);
  if (!create || (has && notice === null)) return null;
  // Made just now: the offer is spent, the notice stays until the author moves on.
  if (has)
    return (
      <div className="mt-3">
        <Notice tone="success">
          <p>{notice}</p>
        </Notice>
      </div>
    );
  const run = async (choice: ManifestDraftChoice) => {
    setPending(true);
    setError(null);
    const made = await create(choice);
    setPending(false);
    if (!made.ok) {
      setError(made.error);
      return;
    }
    setNotice(manifestWrittenNotice(made));
    onCreated(MANIFEST);
  };
  return (
    <div className="mt-3 flex flex-col gap-2">
      <ManifestChoiceForm
        teamId={teamId}
        intro="No kobe.skill.yaml yet: Kobe can write one from SKILL.md and the files with a model of your choice. Promotion to the Site needs it."
        pending={pending}
        done={notice !== null}
        onCreate={(choice) => void run(choice)}
      />
      {error && <ErrorNotice error={error} />}
    </div>
  );
}
