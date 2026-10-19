"use client";

import { useAuiState } from "@assistant-ui/react";
import { Maximize2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readAppResult, textReason, type AppResultView } from "../../lib/apps/app-results";
import { appTabId } from "../../lib/apps/app-tabs";
import { approvalKey, runToolKey } from "../../lib/chat/markers";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { useArtifactPanel } from "../chat/artifact-state";
import { useKobeExtras } from "../chat/kobe-runtime";
import { AppFrame, INLINE_HEIGHT, TEARDOWN_MS, type AppFrameHandle } from "./app-frame";
import { useThreadApps, type ThreadApps } from "./thread-apps";

/**
 * An MCP App in its tool card (KOBE-438, spec MA3, MA10): the pinned template rendered with the
 * stored result of this tool call, under the viewer's own principal. Or the text card's one-line
 * reason when the server says this viewer gets text.
 *
 * - Frames load only within one viewport of the visible area and are torn down (after
 *   `ui/resource-teardown`) beyond three; a torn-down card keeps its last height.
 * - At most 3 live per thread; further cards say "Show app", and a click retires the frame least
 *   recently in view.
 * - Expand moves the app into the artifact column (one live frame per card): the card says
 *   "Opened in the side column" until the tab closes.
 * - A reload rebuilds the app from the stored result; nothing calls the upstream.
 */
const NEAR = "100% 0px";
const FAR = "300% 0px";

function useWhere() {
  const meta = useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
  const runId = useKobeExtras()?.state.live?.runId;
  const assistant = meta?.kind === "assistant" ? meta : undefined;
  return { prompt: assistant?.promptEntryId, liveRunId: assistant?.live ? runId : undefined };
}

function lookup(
  apps: ThreadApps,
  where: ReturnType<typeof useWhere>,
  toolCallId: string,
): AppResultView | undefined {
  const byPrompt =
    where.prompt === undefined
      ? undefined
      : apps.byPrompt.get(approvalKey(where.prompt, toolCallId));
  if (byPrompt !== undefined || where.liveRunId === undefined) return byPrompt;
  return apps.byRun.get(runToolKey(where.liveRunId, toolCallId));
}

/** Whether the element is within `margin` of the viewport (no observer: always). */
function useWithin(ref: React.RefObject<HTMLElement | null>, margin: string): boolean {
  const [within, setWithin] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setWithin(entries.some((e) => e.isIntersecting)),
      { rootMargin: margin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, margin]);
  return within;
}

export function ToolCardApp({
  toolCallId,
  args,
  hasMarker,
}: {
  readonly toolCallId: string;
  readonly args: Record<string, unknown> | undefined;
  /** The live tool result carried an `app` marker (the list may not have it yet). */
  readonly hasMarker: boolean;
}) {
  const apps = useThreadApps();
  const where = useWhere();
  const view = apps ? lookup(apps, where, toolCallId) : undefined;
  if (!apps || !view) {
    return hasMarker ? <AppPlaceholder height={INLINE_HEIGHT} label="Loading app" /> : null;
  }
  if (view.view !== "app") {
    return (
      <p
        className="text-muted-foreground border-t px-3 py-2 text-xs"
        data-kobe-app-text={view.reason}
      >
        {textReason(view)}
      </p>
    );
  }
  return <LiveApp apps={apps} view={view} args={args} />;
}

function AppPlaceholder({
  height,
  label,
  onShow,
}: {
  readonly height: number;
  readonly label: string;
  readonly onShow?: () => void;
}) {
  return (
    <div
      className="text-muted-foreground flex items-center justify-center border-t text-xs"
      style={{ height }}
      data-kobe-app-placeholder
    >
      {onShow ? (
        <button type="button" className="underline" onClick={onShow}>
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
    </div>
  );
}

function LiveApp({
  apps,
  view,
  args,
}: {
  readonly apps: ThreadApps;
  readonly view: AppResultView;
  readonly args: Record<string, unknown> | undefined;
}) {
  const panel = useArtifactPanel();
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<AppFrameHandle>(null);
  const near = useWithin(box, NEAR);
  const within = useWithin(box, FAR);
  const cardKey = view.resultRef;
  const expanded = panel?.tabs.open.includes(appTabId(cardKey)) ?? false;
  const slotted = apps.live.includes(cardKey);
  const [result, setResult] = useState<Record<string, unknown> | "failed" | null>(null);
  const [mounted, setMounted] = useState(false);
  const [height, setHeight] = useState(INLINE_HEIGHT);
  const { take, release, threadId, teamId } = apps;

  // Near the viewport: ask for a slot; far beyond it: give it back.
  useEffect(() => {
    if (near && !expanded) take(cardKey, false);
  }, [near, expanded, take, cardKey]);
  useEffect(() => {
    if (!within || expanded) release(cardKey);
  }, [within, expanded, release, cardKey]);
  useEffect(() => () => release(cardKey), [release, cardKey]);

  // The stored result, read once (a reload rebuilds from it; the upstream is never called).
  const wanted = slotted || expanded;
  useEffect(() => {
    if (!wanted || result !== null || threadId === null) return;
    let alive = true;
    void readAppResult(threadId, view.resultRef, teamId).then((read) => {
      if (alive) setResult(read.ok ? read.result : "failed");
    });
    return () => {
      alive = false;
    };
  }, [wanted, result, threadId, teamId, view.resultRef]);

  // Mount when live inline; before removing a frame, send it ui/resource-teardown.
  const live = slotted && !expanded && result !== null && result !== "failed";
  useEffect(() => {
    if (live && !mounted) setMounted(true);
    if (!live && mounted) {
      let alive = true;
      const done = handle.current?.teardown(TEARDOWN_MS) ?? Promise.resolve(false);
      void done.finally(() => {
        if (alive) setMounted(false);
      });
      return () => {
        alive = false;
      };
    }
    return undefined;
  }, [live, mounted]);

  const app = useMemo(
    () => ({
      appId: view.appId,
      connectorName: view.connectorName,
      title: view.app?.title ?? view.tool,
      sha256: view.templateSha256,
    }),
    [view],
  );
  const expand = useCallback(() => {
    if (!panel || result === null || result === "failed") return;
    panel.openApp({ cardKey, app, toolInput: args, toolResult: result });
  }, [panel, result, cardKey, app, args]);

  let body;
  if (expanded) {
    body = <AppPlaceholder height={48} label="Opened in the side column" />;
  } else if (result === "failed") {
    body = (
      <p className="text-muted-foreground border-t px-3 py-2 text-xs">
        This app could not be loaded. The text result is above.
      </p>
    );
  } else if (mounted && result !== null) {
    body = (
      <AppFrame
        ref={handle}
        app={app}
        teamId={teamId}
        cardKey={cardKey}
        placement="inline"
        toolInput={args}
        toolResult={result}
        initialHeight={height}
        onHeight={setHeight}
      />
    );
  } else if (!slotted && near) {
    body = <AppPlaceholder height={height} label="Show app" onShow={() => take(cardKey, true)} />;
  } else {
    body = <AppPlaceholder height={height} label="Loading app" />;
  }

  return (
    <div ref={box} className="border-t" data-kobe-app-card={cardKey}>
      {!expanded && result !== null && result !== "failed" && panel && (
        <div className="flex justify-end px-2 py-1">
          <button
            type="button"
            className="text-muted-foreground inline-flex items-center gap-1 text-xs"
            onClick={expand}
          >
            <Maximize2Icon aria-hidden className="size-3" />
            Expand
          </button>
        </div>
      )}
      {body}
    </div>
  );
}
