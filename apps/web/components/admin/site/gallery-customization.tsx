"use client";

import { useState } from "react";
import {
  compareGalleryAgent,
  resetGalleryAgent,
  type GalleryAgentDetail,
  type GalleryComparison,
  type GalleryState,
} from "../../../lib/admin/api/site/gallery";
import type { ApiResult } from "../../../lib/api/client";
import { Badge, Button, Notice, eventTrigger, useConfirm } from "../../ui/console";
import { ErrorNotice } from "../error-notice";
import { useMutation } from "../use-resource";

/**
 * Customized gallery agents (KOBE-494; D19/D21 as amended by Chris 2026-10-23): a site admin's edit
 * detaches the agent from the repository definition, so upgrades no longer change it. When the
 * repository moved on since, the console says so and offers Compare and Reset to repository.
 */
export function CustomizedBadge({
  gallery,
}: {
  readonly gallery: GalleryState | null | undefined;
}) {
  if (!gallery?.customized) return null;
  return (
    <Badge tone="accent" title="Edited by a site admin: upgrades no longer change it">
      Customized
    </Badge>
  );
}

/** The repository definition and the current version, side by side. */
export function ComparisonView({ comparison }: { readonly comparison: GalleryComparison }) {
  const { repository, current } = comparison;
  const side = (title: string, text: string | null) => (
    <figure className="m-0 min-w-0">
      <figcaption className="mb-1 text-sm font-medium">{title}</figcaption>
      <pre className="m-0 max-h-96 overflow-auto rounded border border-console-border bg-console-panel p-2 text-xs whitespace-pre-wrap">
        {text ?? "None."}
      </pre>
    </figure>
  );
  return (
    <div className="my-3 grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
      {side(
        repository
          ? `Repository definition (generation ${repository.generation})`
          : "Repository definition",
        repository?.file ?? null,
      )}
      {side(
        current ? `Current version (v${current.version})` : "Current version",
        current?.file ?? null,
      )}
    </div>
  );
}

/**
 * "A newer repository version is available" with Compare and Reset to repository (asks first).
 * Shown for a customized agent whose repository definition is newer; with `always` (the editor),
 * for any customized agent, so it can be re-attached at any time.
 */
export function UpdateAvailable({
  agentId,
  name,
  gallery,
  onReset,
  always = false,
}: {
  readonly agentId: string;
  readonly name: string;
  readonly gallery: GalleryState | null | undefined;
  readonly onReset: (agent: GalleryAgentDetail) => void;
  readonly always?: boolean;
}) {
  const [comparison, setComparison] = useState<GalleryComparison | null>(null);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  if (!gallery?.customized || !(gallery.updateAvailable || always)) return null;

  async function compare(): Promise<void> {
    if (comparison) {
      setComparison(null);
      return;
    }
    await mutation.run(async () => {
      const res = await compareGalleryAgent(agentId);
      if (res.ok) setComparison(res.data);
      return res;
    });
  }

  async function reset(trigger: HTMLElement | null): Promise<void> {
    const yes = await confirm(
      {
        title: `Reset ${name} to the repository definition?`,
        description:
          "Your customization is replaced: the repository definition is published as a new version and upgrades update the agent again. Earlier versions stay in its history.",
        confirmLabel: "Reset to repository",
      },
      trigger,
    );
    if (!yes) return;
    await mutation.run(async (): Promise<ApiResult<unknown>> => {
      const res = await resetGalleryAgent(agentId);
      if (res.ok) onReset(res.data.agent);
      return res;
    });
  }

  return (
    <Notice tone="info">
      <p className="m-0">
        {gallery.updateAvailable
          ? `A newer repository version of ${name} is available (generation ${gallery.generation}; it was customized from generation ${gallery.customizedFromGeneration}).`
          : `${name} is customized: releases no longer update it. Reset it to the repository definition to follow releases again.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" disabled={mutation.pending} onClick={() => void compare()}>
          {comparison ? "Hide comparison" : "Compare"}
          <span className="sr-only"> {name} with the repository</span>
        </Button>
        <Button size="sm" disabled={mutation.pending} onClick={(e) => void reset(eventTrigger(e))}>
          Reset to repository<span className="sr-only"> ({name})</span>
        </Button>
      </div>
      {mutation.error && <ErrorNotice error={mutation.error} />}
      {comparison && <ComparisonView comparison={comparison} />}
      {confirmDialog}
    </Notice>
  );
}
