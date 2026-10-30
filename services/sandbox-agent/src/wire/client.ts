import { randomUUID } from "node:crypto";
import {
  SANDBOX_CLOSE_CODES,
  SANDBOX_HEARTBEAT_TIMEOUT_MS,
  SANDBOX_HELLO_TIMEOUT_MS,
  SANDBOX_MAX_FRAME_BYTES,
  SANDBOX_SEND_PACE,
  SANDBOX_WS_SUBPROTOCOL,
  decodeServerFrame,
  type HelloAckFrame,
  type HelloFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import WebSocket from "ws";
import { DEFAULT_BACKOFF, backoffDelay, type BackoffPolicy } from "./backoff.js";
import { encodeOutbound, type OutboundFrame } from "./encode.js";
import { SendPacer, type PaceLimits } from "./pacer.js";

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

/**
 * Frames with a `run_id` that the agent drops once the run ended locally (KOBE-483): a UI request,
 * a policy check or a tool call of an ended run would only reach a server that already released it.
 * `pi.event` (journaled by the outbox, acked by the server even when late) and `trace.spans`
 * (tolerated late by design) are kept.
 */
const KEPT_AFTER_END = new Set(["pi.event", "trace.spans"]);
const ENDED_RUNS_MAX = 1024;

function droppableRunId(frame: OutboundFrame): string | undefined {
  if (KEPT_AFTER_END.has(frame.type) || !("run_id" in frame)) return undefined;
  return typeof frame.run_id === "string" ? frame.run_id : undefined;
}

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
  /** Outbound pace per connection (default {@link SANDBOX_SEND_PACE}, under the server's limit). */
  readonly pace?: PaceLimits;
  /**
   * How often a live connection checks `readToken` for a fresh token to hand over with
   * `session.renew` (KOBE-483; default {@link SESSION_RENEW_CHECK_MS}).
   */
  readonly renewIntervalMs?: number;
  /**
   * The server refused `token` (HTTP 401 on the upgrade, or close 4001; KOBE-522): the session
   * client re-trades (rate-limited), and the next dial reads the new token.
   */
  readonly onTokenRejected?: (token: string, reason: string) => void;
}

/**
 * Well inside the session client's refresh margin (2 min before expiry) plus the server's grace
 * (1 min after): a fresh token reaches the live connection before the old one's deadline.
 */
export const SESSION_RENEW_CHECK_MS = 30_000;

export class WireClient {
  readonly #options: WireClientOptions;
  #socket: WebSocket | undefined;
  #ready = false;
  #stopped = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #helloTimer: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #renewTimer: NodeJS.Timeout | undefined;
  /** The token the current connection is authenticated with (dialled or last renewed). */
  #connectionToken: string | undefined;
  #lastInbound = 0;
  #epoch = 0;
  /**
   * Every outbound frame (hello, pings, pongs, replays, live frames) goes through one FIFO pacer,
   * so a reconnect replaying a long backlog never exceeds the server's frame or byte rate and
   * gets closed for it (KOBE-429). Reset on each new socket, like the server's buckets.
   */
  readonly #pacer: SendPacer;
  /** Runs that ended locally (Stop, abort, finish, no longer leased): their frames are dropped. */
  readonly #endedRuns = new Set<string>();

  constructor(options: WireClientOptions) {
    this.#options = options;
    this.#pacer = new SendPacer(options.pace ?? SANDBOX_SEND_PACE, (text) => this.#write(text));
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** Increments with every accepted `hello.ack`: identifies the connection a command came on. */
  get epoch(): number {
    return this.#epoch;
  }

  start(): void {
    this.#stopped = false;
    void this.#dial();
  }

  /**
   * Validate and send one frame; false when not connected, the frame is not sendable, or it names
   * a run that already ended here (KOBE-483).
   */
  send(frame: OutboundFrame): boolean {
    const runId = droppableRunId(frame);
    if (runId !== undefined && this.#endedRuns.has(runId)) {
      this.#options.logger.debug(
        { type: frame.type, run_id: runId },
        "frame of an ended run dropped",
      );
      return false;
    }
    const encoded = encodeOutbound(frame);
    if (!encoded.ok) {
      this.#options.logger.warn({ type: frame.type, code: encoded.code }, "unsendable frame");
      return false;
    }
    return this.#enqueue(encoded.text, runId);
  }

  /** Send pre-encoded (already validated) text, e.g. buffered `pi.event` frames. */
  sendText(text: string): boolean {
    return this.#enqueue(text, undefined);
  }

  /**
   * The run ended locally (Stop, abort, finish, or the server no longer leases it): frames of it
   * still waiting in the pacer are dropped and later ones refused, so none reaches a server that
   * already released the run (KOBE-483). Durable `pi.event`s stay with the outbox.
   */
  endRun(runId: string): void {
    this.#endedRuns.delete(runId);
    this.#endedRuns.add(runId);
    if (this.#endedRuns.size > ENDED_RUNS_MAX) {
      const oldest = this.#endedRuns.values().next().value;
      if (oldest !== undefined) this.#endedRuns.delete(oldest);
    }
    const dropped = this.#pacer.dropTagged(runId);
    if (dropped > 0) {
      this.#options.logger.debug(
        { run_id: runId, dropped },
        "queued frames of an ended run dropped",
      );
    }
  }

  /** The run (re)started here: its frames go out again (a run id is only "ended" until then). */
  startRun(runId: string): void {
    this.#endedRuns.delete(runId);
  }

  #enqueue(text: string, tag: string | undefined): boolean {
    const socket = this.#socket;
    if (!this.#ready || socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    this.#pacer.send(text, tag);
    return true;
  }

  /** Paced write to the current socket; frames queued for a socket that closed are dropped. */
  #write(text: string): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(text);
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
    this.#connectionToken = token;
    const socket = new WebSocket(this.#options.url, [SANDBOX_WS_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${token}` },
      maxPayload: SANDBOX_MAX_FRAME_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: SANDBOX_HELLO_TIMEOUT_MS,
    });
    this.#socket = socket;
    this.#pacer.reset();
    socket.on("open", () => this.#onOpen(socket));
    socket.on("message", (data, isBinary) => this.#onMessage(socket, data, isBinary));
    let refused: string | undefined;
    socket.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) refused = "wire upgrade refused: HTTP 401";
      socket.terminate();
    });
    socket.on("close", (code, reason) => {
      if (socket === this.#socket && code === SANDBOX_CLOSE_CODES.unauthorized) {
        refused = `wire closed: ${code}`;
      }
      if (refused !== undefined && socket === this.#socket) {
        this.#options.onTokenRejected?.(this.#connectionToken ?? token, refused);
      }
      this.#onClose(socket, code, reason.toString());
    });
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
    this.#pacer.send(encoded.text);
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
      this.#pacer.send(JSON.stringify({ v: 1, type: "pong", nonce: frame.nonce }));
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
    this.#epoch += 1;
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
      this.#pacer.send(JSON.stringify({ v: 1, type: "ping", nonce: randomUUID() }));
    }, interval);
    this.#renewTimer = setInterval(
      () => void this.#renew(socket),
      this.#options.renewIntervalMs ?? SESSION_RENEW_CHECK_MS,
    );
    this.#options.logger.info({ connection_id: ack.connection_id }, "sandbox wire ready");
    this.#options.onReady(ack);
  }

  #onClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.#socket) return;
    clearTimeout(this.#helloTimer);
    clearInterval(this.#heartbeat);
    clearInterval(this.#renewTimer);
    const wasReady = this.#ready;
    this.#ready = false;
    this.#socket = undefined;
    this.#pacer.reset();
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

  /**
   * Session renewal in band (KOBE-483): the server closes a connection whose token expired, which
   * would interrupt the runs on it. Reading the token also makes the session client trade for a
   * fresh one near expiry; a token the connection does not have yet goes over as `session.renew`.
   * The token is never logged.
   */
  async #renew(socket: WebSocket): Promise<void> {
    let token: string;
    try {
      token = await this.#options.readToken();
    } catch (error) {
      this.#options.logger.warn({ err: (error as Error).message }, "cannot renew sandbox token");
      return;
    }
    if (socket !== this.#socket || !this.#ready || token === this.#connectionToken) return;
    if (this.send({ v: 1, type: "session.renew", token })) this.#connectionToken = token;
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const delay = backoffDelay(this.#attempt, this.#options.backoff ?? DEFAULT_BACKOFF);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => void this.#dial(), delay);
  }

  #sendError(socket: WebSocket, code: string, message: string): void {
    if (socket !== this.#socket) return;
    this.#pacer.send(
      JSON.stringify({ v: 1, type: "error", code, message: message.slice(0, 2000) }),
    );
  }
}

function rawToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
