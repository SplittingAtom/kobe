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
import { useAppComposer } from "./use-app-composer";

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
 *   "Opened in the side column" until the tab closes. An expanded app keeps its card's slot
 *   (review LOW-4): retiring it closes the tab.
 * - The app's tool-input is the stored input the upstream ran (review LOW-2), not Pi's entry.
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
  const byRun =
    where.liveRunId === undefined
      ? undefined
      : apps.byRun.get(runToolKey(where.liveRunId, toolCallId));
  // The thread's only result for this call (KOBE-445): never depends on the prompt's ancestry.
  return byPrompt ?? byRun ?? apps.byTool.get(toolCallId);
}

/** The conversation's scroller: the margins below are measured against it (KOBE-445). */
const SCROLLER = '[data-kobe-scroll="messages"]';

/** Whether the element is within `margin` of the viewport (no observer: always). */
function useWithin(ref: React.RefObject<HTMLElement | null>, margin: string): boolean {
  const [within, setWithin] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // With the window as root, the margins never apply inside the scrolling conversation (the
    // scroller clips the target first): a card above the fold after a reload never came near.
    const observer = new IntersectionObserver(
      (entries) => setWithin(entries.some((e) => e.isIntersecting)),
      { root: el.closest(SCROLLER), rootMargin: margin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, margin]);
  return within;
}

export function ToolCardApp({
  toolCallId,
  hasMarker,
}: {
  readonly toolCallId: string;
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
  return <LiveApp apps={apps} view={view} />;
}

export function AppPlaceholder({
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

export function LiveApp({
  apps,
  view,
}: {
  readonly apps: ThreadApps;
  readonly view: AppResultView;
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
  const [input, setInput] = useState<Record<string, unknown> | undefined>(undefined);
  const [mounted, setMounted] = useState(false);
  const [height, setHeight] = useState(INLINE_HEIGHT);
  const { take, release, threadId, teamId } = apps;

  // Near the viewport: ask for a slot; far beyond it: give it back.
  useEffect(() => {
    if (near) take(cardKey, false);
  }, [near, take, cardKey]);
  useEffect(() => {
    if (!within && !expanded) release(cardKey);
  }, [within, expanded, release, cardKey]);
  // An expanded app holds its card's slot; when another card retires it, its tab closes.
  const held = useRef(false);
  useEffect(() => {
    if (!expanded) held.current = false;
    else if (slotted) held.current = true;
    else if (held.current) {
      held.current = false;
      panel?.closeTab(appTabId(cardKey));
    }
  }, [expanded, slotted, panel, cardKey]);
  useEffect(() => () => release(cardKey), [release, cardKey]);

  // The stored result, read once (a reload rebuilds from it; the upstream is never called).
  const wanted = slotted || expanded;
  useEffect(() => {
    if (!wanted || result !== null || threadId === null) return;
    let alive = true;
    void readAppResult(threadId, view.resultRef, teamId).then((read) => {
      if (!alive) return;
      if (read.ok && read.input !== null) setInput(read.input);
      setResult(read.ok ? read.result : "failed");
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
    take(cardKey, true);
    panel.openApp({
      cardKey,
      app,
      connectorId: view.connectorId,
      toolInput: input,
      toolResult: result,
    });
  }, [panel, result, cardKey, app, input, take, view.connectorId]);
  const composer = useAppComposer({
    appId: view.appId,
    connectorId: view.connectorId,
    templateSha256: view.templateSha256,
    title: app.title,
  });

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
        toolInput={input}
        onMessage={composer.onMessage}
        onModelContext={composer.onModelContext}
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
