"use client";

import { Maximize2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { removeQueuedAppCard } from "../../lib/apps/app-cards";
import { readAppResult, type AppResultView } from "../../lib/apps/app-results";
import { useArtifactPanel } from "../chat/artifact-state";
import { useThreadApps } from "./thread-apps";

/**
 * Rail launches waiting for the thread's run (KOBE-440, spec MA11, D17): one chip each, "App:
 * _name_ (waits for the run)", in launch order. × removes it (nothing is inserted); Expand opens
 * it in the artifact column meanwhile (a transient view, not an entry). The run's end inserts
 * the rest as app cards, before the next queued message.
 */
export function QueuedAppCards() {
  const apps = useThreadApps();
  const [error, setError] = useState<string | null>(null);
  if (!apps || apps.queued.length === 0 || apps.threadId === null) return null;
  const threadId = apps.threadId;
  const remove = async (view: AppResultView) => {
    setError(null);
    const res = await removeQueuedAppCard(threadId, view.resultRef, apps.teamId);
    if (!res.ok && res.error.status !== 404) setError(res.error.message);
    apps.reload();
  };
  return (
    <div className="flex flex-col gap-1" data-kobe-queued-apps>
      <ul className="flex flex-wrap gap-1.5" aria-label="Apps waiting for the run">
        {apps.queued.map((view) => (
          <QueuedChip key={view.resultRef} view={view} onRemove={() => void remove(view)} />
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

function QueuedChip({
  view,
  onRemove,
}: {
  readonly view: AppResultView;
  readonly onRemove: () => void;
}) {
  const apps = useThreadApps();
  const panel = useArtifactPanel();
  const title = view.app?.title ?? view.tool;
  const expand = async () => {
    if (!apps || !panel || apps.threadId === null) return;
    const read = await readAppResult(apps.threadId, view.resultRef, apps.teamId);
    if (!read.ok) return;
    apps.take(view.resultRef, true);
    panel.openApp({
      cardKey: view.resultRef,
      app: {
        appId: view.appId,
        connectorName: view.connectorName,
        title,
        sha256: view.templateSha256,
      },
      connectorId: view.connectorId,
      toolInput: read.input ?? undefined,
      toolResult: read.result,
    });
  };
  return (
    <li className="bg-background inline-flex items-center gap-1 rounded-full border py-0.5 ps-2.5 pe-1 text-xs">
      <span>App: {title} (waits for the run)</span>
      {panel && view.view === "app" && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
          aria-label={`Expand ${title}`}
          title={`Expand ${title} in the side column while it waits`}
          onClick={() => void expand()}
        >
          <Maximize2Icon aria-hidden className="size-3" />
        </button>
      )}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
        aria-label={`Remove ${title} from the queue`}
        title={`Remove ${title} from the queue`}
        onClick={onRemove}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </li>
  );
}
