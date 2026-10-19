"use client";

import { AppWindow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
 * and app cards (and send `ui/resource-teardown` through `HostBridge.teardown` before they remove
 * a frame); MA-7 wires `onMessage` and `onModelContext` to the composer.
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

export function AppFrame(props: AppFrameProps) {
  const { app, teamId, placement } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<HostBridge | null>(null);
  const [height, setHeight] = useState(INLINE_HEIGHT);
  // The latest props for the bridge's handlers, without re-attaching it on every render.
  const latest = useRef(props);
  latest.current = props;
  const src = useMemo(
    () => appFrameUrl(app.appId, teamId, app.sha256),
    [app.appId, teamId, app.sha256],
  );

  useEffect(() => {
    const current = () => latest.current;
    const fetchFn = (...args: Parameters<typeof fetch>) => (current().fetchFn ?? fetch)(...args);
    const attached = attachHostBridge(window, {
      frame: () => frame.current?.contentWindow ?? null,
      hostContext: () =>
        buildHostContext(current().placement, {
          width: frame.current?.clientWidth ?? 0,
          maxHeight: maxHeight(current().placement),
        }),
      handlers: {
        callTool: (name, args) => callAppTool(app.appId, teamId, name, args, fetchFn),
        listTools: () => listAppTools(app.appId, teamId, fetchFn),
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
    return () => {
      bridge.current = null;
      attached.detach();
    };
  }, [app.appId, teamId]);

  useEffect(() => {
    bridge.current?.notify("ui/notifications/host-context-changed", {
      displayMode: placement === "expanded" ? "fullscreen" : "inline",
    });
  }, [placement]);

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
      <iframe
        ref={frame}
        title={`${app.title} (app from ${app.connectorName})`}
        src={src}
        sandbox={APP_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="w-full border-0 bg-background"
        style={placement === "expanded" ? { height: "100%", minHeight: height } : { height }}
      />
    </section>
  );
}
