import type { Duplex } from "node:stream";
import { idSchema, parseJsonStrict, toolInputSchema } from "@kobe/protocol";
import { z } from "zod";
import { LineSplitter, encodeJsonl } from "../jsonl.js";

/**
 * Sandbox-local channel between the kobe-policy Pi extension (KOBE-36) and kobe-sandbox-agent.
 *
 * Transport: fd 3 of each `pi --mode rpc` process (`KOBE_POLICY_FD=3` in Pi's env) is one end of a
 * socket pair the agent created when it spawned Pi. Nothing listens; only that Pi process holds the
 * fd (Node marks non-stdio fds close-on-exec, so tools Pi spawns do not inherit it). JSONL, LF-split.
 *
 * extension → agent: `{"type":"policy.check","request_id","tool_call_id","parent_tool_call_id"?,
 *   "tool","input"}` — the agent adds `run_id` / `thread_id` itself (the extension cannot name
 *   another thread's run), forwards a `policy.check` frame and relays the server's answer.
 * agent → extension: the server's `policy.pending` / `policy.result` with the extension's
 *   `request_id` (other fields as in frames.ts, `v` removed), or a sandbox-local
 *   `{"type":"policy.result","request_id","decision":"deny","reasons":[],"message"}` when the agent
 *   cannot ask (no active run, not connected, connection lost, malformed request). Fail closed:
 *   the extension blocks the call on deny, on channel close, and on its own timeout.
 */
export const POLICY_CHANNEL_MAX_LINE_BYTES = 4 * 1024 * 1024;

export const policyChannelCheckSchema = z.strictObject({
  type: z.literal("policy.check"),
  request_id: idSchema,
  tool_call_id: idSchema,
  parent_tool_call_id: idSchema.optional(),
  tool: z.string().min(1).max(256),
  input: toolInputSchema,
});
export type PolicyChannelCheck = z.infer<typeof policyChannelCheckSchema>;

export type PolicyChannelReply = Record<string, unknown> & {
  readonly type: "policy.result" | "policy.pending";
  readonly request_id: string;
};

export function localDeny(requestId: string, message: string): PolicyChannelReply {
  return { type: "policy.result", request_id: requestId, decision: "deny", reasons: [], message };
}

export interface PolicyChannelHandlers {
  readonly onCheck: (check: PolicyChannelCheck) => void;
  readonly onDiagnostic?: (message: string) => void;
}

export class PolicyChannel {
  readonly #stream: Duplex;

  constructor(stream: Duplex, handlers: PolicyChannelHandlers) {
    this.#stream = stream;
    const splitter = new LineSplitter({
      maxLineBytes: POLICY_CHANNEL_MAX_LINE_BYTES,
      onLine: (line) => this.#onLine(line, handlers),
      onOversize: () => handlers.onDiagnostic?.("oversize policy request dropped"),
    });
    stream.on("data", (chunk: Buffer) => splitter.push(chunk));
    stream.on("error", () => undefined);
  }

  reply(message: PolicyChannelReply): void {
    if (!this.#stream.destroyed && this.#stream.writable) this.#stream.write(encodeJsonl(message));
  }

  #onLine(line: string, handlers: PolicyChannelHandlers): void {
    const strict = parseJsonStrict(line);
    const parsed = strict.ok ? policyChannelCheckSchema.safeParse(strict.value) : undefined;
    if (parsed?.success === true) {
      handlers.onCheck(parsed.data);
      return;
    }
    // Answer what we can identify so the extension never waits on a malformed request.
    const requestId = extractRequestId(strict.ok ? strict.value : undefined);
    if (requestId !== undefined) this.reply(localDeny(requestId, "malformed policy request"));
    handlers.onDiagnostic?.("malformed policy request");
  }
}

function extractRequestId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { request_id?: unknown }).request_id;
  return idSchema.safeParse(id).success ? (id as string) : undefined;
}
