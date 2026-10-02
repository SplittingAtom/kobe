import { randomUUID } from "node:crypto";
import {
  SANDBOX_CLOSE_CODES,
  SANDBOX_HEARTBEAT_TIMEOUT_MS,
  SANDBOX_HELLO_TIMEOUT_MS,
  SANDBOX_MAX_FRAME_BYTES,
  SANDBOX_WS_SUBPROTOCOL,
  decodeServerFrame,
  type HelloAckFrame,
  type HelloFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import WebSocket from "ws";
import { DEFAULT_BACKOFF, backoffDelay, type BackoffPolicy } from "./backoff.js";
import { encodeOutbound, type OutboundFrame } from "./encode.js";

/**
 * The agent's single outbound WebSocket (D13, connection.ts). Dials `wss://…/v1/sandbox/connect`
 * with the `kobe.sandbox-wire` token in `Authorization` (never the URL), subprotocol
 * `kobe.sandbox.v1`, frames capped at the WebSocket layer (`maxPayload`) and no compression. Sends
 * `hello`, waits for `hello.ack`, then heartbeats; reconnects with jittered backoff until the server
 * closes with a terminal code. There is no listening socket anywhere in the agent.
 */
export type FatalReason = "unsupported_version" | "replaced" | "sandbox_destroyed" | "hibernating";

const FATAL_CODES = new Map<number, FatalReason>([
  [SANDBOX_CLOSE_CODES.unsupported_version, "unsupported_version"],
  [SANDBOX_CLOSE_CODES.replaced, "replaced"],
  [SANDBOX_CLOSE_CODES.sandbox_destroyed, "sandbox_destroyed"],
  [SANDBOX_CLOSE_CODES.hibernating, "hibernating"],
]);

export interface WireLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

export interface WireClientOptions {
  readonly url: string;
  readonly readToken: () => Promise<string>;
  readonly hello: () => HelloFrame;
  readonly onReady: (ack: HelloAckFrame) => void;
  readonly onFrame: (frame: ServerToSandboxFrame) => void;
  readonly onDisconnected: () => void;
  readonly onFatal: (reason: FatalReason) => void;
  readonly logger: WireLogger;
  readonly backoff?: BackoffPolicy;
  readonly helloTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
}

export class WireClient {
  readonly #options: WireClientOptions;
  #socket: WebSocket | undefined;
  #ready = false;
  #stopped = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #helloTimer: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #lastInbound = 0;

  constructor(options: WireClientOptions) {
    this.#options = options;
  }

  get ready(): boolean {
    return this.#ready;
  }

  start(): void {
    this.#stopped = false;
    void this.#dial();
  }

  /** Validate and send one frame; false when not connected or the frame is not sendable. */
  send(frame: OutboundFrame): boolean {
    const encoded = encodeOutbound(frame);
    if (!encoded.ok) {
      this.#options.logger.warn({ type: frame.type, code: encoded.code }, "unsendable frame");
      return false;
    }
    return this.sendText(encoded.text);
  }

  /** Send pre-encoded (already validated) text, e.g. buffered `pi.event` frames. */
  sendText(text: string): boolean {
    const socket = this.#socket;
    if (!this.#ready || socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(text);
    return true;
  }

  /** Drop the current connection and dial again (normal backoff). */
  reconnect(): void {
    this.#socket?.terminate();
  }

  async stop(code = 1000, reason = "agent stopping"): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    const socket = this.#socket;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close(code, reason);
    const timer = setTimeout(() => socket.terminate(), 2000);
    await closed;
    clearTimeout(timer);
  }

  async #dial(): Promise<void> {
    if (this.#stopped) return;
    let token: string;
    try {
      token = await this.#options.readToken();
    } catch (error) {
      this.#options.logger.warn({ err: (error as Error).message }, "cannot read sandbox token");
      this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) return;
    const socket = new WebSocket(this.#options.url, [SANDBOX_WS_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${token}` },
      maxPayload: SANDBOX_MAX_FRAME_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: SANDBOX_HELLO_TIMEOUT_MS,
    });
    this.#socket = socket;
    socket.on("open", () => this.#onOpen(socket));
    socket.on("message", (data, isBinary) => this.#onMessage(socket, data, isBinary));
    socket.on("close", (code, reason) => this.#onClose(socket, code, reason.toString()));
    socket.on("error", (error) => {
      this.#options.logger.debug({ err: error.message }, "sandbox wire socket error");
    });
  }

  #onOpen(socket: WebSocket): void {
    if (socket.protocol !== SANDBOX_WS_SUBPROTOCOL) {
      socket.close(1002, "subprotocol required");
      return;
    }
    this.#lastInbound = Date.now();
    this.#helloTimer = setTimeout(
      () => socket.terminate(),
      this.#options.helloTimeoutMs ?? SANDBOX_HELLO_TIMEOUT_MS,
    );
    const encoded = encodeOutbound(this.#options.hello());
    if (!encoded.ok) {
      socket.close(1011, "invalid hello");
      return;
    }
    socket.send(encoded.text);
  }

  #onMessage(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): void {
    if (socket !== this.#socket) return;
    this.#lastInbound = Date.now();
    if (isBinary) {
      this.#sendError(socket, "malformed_frame", "binary frames are not part of the protocol");
      return;
    }
    const decoded = decodeServerFrame(rawToString(data));
    if (!decoded.ok) {
      this.#sendError(socket, decoded.code, decoded.message);
      return;
    }
    const frame = decoded.frame;
    if (frame.type === "ping") {
      socket.send(JSON.stringify({ v: 1, type: "pong", nonce: frame.nonce }));
      return;
    }
    if (frame.type === "pong") return;
    if (frame.type === "hello.ack") {
      if (this.#ready) return;
      this.#onHelloAck(socket, frame);
      return;
    }
    if (!this.#ready) {
      this.#options.logger.warn({ type: frame.type }, "frame before hello.ack ignored");
      return;
    }
    this.#options.onFrame(frame);
  }

  #onHelloAck(socket: WebSocket, ack: HelloAckFrame): void {
    clearTimeout(this.#helloTimer);
    this.#ready = true;
    this.#attempt = 0;
    const interval = Math.min(60_000, Math.max(1000, ack.heartbeat_interval_ms));
    const timeout = Math.max(
      this.#options.heartbeatTimeoutMs ?? SANDBOX_HEARTBEAT_TIMEOUT_MS,
      2 * interval,
    );
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastInbound > timeout) {
        this.#options.logger.warn({ timeout }, "sandbox wire heartbeat timeout");
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify({ v: 1, type: "ping", nonce: randomUUID() }));
    }, interval);
    this.#options.logger.info({ connection_id: ack.connection_id }, "sandbox wire ready");
    this.#options.onReady(ack);
  }

  #onClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.#socket) return;
    clearTimeout(this.#helloTimer);
    clearInterval(this.#heartbeat);
    const wasReady = this.#ready;
    this.#ready = false;
    this.#socket = undefined;
    this.#options.logger.info({ code, reason }, "sandbox wire closed");
    if (wasReady) this.#options.onDisconnected();
    const fatal = FATAL_CODES.get(code);
    if (fatal !== undefined) {
      this.#stopped = true;
      this.#options.onFatal(fatal);
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const delay = backoffDelay(this.#attempt, this.#options.backoff ?? DEFAULT_BACKOFF);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => void this.#dial(), delay);
  }

  #sendError(socket: WebSocket, code: string, message: string): void {
    socket.send(JSON.stringify({ v: 1, type: "error", code, message: message.slice(0, 2000) }));
  }
}

function rawToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
