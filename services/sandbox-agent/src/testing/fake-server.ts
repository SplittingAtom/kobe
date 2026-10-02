import type { AddressInfo } from "node:net";
import {
  SANDBOX_MAX_FRAME_BYTES,
  SANDBOX_WS_PATH,
  SANDBOX_WS_SUBPROTOCOL,
  decodeSandboxFrame,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * In-process stand-in for the server side of the sandbox wire (KOBE-24 builds the real one). Every
 * frame the agent sends is checked with the server's own `decodeSandboxFrame`; anything it rejects
 * is recorded in `violations`, which tests assert to be empty.
 */
export interface FakeServerOptions {
  readonly token: string;
  /** `hello.ack.runs` for each connection; default: echo every run in `hello` with durable_seq 0. */
  readonly ackRuns?: (hello: Extract<SandboxToServerFrame, { type: "hello" }>) => {
    run_id: string;
    thread_id: string;
    durable_seq: number;
  }[];
  /** Ack every pi.event as it arrives (default true). */
  readonly autoAck?: boolean;
  readonly heartbeatIntervalMs?: number;
  /** Answer the agent's pings (default true); false simulates a hung server. */
  readonly respondPings?: boolean;
}

export interface Received {
  readonly connection: number;
  readonly frame: SandboxToServerFrame;
}

export class FakeServer {
  readonly received: Received[] = [];
  readonly violations: string[] = [];
  readonly upgrades: { authorization: string | undefined; path: string | undefined }[] = [];
  connections = 0;
  #server: WebSocketServer;
  #socket: WebSocket | undefined;
  #options: FakeServerOptions;
  #nextCommand = 1;

  private constructor(server: WebSocketServer, options: FakeServerOptions) {
    this.#server = server;
    this.#options = options;
    server.on("connection", (socket, request) => this.#onConnection(socket, request.url));
  }

  static async start(options: FakeServerOptions): Promise<FakeServer> {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: SANDBOX_MAX_FRAME_BYTES,
      handleProtocols: (protocols) =>
        protocols.has(SANDBOX_WS_SUBPROTOCOL) ? SANDBOX_WS_SUBPROTOCOL : false,
      verifyClient: (info, done) => {
        fake.upgrades.push({ authorization: info.req.headers.authorization, path: info.req.url });
        const ok = info.req.headers.authorization === `Bearer ${options.token}`;
        done(ok, ok ? undefined : 401);
      },
    });
    const fake: FakeServer = new FakeServer(server, options);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return fake;
  }

  get url(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  frames<T extends SandboxToServerFrame["type"]>(
    type: T,
  ): Extract<SandboxToServerFrame, { type: T }>[] {
    return this.received
      .filter((r) => r.frame.type === type)
      .map((r) => r.frame as Extract<SandboxToServerFrame, { type: T }>);
  }

  send(frame: ServerToSandboxFrame): void {
    this.#socket?.send(JSON.stringify(frame));
  }

  sendRaw(text: string): void {
    this.#socket?.send(text);
  }

  /** Send a command and wait for its single `command.result`. */
  async command(
    frame: Record<string, unknown> & { type: string },
    timeoutMs = 10_000,
  ): Promise<Extract<SandboxToServerFrame, { type: "command.result" }>> {
    const commandId = `c${this.#nextCommand++}`;
    this.send({ v: 1, command_id: commandId, ...frame } as ServerToSandboxFrame);
    return this.waitFor(
      (f): f is Extract<SandboxToServerFrame, { type: "command.result" }> =>
        f.type === "command.result" && f.command_id === commandId,
      timeoutMs,
    );
  }

  async waitFor<T extends SandboxToServerFrame>(
    match: (frame: SandboxToServerFrame) => frame is T,
    timeoutMs?: number,
  ): Promise<T>;
  async waitFor(
    match: (frame: SandboxToServerFrame) => boolean,
    timeoutMs?: number,
  ): Promise<SandboxToServerFrame>;
  async waitFor(
    match: (frame: SandboxToServerFrame) => boolean,
    timeoutMs = 10_000,
  ): Promise<SandboxToServerFrame> {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      for (; seen < this.received.length; seen++) {
        const frame = this.received[seen]?.frame;
        if (frame !== undefined && match(frame)) return frame;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(code: number, reason = ""): void {
    this.#socket?.close(code, reason);
  }

  terminate(): void {
    this.#socket?.terminate();
  }

  async stop(): Promise<void> {
    for (const client of this.#server.clients) client.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #onConnection(socket: WebSocket, path: string | undefined): void {
    if (path !== SANDBOX_WS_PATH) this.violations.push(`wrong path ${String(path)}`);
    this.#socket = socket;
    const connection = ++this.connections;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.violations.push("binary frame");
        return;
      }
      const text = data.toString();
      const decoded = decodeSandboxFrame(text);
      if (!decoded.ok) {
        this.violations.push(`${decoded.code}: ${decoded.message}`);
        return;
      }
      const frame = decoded.frame;
      this.received.push({ connection, frame });
      if (frame.type === "hello") this.#ackHello(socket, frame);
      if (frame.type === "ping" && this.#options.respondPings !== false)
        socket.send(JSON.stringify({ v: 1, type: "pong", nonce: frame.nonce }));
      if (frame.type === "pi.event" && this.#options.autoAck !== false) {
        socket.send(JSON.stringify({ v: 1, type: "ack", run_id: frame.run_id, seq: frame.seq }));
      }
    });
  }

  #ackHello(socket: WebSocket, hello: Extract<SandboxToServerFrame, { type: "hello" }>): void {
    const runs =
      this.#options.ackRuns?.(hello) ??
      hello.runs.map((r) => ({ run_id: r.run_id, thread_id: r.thread_id, durable_seq: 0 }));
    socket.send(
      JSON.stringify({
        v: 1,
        type: "hello.ack",
        connection_id: `conn_${this.connections}`,
        server_time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        heartbeat_interval_ms: this.#options.heartbeatIntervalMs ?? 15_000,
        runs,
      }),
    );
  }
}
