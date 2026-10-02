import type { z } from "zod";
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

function decode<T>(schema: z.ZodType<T>, text: string): DecodeResult<T> {
  if (new TextEncoder().encode(text).byteLength > SANDBOX_MAX_FRAME_BYTES) {
    return { ok: false, code: "frame_too_large", message: "frame exceeds size limit" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: "malformed_frame", message: "frame is not valid JSON" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: "malformed_frame",
      message: parsed.error.issues[0]?.message ?? "invalid frame",
    };
  }
  return { ok: true, frame: parsed.data };
}

/** Server side: validate a text frame received from a sandbox. Never trust it otherwise. */
export function decodeSandboxFrame(text: string): DecodeResult<SandboxToServerFrame> {
  return decode(sandboxToServerFrameSchema, text);
}

/** Sandbox side: validate a text frame received from the server. */
export function decodeServerFrame(text: string): DecodeResult<ServerToSandboxFrame> {
  return decode(serverToSandboxFrameSchema, text);
}

export function encodeFrame(frame: SandboxToServerFrame | ServerToSandboxFrame): string {
  return JSON.stringify(frame);
}
