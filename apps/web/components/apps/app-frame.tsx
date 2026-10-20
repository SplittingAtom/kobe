"use client";

import { AppWindow } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import { appFrameUrl, callAppTool, listAppTools } from "../../lib/apps/app-api";
import { APP_FRAME_SANDBOX } from "../../lib/apps/app-frame";
import type { DisplayMode, ModelContext } from "../../lib/apps/bridge-schema";
import { attachHostBridge, type HostBridge, type ToolCallAnswer } from "../../lib/apps/host-bridge";
import { buildHostContext, type Placement } from "../../lib/apps/host-context";

/**
 * An MCP App in a sandboxed frame (KOBE-437, spec T2, T9, MA3, MA10): Kobe's member frame route
 * (header CSP `sandbox allow-scripts`, no network), `sandbox="allow-scripts"`, no `allow`
 * permissions, no referrer, under a host-drawn header the app cannot cover ("App from
 * _connector_"). Kobe's host bridge answers only this frame. MA-9 and MA-6 place it in tool cards
 * and app cards (and call `AppFrameHandle.teardown` before they remove a frame); MA-7 wires
 * `onMessage` and `onModelContext` to the composer. KOBE-460 places one picker in the rail
 * (`placement: "rail"`: it fills its section and scrolls inside it), whose calls name the thread
 * on screen (`threadId`) so the server checks it as it checks a card's thread.
 */
export const INLINE_HEIGHT = 360;
export const INLINE_MAX_HEIGHT = 720;
export const EXPANDED_MAX_HEIGHT = 4000;

export interface AppFrameApp {
  readonly appId: string;
  readonly connectorName: string;
  readonly title: string;
  /** The approved template's hash; the frame route refuses other bytes. */
  readonly sha256: string;
}

export interface AppFrameProps {
  readonly app: AppFrameApp;
  readonly teamId: string;
  /** The card this frame belongs to (a tool call or an app card entry). */
  readonly cardKey: string;
  readonly placement: Placement;
  /**
   * The thread on screen, sent with each `tools/call` (a rail picker, KOBE-460: the server checks
   * the member may read it and the connector is not off there). Read at call time. A card's
   * frame sends none.
   */
  readonly threadId?: string | null | undefined;
  /** Each `tools/call`'s answer from Kobe (a refusal's code, for the owner to explain). */
  readonly onCall?: ((answer: ToolCallAnswer) => void) | undefined;
  /** Sent as `ui/notifications/tool-input` and `tool-result` once the app has initialized. */
  readonly toolInput?: Record<string, unknown> | undefined;
  readonly toolResult?: unknown;
  /** `ui/message`: insert into the composer, never send. False when there is no composer. */
  readonly onMessage?: ((text: string) => boolean) | undefined;
  /** `ui/update-model-context`: the context chip. False when refused. */
  readonly onModelContext?: ((context: ModelContext) => boolean) | undefined;
  /** `ui/request-display-mode`: the mode actually shown. */
  readonly onDisplayMode?: ((mode: DisplayMode) => DisplayMode) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  /** Start at this height (a card coming back keeps its last one, MA10). */
  readonly initialHeight?: number | undefined;
  /** The app's height after each size change. */
  readonly onHeight?: ((height: number) => void) | undefined;
}

const maxHeight = (placement: Placement) =>
  placement === "inline" ? INLINE_MAX_HEIGHT : EXPANDED_MAX_HEIGHT;

/** What an owner may do with a live frame (review LOW-4, coordinator decision 2). */
export interface AppFrameHandle {
  /**
   * Sends `ui/resource-teardown` and resolves once the app answered (true) or `timeoutMs`
   * passed (false). Owners call it before they remove a frame: scrolling far out of view, an
   * expanded tab closing, a team switch, sign-out or drift (spec §7).
   */
  teardown(timeoutMs?: number): Promise<boolean>;
}

/** How long an owner waits for an app to answer `ui/resource-teardown` by default. */
export const TEARDOWN_MS = 500;

/**
 * A fresh browsing context for every (app, team, bytes, card): changing any of them remounts
 * the iframe, so an old document can never receive another card's data or call through another
 * app's bridge while the new one loads (review MEDIUM-1).
 */
export function frameKey(app: AppFrameApp, teamId: string, cardKey: string): string {
  return `${app.appId}:${teamId}:${app.sha256}:${cardKey}`;
}

export function AppFrame(props: AppFrameProps & { readonly ref?: Ref<AppFrameHandle> }) {
  const { app, teamId, cardKey, ref } = props;
  const bridge = useRef<HostBridge | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      teardown: (timeoutMs = TEARDOWN_MS) =>
        bridge.current?.teardown(timeoutMs) ?? Promise.resolve(false),
    }),
    [],
  );
  const fill = props.placement === "rail";
  return (
    <section
      className={`flex flex-col overflow-hidden rounded-md border border-border bg-card${
        fill ? " min-h-0 flex-1" : ""
      }`}
      data-kobe-app-frame={app.appId}
      aria-label={`${app.title}, an app from ${app.connectorName}`}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
        <AppWindow aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{app.title}</span>
        <span className="truncate text-muted-foreground">App from {app.connectorName}</span>
      </header>
      <FrameInstance key={frameKey(app, teamId, cardKey)} {...props} bridgeRef={bridge} />
    </section>
  );
}

function FrameInstance(
  props: AppFrameProps & { readonly bridgeRef: RefObject<HostBridge | null> },
) {
  const { app, teamId, placement, bridgeRef } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<HostBridge | null>(null);
  const [height, setHeight] = useState(() =>
    Math.min(props.initialHeight ?? INLINE_HEIGHT, maxHeight(placement)),
  );
  // The latest props for the bridge's handlers, without re-attaching it on every render.
  const latest = useRef(props);
  latest.current = props;
  // Fixed for this instance: the key changes whenever any of them does.
  const [fixed] = useState(() => ({
    appId: app.appId,
    teamId,
    src: appFrameUrl(app.appId, teamId, app.sha256),
  }));

  useEffect(() => {
    const current = () => latest.current;
    const fetchFn = (...args: Parameters<typeof fetch>) => (current().fetchFn ?? fetch)(...args);
    const { appId, teamId: team } = fixed;
    const attached = attachHostBridge(window, {
      frame: () => frame.current?.contentWindow ?? null,
      hostContext: () =>
        buildHostContext(current().placement, {
          width: frame.current?.clientWidth ?? 0,
          maxHeight: maxHeight(current().placement),
        }),
      handlers: {
        callTool: async (name, args) => {
          const answer = await callAppTool(appId, team, name, args, fetchFn, current().threadId);
          current().onCall?.(answer);
          return answer;
        },
        listTools: () => listAppTools(appId, team, fetchFn),
        message: (text) => current().onMessage?.(text) ?? false,
        updateModelContext: (context) => current().onModelContext?.(context) ?? false,
        requestDisplayMode: (mode) =>
          current().onDisplayMode?.(mode) ??
          (current().placement === "expanded" ? "fullscreen" : "inline"),
        sizeChanged: ({ height: wanted }) => {
          if (wanted === undefined) return;
          const next = Math.min(Math.max(Math.round(wanted), 1), maxHeight(current().placement));
          setHeight(next);
          current().onHeight?.(next);
        },
        initialized: () => {
          const { toolInput, toolResult } = current();
          if (toolInput !== undefined) {
            attached.notify("ui/notifications/tool-input", { arguments: toolInput });
          }
          if (toolResult !== undefined) attached.notify("ui/notifications/tool-result", toolResult);
        },
      },
    });
    bridge.current = attached;
    bridgeRef.current = attached;
    return () => {
      if (bridgeRef.current === attached) bridgeRef.current = null;
      bridge.current = null;
      attached.detach();
    };
  }, [fixed, bridgeRef]);

  // Every removal (scrolled away, a closed tab, a thread or team switch, another branch) tells
  // the app first (spec §7, review LOW-3): a layout cleanup runs while the iframe is still in the
  // page, before the bridge detaches. Owners that can wait use `AppFrameHandle.teardown`.
  useLayoutEffect(
    () => () => {
      void bridge.current?.teardown(0);
    },
    [],
  );

  useEffect(() => {
    bridge.current?.notify("ui/notifications/host-context-changed", {
      displayMode: placement === "expanded" ? "fullscreen" : "inline",
    });
  }, [placement]);

  const iframe = (
    <iframe
      ref={frame}
      title={`${app.title} (app from ${app.connectorName})`}
      src={fixed.src}
      sandbox={APP_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="w-full border-0 bg-background"
      style={
        placement === "expanded"
          ? { height: "100%", minHeight: height }
          : placement === "rail"
            ? { height, minHeight: "100%" }
            : { height }
      }
    />
  );
  // In the rail (KOBE-460) the frame fills its section and scrolls inside it, like the Files tree.
  if (placement !== "rail") return iframe;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-kobe-app-scroll>
      {iframe}
    </div>
  );
}
