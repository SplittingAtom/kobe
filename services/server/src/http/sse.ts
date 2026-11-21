/** Server-sent event responses (KOBE-702: one definition for every SSE route). */

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
} as const;

/** Under @hono/node-server, `c.env.outgoing` is the Node response; destroying it drops the socket. */
export function nodeResponseDestroyer(env: unknown): (() => void) | undefined {
  const outgoing = (env as { outgoing?: { destroy?: unknown } } | undefined)?.outgoing;
  if (!outgoing || typeof outgoing.destroy !== "function") return undefined;
  return () => (outgoing.destroy as () => void).call(outgoing);
}
