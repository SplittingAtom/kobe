import type { Duplex } from "node:stream";
import {
  idSchema,
  kobeToolsRequestSchema,
  parseJsonStrict,
  type KobeToolsRequest,
  type KobeToolsResponse,
} from "@kobe/protocol";
import { LineSplitter, encodeJsonl } from "../jsonl.js";

/**
 * Agent end of the kobe-tools channel (fd 4 of each `pi --mode rpc`; KOBE-128, shapes in packages/
 * protocol `artifacts.ts`; extension end in `kobe-tools/`). Same transport and trust notes as the
 * policy channel (`policy/channel.ts`): a socket pair the agent made when it spawned Pi, nothing
 * listens, JSONL, LF-split. There is no nonce: no tool exists on the channel before kobe-policy
 * allows its call, and the server re-checks every `artifact.put` against what it allowed (D-3).
 *
 * extension → agent: `{"id","op":"artifact.put","tool_call_id","tool","input"}` (validated with the
 *   protocol's strict schema; `run_id` / `thread_id` are added by the agent, never named by the
 *   extension).
 * agent → extension: `{"id","ok":true,"artifact_id","version"}` or `{"id","ok":false,"error"}`.
 *
 * A line over {@link TOOLS_CHANNEL_MAX_LINE_BYTES}, a line that is not JSON, or replies buffered
 * towards a reader that does not read close the channel; the extension then fails every call.
 */
export const TOOLS_CHANNEL_MAX_LINE_BYTES = 1024 * 1024;
export const TOOLS_CHANNEL_MAX_WRITE_BUFFER = 1024 * 1024;

export interface ToolsChannelHandlers {
  readonly onRequest: (
    request: KobeToolsRequest,
    reply: (response: KobeToolsResponse) => void,
  ) => void;
  /** The channel is unusable: everything pending for it fails. */
  readonly onClosed: (reason: string) => void;
  readonly onDiagnostic?: (message: string) => void;
}

export function toolsError(id: string, code: string, message: string): KobeToolsResponse {
  return { id, ok: false, error: { code, message } };
}

export class ToolsChannel {
  readonly #stream: Duplex;
  readonly #handlers: ToolsChannelHandlers;
  #closed = false;

  constructor(stream: Duplex, handlers: ToolsChannelHandlers) {
    this.#stream = stream;
    this.#handlers = handlers;
    const splitter = new LineSplitter({
      maxLineBytes: TOOLS_CHANNEL_MAX_LINE_BYTES,
      onLine: (line) => this.#onLine(line),
      onOversize: () => this.close("oversize kobe-tools request"),
    });
    stream.on("data", (chunk: Buffer) => {
      if (!this.#closed) splitter.push(chunk);
    });
    stream.on("error", () => undefined);
    stream.on("close", () => this.close("kobe-tools channel closed"));
  }

  get closed(): boolean {
    return this.#closed;
  }

  reply(response: KobeToolsResponse): void {
    if (this.#closed || this.#stream.destroyed || !this.#stream.writable) return;
    if (this.#stream.writableLength > TOOLS_CHANNEL_MAX_WRITE_BUFFER) {
      this.close("kobe-tools channel reader is not reading");
      return;
    }
    this.#stream.write(encodeJsonl(response));
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stream.destroy();
    this.#handlers.onClosed(reason);
  }

  #onLine(line: string): void {
    if (this.#closed) return;
    const strict = parseJsonStrict(line);
    if (!strict.ok) {
      this.close("malformed kobe-tools request");
      return;
    }
    const parsed = kobeToolsRequestSchema.safeParse(strict.value);
    if (parsed.success) {
      this.#handlers.onRequest(parsed.data, (response) => this.reply(response));
      return;
    }
    // Answer what we can identify so the extension never waits on a malformed request.
    const id = (strict.value as { id?: unknown } | null)?.id;
    if (idSchema.safeParse(id).success) {
      this.reply(toolsError(id as string, "invalid_input", "malformed request"));
    }
    this.#handlers.onDiagnostic?.("malformed kobe-tools request");
  }
}
