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
import { callQueue, roughlyTooLarge, windowCounter } from "./bridge-limits";
import { appItemsOf, type LinkedItem } from "./app-items";

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
 * - Per frame: 40 messages per second in all (more are dropped unread), 64 KiB per message
 *   (checked cheaply first), 10 requests per second, tool calls one at a time with at most 4
 *   admitted (a `validation_busy` answer is retried once), results capped at 4 MiB, and
 *   `initialized` honoured once.
 * - The bridge binds to the first window `frame()` names; if that changes (a re-used iframe
 *   navigated to another app), or once detached, it neither answers nor posts (review MEDIUM-1).
 * - Replies go only to the frame's `contentWindow`, with target `"*"` (an opaque origin cannot be
 *   named), so a reply never carries anything the app is not entitled to.
 */
export const NOT_ALLOWED = "not_allowed_in_kobe";
export const BRIDGE_LIMITS = Object.freeze({
  messageBytes: 64 * 1024,
  messagesPerSecond: 40,
  requestsPerSecond: 10,
  callsInFlight: 4,
  resultBytes: 4 * 1024 * 1024,
});
/** `ui/message` text in UTF-8 bytes (spec §8). */
export const MESSAGE_TEXT_MAX = 4 * 1024;
/** `ui/update-model-context`, serialized (spec §8). */
export const MODEL_CONTEXT_MAX = 8 * 1024;
const HOST_VERSION = "1";
/** One retry of a call the server's validator had no room for (review LOW-3). */
const BUSY_RETRY_MS = 250;

/** A `ui/message` for the composer: its text, or its items (which replace the text). */
export interface AppMessage {
  readonly text: string;
  readonly items: readonly LinkedItem[];
  /** resource_link blocks dropped as invalid or extra. */
  readonly dropped: number;
}

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
  /**
   * Insert into the composer draft, never send (MA-7): the text, or the message's items as chips
   * in its place (KOBE-490). False if there is no composer. Told also when nothing was usable
   * (`dropped` > 0, no text, no items) so the composer can say so; the app gets an error then.
   */
  message(message: AppMessage): boolean;
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
  const messages = windowCounter(BRIDGE_LIMITS.messagesPerSecond, now);
  const requests = windowCounter(BRIDGE_LIMITS.requestsPerSecond, now);
  const calls = callQueue(BRIDGE_LIMITS.callsInFlight);
  let dropped = 0;
  let nextId = 1;
  let detached = false;
  let initialized = false;
  let bound: Window | null = null;
  const pending = new Map<Id, (ok: boolean) => void>();

  /** The frame's window while it is still the one this bridge was bound to. */
  const current = (): Window | null => {
    if (detached) return null;
    const frame = options.frame();
    if (frame !== null && bound === null) bound = frame;
    return frame !== null && frame === bound ? frame : null;
  };
  const post = (message: Record<string, unknown>) => {
    current()?.postMessage({ jsonrpc: "2.0", ...message }, "*");
  };
  const answer = (id: Id, reply: Reply) => post({ id, ...reply });

  const callOnce = async (name: string, args: Record<string, unknown>) => {
    const done = await handlers.callTool(name, args);
    if (done.ok || done.code !== "validation_busy" || detached) return done;
    await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
    return detached ? done : handlers.callTool(name, args);
  };

  const callTool = async (params: unknown): Promise<Reply> => {
    const call = parse(callToolParams, params);
    if (!call) return INVALID;
    const queued = calls.run(() => callOnce(call.name, call.arguments ?? {}));
    if (!queued) return failure(-32000, "Too many calls in flight.", "too_many_calls");
    const done = await queued;
    if (!done.ok) return failure(-32000, done.message, done.code);
    const size = sizeOf(done.result);
    if (size === undefined || size > BRIDGE_LIMITS.resultBytes) {
      return failure(-32000, "The result is too large.", "result_too_large");
    }
    return { result: done.result };
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
        // resource_links become chips and replace the text (KOBE-490); text-only is as before.
        const { items, dropped } = appItemsOf(message.content);
        const text =
          items.length > 0
            ? ""
            : message.content
                .filter((b) => b.type === "text" && typeof b["text"] === "string")
                .map((b) => b["text"] as string)
                .join("\n");
        if (
          items.length === 0 &&
          (text === "" || new TextEncoder().encode(text).length > MESSAGE_TEXT_MAX)
        ) {
          if (dropped > 0) handlers.message({ text: "", items: [], dropped });
          return INVALID;
        }
        return handlers.message({ text, items, dropped })
          ? { result: {} }
          : { result: { isError: true } };
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
      // Once per frame: each one would post the card's input and result again (review LOW-1).
      if (initialized) return;
      initialized = true;
      handlers.initialized();
    } else if (method === "notifications/message") {
      dropped += 1;
    }
    // Any other notification is dropped.
  };

  const onMessage = (event: MessageEvent) => {
    const frame = current();
    if (frame === null || event.source !== frame || event.origin !== "null") return;
    // Every message counts, before it is measured or parsed (review LOW-1, LOW-2).
    if (!messages.take()) return;
    const data: unknown = event.data;
    if (roughlyTooLarge(data, BRIDGE_LIMITS.messageBytes)) return;
    const size = sizeOf(data);
    const request = parse(requestSchema, data);
    if (size === undefined || size > BRIDGE_LIMITS.messageBytes) {
      if (request) answer(request.id, failure(-32600, "The message is too large.", "too_large"));
      return;
    }
    if (request) {
      if (!requests.take()) {
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
      // Any answer, even an error, means the app saw the request.
      pending.get(response.id)?.(true);
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
      detached = true;
      target.removeEventListener("message", onMessage);
      for (const settle of [...pending.values()]) settle(false);
    },
  };
}
