import type { ToolsResponse } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalVersion(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

/** A `memory.put` / `memory.read` answer (memory.ts), or undefined when it is malformed (fail closed). */
export function parseMemoryReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const id = value.id as string;
  if (value.op === "put") {
    const { status, scope, path, version, previous_version: previous } = value;
    if (status !== "applied" && status !== "pending_approval") return undefined;
    if (typeof scope !== "string" || typeof path !== "string") return undefined;
    if (!optionalVersion(version) || !optionalVersion(previous)) return undefined;
    return {
      id,
      ok: true,
      op: "put",
      status,
      scope,
      path,
      ...(version === undefined ? {} : { version }),
      ...(previous === undefined ? {} : { previous_version: previous }),
    };
  }
  if (value.op !== "read" || !Array.isArray(value.files) || typeof value.truncated !== "boolean") {
    return undefined;
  }
  const files = [];
  for (const item of value.files as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { scope, path, content, version } = item;
    if (typeof scope !== "string" || typeof path !== "string") return undefined;
    if (content !== undefined && typeof content !== "string") return undefined;
    if (!Number.isSafeInteger(version)) return undefined;
    files.push({
      scope,
      path,
      version: version as number,
      ...(content === undefined ? {} : { content }),
    });
  }
  return { id, ok: true, op: "read", files, truncated: value.truncated };
}
