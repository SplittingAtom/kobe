/**
 * The stubbed bridge of the template review's preview (KOBE-434, spec §5): the template runs in
 * the sandboxed frame, but every call it makes fails here and nothing reaches the server or the
 * upstream. Only messages from the preview's own frame are answered (spec T4); `ui/initialize`
 * gets a minimal answer so the app can start, everything else a JSON-RPC error.
 */
export const NOT_IN_PREVIEW = -32601;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
}

function asRequest(data: unknown): JsonRpcRequest | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const m = data as Record<string, unknown>;
  const idOk = typeof m.id === "string" || typeof m.id === "number";
  return m.jsonrpc === "2.0" && idOk && typeof m.method === "string"
    ? (m as unknown as JsonRpcRequest)
    : undefined;
}

/** The stub's answer to one message, or undefined for notifications and junk (dropped). */
export function stubBridgeReply(data: unknown): Record<string, unknown> | undefined {
  const request = asRequest(data);
  if (!request) return undefined;
  if (request.method === "ui/initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "kobe-preview", version: "1" },
        hostCapabilities: {},
        hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code: NOT_IN_PREVIEW,
      message: "Calls are not available in a review preview.",
      data: { reason: "preview" },
    },
  };
}

/**
 * Listens for the frame's messages on `target` and answers only that frame. Returns the detach
 * function.
 */
export function attachStubBridge(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  frame: () => Window | null,
): () => void {
  const onMessage = (event: MessageEvent) => {
    const source = frame();
    if (source === null || event.source !== source) return;
    const reply = stubBridgeReply(event.data);
    // An opaque origin cannot be named, so "*"; the reply carries nothing but an error.
    if (reply) source.postMessage(reply, "*");
  };
  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}
