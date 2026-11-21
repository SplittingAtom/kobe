import { describe, expect, it, vi } from "vitest";
import { SSE_HEADERS, nodeResponseDestroyer } from "./sse.js";

describe("SSE helpers", () => {
  it("names the event-stream headers proxies must not buffer", () => {
    expect(SSE_HEADERS).toEqual({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
  });

  it("destroys the Node response when there is one", () => {
    const destroy = vi.fn();
    const outgoing = { destroy };
    nodeResponseDestroyer({ outgoing })?.();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.contexts[0]).toBe(outgoing);
  });

  it("gives nothing without a destroyable Node response", () => {
    expect(nodeResponseDestroyer(undefined)).toBeUndefined();
    expect(nodeResponseDestroyer({})).toBeUndefined();
    expect(nodeResponseDestroyer({ outgoing: { destroy: 1 } })).toBeUndefined();
  });
});
