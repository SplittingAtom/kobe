"use client";

import { AGENT_FORK_NAME_MAX, type AgentRosterRow } from "@kobe/protocol";
import { useState } from "react";
import { forkAgent } from "../../lib/agents/roster-api";
import { forkBindingNotice } from "../../lib/agents/roster-labels";
import { Button, Dialog, DialogClose, Field, TextInput } from "../ui/console";
import { ErrorNotice } from "../admin/error-notice";
import { useMutation } from "../admin/use-resource";

/**
 * Fork (spec agents-roster AR8, §6.7, KOBE-571): name and slug prefilled from the source, a note
 * that the copy is the forker's own, in Personal, and, when the source is team content, that the
 * copy is bound to that team (the row's `forkBoundTeamId`, the server's rule). Creates the copy
 * (`POST /v1/agents/:id/fork`) and hands its id to `onForked`, which opens its draft.
 */
export function ForkDialog({
  row,
  team,
  returnFocus,
  onClose,
  onForked,
}: {
  readonly row: AgentRosterRow;
  /** The active team: forks are made from it, and named in the binding notice. */
  readonly team: { readonly id: string; readonly name: string };
  readonly returnFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onForked: (agentId: string) => void;
}) {
  const mutation = useMutation();
  const [name, setName] = useState(row.name);
  const [slug, setSlug] = useState(row.slug);
  const bound = forkBindingNotice(row, team);

  async function submit() {
    const body = {
      ...(name.trim() !== row.name && name.trim() !== "" ? { name: name.trim() } : {}),
      ...(slug.trim() !== row.slug && slug.trim() !== "" ? { slug: slug.trim() } : {}),
    };
    let created: string | null = null;
    const done = await mutation.run(async () => {
      const res = await forkAgent(team.id, row.agentId, body);
      if (res.ok) created = res.data.agent.id;
      return res;
    });
    if (done && created !== null) onForked(created);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Fork ${row.name}`}
      description="Your copy, in Personal. Only you edit it; the original is unchanged."
      returnFocus={() => returnFocus}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <TextInput
            type="text"
            value={name}
            maxLength={AGENT_FORK_NAME_MAX}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Slug"
          hint="Permanent. If it is taken, a free one like it is chosen when you leave it as is."
        >
          <TextInput type="text" value={slug} onChange={(e) => setSlug(e.target.value)} />
        </Field>
        {bound && (
          <p role="note" className="m-0 text-sm font-medium">
            {bound}
          </p>
        )}
        {mutation.error && <ErrorNotice error={mutation.error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <DialogClose asChild>
            <Button type="button">Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" loading={mutation.pending}>
            Fork and open
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
