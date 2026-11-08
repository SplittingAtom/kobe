"use client";

import type { AgentLineage, AgentRosterRow } from "@kobe/protocol";
import Link from "next/link";
import { getAgentVersion, getTeamAgent } from "../../lib/admin/api/team/agent-builder";
import { forkedFromLabel, lineageHref } from "../../lib/agents/roster-labels";
import type { ApiResult } from "../../lib/api/client";
import { Button, Dialog, DialogClose } from "../ui/console";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";

/**
 * Lineage on the Personal tab (spec agents-roster §6.7, §7.5, KOBE-571): "Forked from <name> vN",
 * linked to the source when the viewer may read it (the server names it only then).
 */
export function ForkedFrom({ lineage }: { readonly lineage: AgentLineage }) {
  const href = lineageHref(lineage);
  const label = forkedFromLabel(lineage);
  return (
    <div className="text-sm font-normal text-console-muted">
      {href ? <Link href={href}>{label}</Link> : label}
    </div>
  );
}

/** Whether "Compare with source" can be offered: a readable source at a published version. */
export const canCompareWithSource = (row: AgentRosterRow): boolean =>
  row.forkedFrom !== undefined && row.forkedFrom.kind !== null && row.forkedFrom.version !== null;

interface Sides {
  readonly source: string;
  readonly copy: string;
}

async function loadSides(
  teamId: string,
  row: AgentRosterRow,
  lineage: AgentLineage & { readonly version: number },
): Promise<ApiResult<Sides>> {
  const source = await getAgentVersion(teamId, lineage.agentId, lineage.version);
  if (!source.ok) return source;
  const copy = await getTeamAgent(teamId, row.agentId);
  if (!copy.ok) return copy;
  return {
    ok: true,
    status: 200,
    data: { source: source.data.version.prompt, copy: copy.data.agent.prompt },
  };
}

/**
 * Compare with source (§7.5): the source's version the fork copied beside the copy's draft, so the
 * forker sees what they changed. Text only, never rendered.
 */
export function CompareWithSourceDialog({
  row,
  teamId,
  returnFocus,
  onClose,
}: {
  readonly row: AgentRosterRow;
  readonly teamId: string;
  readonly returnFocus: HTMLElement | null;
  readonly onClose: () => void;
}) {
  const lineage = row.forkedFrom;
  const version = lineage?.version ?? null;
  const { state } = useResource(() =>
    lineage && version !== null
      ? loadSides(teamId, row, { ...lineage, version })
      : Promise.resolve({ ok: true as const, status: 200, data: { source: "", copy: "" } }),
  );
  const side = (title: string, text: string) => (
    <figure className="m-0 min-w-0">
      <figcaption className="mb-1 text-sm font-medium">{title}</figcaption>
      <pre className="m-0 max-h-96 overflow-auto rounded border border-console-border bg-console-panel p-2 text-xs whitespace-pre-wrap">
        {text === "" ? "None." : text}
      </pre>
    </figure>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Compare ${row.name} with its source`}
      description="The instructions of the version you forked beside your copy's draft."
      returnFocus={() => returnFocus}
    >
      <ResourceView state={state} label="both versions">
        {(sides) => (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
            {side(
              `${lineage?.name ?? "Source"}${version === null ? "" : ` v${version}`}`,
              sides.source,
            )}
            {side("Your copy (draft)", sides.copy)}
          </div>
        )}
      </ResourceView>
      <div className="mt-4 flex justify-end">
        <DialogClose asChild>
          <Button type="button">Close</Button>
        </DialogClose>
      </div>
    </Dialog>
  );
}
