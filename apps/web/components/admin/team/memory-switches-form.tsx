"use client";

import { useState, type FormEvent } from "react";
import type { MemorySwitches } from "../../../lib/admin/api/team/memory";
import type { ApiResult } from "../../../lib/api/client";
import { Button, Checkbox, ChoiceGroup } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { useMutation } from "../use-resource";

/** The two memory switches of one level (team or site) with one Save. */
export function MemorySwitchesForm({
  where,
  switches,
  save,
  onSaved,
  saveLabel = "Save",
  legend = "Memory",
}: {
  /** "for this team" / "on this site", for the labels and messages. */
  readonly where: string;
  readonly switches: MemorySwitches;
  readonly save: (change: MemorySwitches) => Promise<ApiResult<MemorySwitches>>;
  readonly onSaved: () => void;
  readonly saveLabel?: string;
  readonly legend?: string;
}) {
  const mutation = useMutation();
  const [all, setAll] = useState(switches.memoryEnabled);
  const [project, setProject] = useState(switches.projectMemoryEnabled);
  const dirty = all !== switches.memoryEnabled || project !== switches.projectMemoryEnabled;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => save({ memoryEnabled: all, projectMemoryEnabled: project }),
      (saved) =>
        !saved.memoryEnabled
          ? `Memory is off ${where}. Agents get no remember or recall tools and no memory index.`
          : !saved.projectMemoryEnabled
            ? `Project memory is off ${where}. Personal memory is on.`
            : `Memory is on ${where}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label={legend}>
      <ChoiceGroup legend={legend} stacked className="my-4">
        <Checkbox
          label={`Allow memory ${where}`}
          hint="Agents can remember notes about a person and recall them in later chats. Off removes the tools and the memory index from the next runs; stored files are kept."
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        <Checkbox
          className="mt-2"
          label={`Allow project memory ${where}`}
          hint="Project memory is shared with the project's members, so an agent's write to it needs a member's approval. It needs memory to be on."
          checked={project}
          disabled={!all}
          onChange={(e) => setProject(e.target.checked)}
        />
      </ChoiceGroup>
      <Button type="submit" variant="primary" disabled={mutation.pending || !dirty}>
        {saveLabel}
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
