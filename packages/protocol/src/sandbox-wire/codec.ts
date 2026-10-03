import type { z } from "zod";
import { parseJsonStrict } from "../json-safety.js";
import { SANDBOX_MAX_FRAME_BYTES, type SandboxErrorCode } from "./connection.js";
import {
  sandboxToServerFrameSchema,
  serverToSandboxFrameSchema,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
} from "./frames.js";

export type DecodeResult<T> =
  | { readonly ok: true; readonly frame: T }
  | {
      readonly ok: false;
      readonly code: Extract<SandboxErrorCode, "malformed_frame" | "frame_too_large">;
      readonly message: string;
    };

function decodeUnsafe<T>(schema: z.ZodType<T>, text: string): DecodeResult<T> {
  if (new TextEncoder().encode(text).byteLength > SANDBOX_MAX_FRAME_BYTES) {
    return { ok: false, code: "frame_too_large", message: "frame exceeds size limit" };
  }
  const strict = parseJsonStrict(text);
  if (!strict.ok) {
    return { ok: false, code: "malformed_frame", message: `frame rejected: ${strict.issue}` };
  }
  const parsed = schema.safeParse(strict.value);
  if (!parsed.success) {
    return {
      ok: false,
      code: "malformed_frame",
      message: parsed.error.issues[0]?.message ?? "invalid frame",
    };
  }
  return { ok: true, frame: parsed.data };
}

/**
 * Decoders never throw: an exception from any step (a validator bug, an engine limit) becomes
 * `malformed_frame`, because an uncaught throw in the WebSocket handler would take the server down
 * for every tenant.
 */
function decode<T>(schema: z.ZodType<T>, text: string): DecodeResult<T> {
  try {
    return decodeUnsafe(schema, text);
  } catch {
    return { ok: false, code: "malformed_frame", message: "frame rejected: decoder error" };
  }
}

/** Server side: validate a text frame received from a sandbox. Never trust it otherwise. */
export function decodeSandboxFrame(text: string): DecodeResult<SandboxToServerFrame> {
  return decode(sandboxToServerFrameSchema, text);
}

/** Sandbox side: validate a text frame received from the server. */
export function decodeServerFrame(text: string): DecodeResult<ServerToSandboxFrame> {
  return decode(serverToSandboxFrameSchema, text);
}

/**
 * JSON text of a frame with `v` then `type` first, whatever order the object was built in: the
 * server sizes large sandbox frames by the type read from that prefix (connection.ts).
 */
export function encodeFrame(frame: SandboxToServerFrame | ServerToSandboxFrame): string {
  const { v, type, ...rest } = frame;
  return JSON.stringify({ v, type, ...rest });
}
