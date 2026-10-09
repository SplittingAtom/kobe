import { MAX_FRAME_BYTES } from "./protocol.js";

/** Longest a uuid and a request id the agent mints can be; the agent adds `run_id`, `thread_id`. */
const UUID = "00000000-0000-4000-8000-000000000000";
const REQUEST_ID = "xx_9999999999";

/**
 * Why a call cannot be sent, or undefined. The call travels twice as a wire frame: as the
 * `policy.check` kobe-policy sends and as the `artifact.put` the agent sends once it was allowed;
 * the server closes the whole sandbox connection on a frame over 1 MiB, so a call that would not
 * fit is refused here with a tool error, before anything is sent. The frames are measured as the
 * agent builds them, with worst-case ids.
 */
export function frameSizeProblem(
  toolCallId: string,
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  for (const type of ["policy.check", "artifact.put", "file.share"]) {
    const frame = {
      v: 1,
      type,
      request_id: REQUEST_ID,
      run_id: UUID,
      thread_id: UUID,
      tool_call_id: toolCallId,
      tool,
      input,
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes > MAX_FRAME_BYTES) {
      return `the call is too large to send (${type} frame ${bytes} bytes, limit ${MAX_FRAME_BYTES}); shorten the content`;
    }
  }
  return undefined;
}
