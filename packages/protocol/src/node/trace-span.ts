import { createHmac, hkdfSync } from "node:crypto";
import { RUN_TOKEN_MASTER_MIN_BYTES } from "../run-token.js";
import { TRACE_SPAN_KDF_INFO, TRACE_SPAN_KEY_BYTES } from "../tracing.js";

/**
 * Sandbox span id remapping (KOBE-274, tracing.ts). Server side only (server and model gateway):
 * never import into sandbox code.
 */

/** `k_trace` = HKDF-SHA256(master = the model-gateway session key, info `kobe/trace-span/v1`). */
export function deriveTraceSpanKey(master: Uint8Array): Uint8Array {
  if (master.byteLength < RUN_TOKEN_MASTER_MIN_BYTES) {
    throw new Error(`trace span master secret is shorter than ${RUN_TOKEN_MASTER_MIN_BYTES} bytes`);
  }
  return new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(0), TRACE_SPAN_KDF_INFO, TRACE_SPAN_KEY_BYTES),
  );
}

/**
 * The exported id of a sandbox span: the first 64 bits of HMAC-SHA256(k_trace, run id ‖ 0x00 ‖
 * sandbox span id), as 16 lowercase hex digits (never all zero: an all-zero result maps to
 * `0000000000000001`). The 0x00 separator keeps the two inputs unambiguous.
 */
export function mapSandboxSpanId(key: Uint8Array, runId: string, sandboxSpanId: string): string {
  if (key.byteLength !== TRACE_SPAN_KEY_BYTES) throw new Error("trace span key has the wrong size");
  const id = createHmac("sha256", key)
    .update(runId, "ascii")
    .update(new Uint8Array([0]))
    .update(sandboxSpanId, "ascii")
    .digest("hex")
    .slice(0, 16);
  return id === "0".repeat(16) ? "0000000000000001" : id;
}
