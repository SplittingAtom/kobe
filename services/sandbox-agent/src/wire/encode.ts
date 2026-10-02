import { decodeSandboxFrame, encodeFrame, type SandboxToServerFrame } from "@kobe/protocol";

export type OutboundFrame = SandboxToServerFrame;

export type EncodeResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly code: "frame_too_large" | "malformed_frame";
      readonly message: string;
    };

/**
 * Encode a frame and check it with the server's own decoder, so the agent never sends (or assigns
 * a seq to) a frame the server would reject: strict JSON rules, schema and size cap.
 */
export function encodeOutbound(frame: OutboundFrame): EncodeResult {
  let text: string;
  try {
    text = encodeFrame(frame);
  } catch {
    return { ok: false, code: "malformed_frame", message: "frame is not serialisable" };
  }
  const check = decodeSandboxFrame(text);
  return check.ok ? { ok: true, text } : { ok: false, code: check.code, message: check.message };
}
