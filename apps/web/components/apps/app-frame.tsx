"use client";

import { AppWindow } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { appFrameUrl, callAppTool, listAppTools } from "../../lib/apps/app-api";
import { APP_FRAME_SANDBOX } from "../../lib/apps/app-frame";
import type { DisplayMode, ModelContext } from "../../lib/apps/bridge-schema";
import { attachHostBridge, type HostBridge } from "../../lib/apps/host-bridge";
import { buildHostContext, type Placement } from "../../lib/apps/host-context";

/**
 * An MCP App in a sandboxed frame (KOBE-437, spec T2, T9, MA3, MA10): Kobe's member frame route
 * (header CSP `sandbox allow-scripts`, no network), `sandbox="allow-scripts"`, no `allow`
 * permissions, no referrer, under a host-drawn header the app cannot cover ("App from
 * _connector_"). Kobe's host bridge answers only this frame. MA-9 and MA-6 place it in tool cards
 * and app cards (and call `AppFrameHandle.teardown` before they remove a frame); MA-7 wires
 * `onMessage` and `onModelContext` to the composer.
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
  return (
    <section
      className="flex flex-col overflow-hidden rounded-md border border-border bg-card"
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
  const [height, setHeight] = useState(INLINE_HEIGHT);
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
        callTool: (name, args) => callAppTool(appId, team, name, args, fetchFn),
        listTools: () => listAppTools(appId, team, fetchFn),
        message: (text) => current().onMessage?.(text) ?? false,
        updateModelContext: (context) => current().onModelContext?.(context) ?? false,
        requestDisplayMode: (mode) =>
          current().onDisplayMode?.(mode) ??
          (current().placement === "expanded" ? "fullscreen" : "inline"),
        sizeChanged: ({ height: wanted }) => {
          if (wanted === undefined) return;
          setHeight(Math.min(Math.max(Math.round(wanted), 1), maxHeight(current().placement)));
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

  useEffect(() => {
    bridge.current?.notify("ui/notifications/host-context-changed", {
      displayMode: placement === "expanded" ? "fullscreen" : "inline",
    });
  }, [placement]);

  return (
    <iframe
      ref={frame}
      title={`${app.title} (app from ${app.connectorName})`}
      src={fixed.src}
      sandbox={APP_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="w-full border-0 bg-background"
      style={placement === "expanded" ? { height: "100%", minHeight: height } : { height }}
    />
  );
}
