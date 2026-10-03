/**
 * Error serializer for every server log line (`err` / `error` keys). Database errors must never put
 * conversation content into logs: drizzle's `DrizzleQueryError` embeds the SQL and its bound
 * parameters (messages, entries, tool inputs) in `message` and `stack`, and pg errors carry values
 * in `detail`/`where`. Query errors are reduced to the pg code and message; other errors keep type,
 * message, code and stack; causes are serialized by the same rules (bounded depth).
 */
const MAX_DEPTH = 4;
const MAX_MESSAGE = 500;

function isQueryError(e: Record<string, unknown>): boolean {
  return "params" in e || "query" in e || e.name === "DrizzleQueryError";
}

function clip(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_MESSAGE) : undefined;
}

function serialize(err: unknown, depth: number, inQuery: boolean): Record<string, unknown> {
  if (err === null || typeof err !== "object")
    return { message: String(err).slice(0, MAX_MESSAGE) };
  const e = err as Record<string, unknown>;
  const query = inQuery || isQueryError(e);
  const out: Record<string, unknown> = {};
  const type = typeof e.name === "string" ? e.name : (err as object).constructor?.name;
  if (type) out.type = type;
  if (typeof e.code === "string" || typeof e.code === "number") out.code = e.code;
  if (isQueryError(e)) {
    out.message = "database query failed";
  } else {
    const message = clip(e.message);
    if (message !== undefined) out.message = message;
    // A pg error under a query error: its routine says where, its `detail`/`where` hold values.
    if (query && typeof e.routine === "string") out.routine = e.routine;
    if (!query && typeof e.stack === "string") out.stack = e.stack;
  }
  if (e.cause !== undefined && depth < MAX_DEPTH) out.cause = serialize(e.cause, depth + 1, query);
  return out;
}

export function serializeError(err: unknown): Record<string, unknown> {
  try {
    return serialize(err, 0, false);
  } catch {
    return { message: "unserializable error" };
  }
}
