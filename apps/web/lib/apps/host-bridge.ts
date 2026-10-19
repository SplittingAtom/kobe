import type { z } from "zod";
import {
  PROTOCOL_VERSION,
  callToolParams,
  displayModeParams,
  initializeParams,
  listToolsParams,
  messageParams,
  modelContextParams,
  notificationSchema,
  requestSchema,
  responseSchema,
  sizeChangedParams,
  type DisplayMode,
  type ModelContext,
  type SizeChanged,
} from "./bridge-schema";

/**
 * Kobe's host bridge for MCP Apps (KOBE-437, spec MA2, T4, T5, §7 and §8). Kobe's own, not the
 * ext-apps `AppBridge` (spike in docs/ledger/KOBE-437.md).
 *
 * - A message is handled only when `event.source` is the frame's own `contentWindow` and
 *   `event.origin` is `"null"` (the frame's opaque origin); everything else is ignored.
 * - Each method's params are parsed with zod; malformed requests get `-32602`, junk is dropped.
 * - The §7 table: `ui/initialize`, `tools/call` and `tools/list` (only through `handlers`, i.e.
 *   Kobe's MA-4 endpoints), `ui/message` (composer text, never sent), `ui/update-model-context`
 *   (a chip), `ui/request-display-mode` (inline or fullscreen), size-changed, and logging
 *   (dropped, counted). Everything else, `ui/open-link`, `ui/download-file`, `resources/*`,
 *   `sampling/*` and `elicitation/*` included, is denied with `-32601`
 *   `{reason: "not_allowed_in_kobe"}`.
 * - Per frame: 64 KiB per message, 10 requests per second, 4 tool calls in flight, and results
 *   capped at 4 MiB.
 * - Replies go only to the frame's `contentWindow`, with target `"*"` (an opaque origin cannot be
 *   named), so a reply never carries anything the app is not entitled to.
 */
export const NOT_ALLOWED = "not_allowed_in_kobe";
export const BRIDGE_LIMITS = Object.freeze({
  messageBytes: 64 * 1024,
  requestsPerSecond: 10,
  callsInFlight: 4,
  resultBytes: 4 * 1024 * 1024,
});
/** `ui/message` text (spec §8). */
export const MESSAGE_TEXT_MAX = 4 * 1024;
/** `ui/update-model-context`, serialized (spec §8). */
export const MODEL_CONTEXT_MAX = 8 * 1024;
const HOST_VERSION = "1";

export type ToolCallAnswer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };
export type ToolListAnswer =
  | { readonly ok: true; readonly tools: readonly unknown[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface HostBridgeHandlers {
  /** `POST /v1/team/apps/:appId/calls` (MA-4); the server decides. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallAnswer>;
  /** `GET /v1/team/apps/:appId/tools`. */
  listTools(): Promise<ToolListAnswer>;
  /** Insert into the composer draft, never send (MA-7). False if there is no composer. */
  message(text: string): boolean;
  /** Show or replace the context chip (MA-7). False if refused. */
  updateModelContext(context: ModelContext): boolean;
  requestDisplayMode(mode: DisplayMode): DisplayMode;
  sizeChanged(size: SizeChanged): void;
  /** The app finished `ui/initialize`: the host sends tool-input and tool-result now. */
  initialized(): void;
}

export interface HostBridgeOptions {
  /** The frame's window; messages from anything else are ignored. */
  readonly frame: () => Window | null;
  readonly handlers: HostBridgeHandlers;
  /** `hostContext` for `ui/initialize` (theme, display mode, size, locale; no identifiers). */
  readonly hostContext: () => Record<string, unknown>;
  readonly now?: () => number;
}

export interface HostBridge {
  /** A host → app notification (`tool-input`, `tool-result`, `host-context-changed`). */
  notify(method: string, params: unknown): void;
  /** Sends `ui/resource-teardown`; true if the app answered within `timeoutMs`. */
  teardown(timeoutMs: number): Promise<boolean>;
  /** Logging notifications dropped so far (a debug counter). */
  droppedLogs(): number;
  detach(): void;
}

type Id = string | number;
type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

const failure = (code: number, message: string, reason?: string): Reply => ({
  error: { code, message, ...(reason ? { data: { reason } } : {}) },
});
const DENIED = failure(-32601, "Kobe does not offer this to apps.", NOT_ALLOWED);
const INVALID = failure(-32602, "Invalid params.");

/** Serialized size in UTF-8 bytes, or undefined when it cannot be serialized. */
function sizeOf(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : new TextEncoder().encode(text).length;
  } catch {
    return undefined;
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function attachHostBridge(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  options: HostBridgeOptions,
): HostBridge {
  const { handlers } = options;
  const now = options.now ?? (() => Date.now());
  const recent: number[] = [];
  let inFlight = 0;
  let dropped = 0;
  let nextId = 1;
  const pending = new Map<Id, (ok: boolean) => void>();

  const post = (message: Record<string, unknown>) => {
    options.frame()?.postMessage({ jsonrpc: "2.0", ...message }, "*");
  };
  const answer = (id: Id, reply: Reply) => post({ id, ...reply });

  const allowRequest = (): boolean => {
    const t = now();
    while (recent.length > 0 && t - (recent[0] as number) >= 1000) recent.shift();
    if (recent.length >= BRIDGE_LIMITS.requestsPerSecond) return false;
    recent.push(t);
    return true;
  };

  const callTool = async (params: unknown): Promise<Reply> => {
    const call = parse(callToolParams, params);
    if (!call) return INVALID;
    if (inFlight >= BRIDGE_LIMITS.callsInFlight) {
      return failure(-32000, "Too many calls in flight.", "too_many_calls");
    }
    inFlight += 1;
    try {
      const done = await handlers.callTool(call.name, call.arguments ?? {});
      if (!done.ok) return failure(-32000, done.message, done.code);
      const size = sizeOf(done.result);
      if (size === undefined || size > BRIDGE_LIMITS.resultBytes) {
        return failure(-32000, "The result is too large.", "result_too_large");
      }
      return { result: done.result };
    } finally {
      inFlight -= 1;
    }
  };

  const handleRequest = async (method: string, params: unknown): Promise<Reply> => {
    switch (method) {
      case "ui/initialize":
        if (parse(initializeParams, params) === undefined && params !== undefined) return INVALID;
        return {
          result: {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: "kobe", version: HOST_VERSION },
            hostCapabilities: {
              serverTools: {},
              logging: {},
              message: { text: {} },
              updateModelContext: { text: {}, structuredContent: {} },
            },
            hostContext: {
              ...options.hostContext(),
              availableDisplayModes: ["inline", "fullscreen"],
            },
          },
        };
      case "tools/call":
        return callTool(params);
      case "tools/list": {
        if (params !== undefined && parse(listToolsParams, params) === undefined) return INVALID;
        const listed = await handlers.listTools();
        return listed.ok
          ? { result: { tools: listed.tools } }
          : failure(-32000, listed.message, listed.code);
      }
      case "ui/message": {
        const message = parse(messageParams, params);
        if (!message) return INVALID;
        const text = message.content
          .filter((b) => b.type === "text" && typeof b["text"] === "string")
          .map((b) => b["text"] as string)
          .join("\n");
        if (text === "" || text.length > MESSAGE_TEXT_MAX) return INVALID;
        return handlers.message(text) ? { result: {} } : { result: { isError: true } };
      }
      case "ui/update-model-context": {
        const context = parse(modelContextParams, params);
        const size = context ? sizeOf(context) : undefined;
        if (!context || size === undefined || size > MODEL_CONTEXT_MAX) return INVALID;
        return handlers.updateModelContext(context) ? { result: {} } : INVALID;
      }
      case "ui/request-display-mode": {
        const wanted = parse(displayModeParams, params);
        return wanted ? { result: { mode: handlers.requestDisplayMode(wanted.mode) } } : INVALID;
      }
      default:
        return DENIED;
    }
  };

  const handleNotification = (method: string, params: unknown) => {
    if (method === "ui/notifications/size-changed") {
      const size = parse(sizeChangedParams, params);
      if (size) handlers.sizeChanged(size);
    } else if (method === "ui/notifications/initialized") {
      handlers.initialized();
    } else if (method === "notifications/message") {
      dropped += 1;
    }
    // Any other notification is dropped.
  };

  const onMessage = (event: MessageEvent) => {
    const frame = options.frame();
    if (frame === null || event.source !== frame || event.origin !== "null") return;
    const data: unknown = event.data;
    const request = parse(requestSchema, data);
    const size = sizeOf(data);
    if (size === undefined || size > BRIDGE_LIMITS.messageBytes) {
      if (request) answer(request.id, failure(-32600, "The message is too large.", "too_large"));
      return;
    }
    if (request) {
      if (!allowRequest()) {
        answer(request.id, failure(-32000, "Too many requests.", "rate_limited"));
        return;
      }
      void handleRequest(request.method, request.params).then(
        (reply) => answer(request.id, reply),
        () => answer(request.id, failure(-32603, "Internal error.")),
      );
      return;
    }
    const response = parse(responseSchema, data);
    if (response && !("method" in (data as object))) {
      pending.get(response.id)?.(response.error === undefined);
      return;
    }
    const notification = parse(notificationSchema, data);
    if (notification) handleNotification(notification.method, notification.params);
  };

  target.addEventListener("message", onMessage);
  return {
    notify: (method, params) => post({ method, params }),
    teardown: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const id = `kobe-${nextId++}`;
        const timer = setTimeout(() => settle(false), timeoutMs);
        function settle(ok: boolean) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(ok);
        }
        pending.set(id, settle);
        post({ id, method: "ui/resource-teardown", params: {} });
      }),
    droppedLogs: () => dropped,
    detach: () => {
      target.removeEventListener("message", onMessage);
      for (const settle of [...pending.values()]) settle(false);
    },
  };
}
