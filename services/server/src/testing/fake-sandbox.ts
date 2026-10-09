import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SANDBOX_WS_PATH,
  SANDBOX_WS_SUBPROTOCOL,
  decodeServerFrame,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
  type SessionTokenClaims,
} from "@kobe/protocol";
import WebSocket from "ws";
import type { SandboxLiveness, SessionTokenVerifier } from "../sandbox-wire/types.js";
import type { ServerDeps } from "../deps.js";

/** Condition waits are bounded below the 30 s test timeout and sized for a loaded 2-CPU CI runner. */
const WAIT_MS = 25_000;

/**
 * Test doubles for the sandbox side of the wire: a token "issuer" (opaque tokens mapped to claims;
 * KOBE-22's JWS verifier plugs in the same way), a liveness switch, a sandbox listener per replica,
 * and a scripted sandbox agent speaking the real frames over a real WebSocket.
 */
export class FakeSandboxAuth {
  readonly #tokens = new Map<string, SessionTokenClaims>();
  readonly dead = new Set<string>();

  issue(claims: { sandboxId: string; teamId: string; userId: string }, ttlSeconds = 900): string {
    const token = `tok-${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    this.#tokens.set(token, {
      iss: "kobe-server",
      aud: "kobe.sandbox-wire",
      sub: claims.sandboxId,
      team_id: claims.teamId,
      user_id: claims.userId,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomUUID(),
    });
    return token;
  }

  readonly verify: SessionTokenVerifier = (token) => {
    const claims = this.#tokens.get(token);
    if (!claims) throw new Error("invalid session token");
    return claims;
  };

  readonly liveness: SandboxLiveness = {
    isLive: ({ sandboxId }) => Promise.resolve(!this.dead.has(sandboxId)),
  };
}

/** The sandbox listener of one replica (KOBE-22's port 8081 in production). */
export async function sandboxListener(
  deps: ServerDeps,
  auth: FakeSandboxAuth,
): Promise<{ url: string; server: Server; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const detach = deps.sandboxWire.attach(server, { verify: auth.verify, liveness: auth.liveness });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${SANDBOX_WS_PATH}`,
    server,
    async close() {
      detach();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

/** A frame to send instead of the default answer; `null` swallows the frame (no answer). */
type Responder = (frame: ServerToSandboxFrame) => object | null | undefined;

/**
 * A scripted sandbox agent. By default it answers `get_entries` with the entries in `session`
 * (since-aware, "Entry not found" like Pi), `session.restore` parts and run commands with ok;
 * tests override with `respond`.
 */
export class FakeSandbox {
  readonly received: ServerToSandboxFrame[] = [];
  readonly errors: unknown[] = [];
  socket!: WebSocket;
  closed: Closed | undefined;
  /** Pi's session as the fake knows it (append order). */
  session: {
    id: string;
    parentId: string | null;
    type: string;
    timestamp: string;
    [k: string]: unknown;
  }[] = [];
  restored: { part: number; final: boolean; entries: unknown[] }[] = [];
  respond: Responder | undefined;
  /** Observes every decoded frame after the default answers. */
  onFrame: ((frame: ServerToSandboxFrame) => void) | undefined;
  autoAnswer = true;

  static async connect(
    url: string,
    token: string | undefined,
    opts: { protocol?: string; headers?: Record<string, string> } = {},
  ): Promise<FakeSandbox | { status: number }> {
    const fake = new FakeSandbox();
    const socket = new WebSocket(url, [opts.protocol ?? SANDBOX_WS_SUBPROTOCOL], {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
      perMessageDeflate: false,
    });
    return new Promise((resolve) => {
      socket.once("unexpected-response", (_req, res) => {
        resolve({ status: res.statusCode ?? 0 });
        socket.terminate();
      });
      socket.once("error", () => resolve({ status: -1 }));
      socket.once("open", () => {
        fake.#attach(socket);
        resolve(fake);
      });
    });
  }

  #attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on("message", (data) => {
      const decoded = decodeServerFrame(data.toString());
      if (!decoded.ok) {
        this.errors.push(decoded);
        return;
      }
      this.received.push(decoded.frame);
      this.#answer(decoded.frame);
      this.onFrame?.(decoded.frame);
    });
    socket.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  #answer(frame: ServerToSandboxFrame): void {
    const custom = this.respond?.(frame);
    if (custom === null) return;
    if (custom !== undefined) {
      this.sendRaw(custom);
      return;
    }
    if (!this.autoAnswer || !("command_id" in frame)) return;
    if (frame.type === "pi.command" && frame.command.type === "get_entries") {
      const since = frame.command.since;
      const at = since === undefined ? -1 : this.session.findIndex((e) => e.id === since);
      if (since !== undefined && at < 0) {
        this.result(frame.command_id, false, { code: "pi_rejected", message: "Entry not found" });
        return;
      }
      const entries = this.session.slice(at + 1);
      this.result(frame.command_id, true, {
        entries,
        leafId: this.session.at(-1)?.id ?? null,
      });
      return;
    }
    if (frame.type === "session.restore") {
      this.restored.push({ part: frame.part, final: frame.final, entries: frame.entries });
      if (frame.final) {
        this.session = this.restored.flatMap((p) => p.entries) as FakeSandbox["session"];
      }
      this.result(frame.command_id, true, { part: frame.part });
      return;
    }
    this.result(frame.command_id, true);
  }

  send(frame: SandboxToServerFrame | Record<string, unknown>): void {
    this.sendRaw(frame);
  }

  sendRaw(frame: object | string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    }
  }

  result(commandId: string, ok: boolean, payload?: unknown): void {
    this.send(
      ok
        ? {
            v: 1,
            type: "command.result",
            command_id: commandId,
            ok: true,
            ...(payload === undefined ? {} : { data: payload }),
          }
        : {
            v: 1,
            type: "command.result",
            command_id: commandId,
            ok: false,
            error: payload as object,
          },
    );
  }

  hello(
    sandboxId: string,
    runs: { run_id: string; thread_id: string; last_seq: number }[] = [],
    pi = "1.0.0",
    capabilities?: readonly string[],
  ): void {
    this.send({
      v: 1,
      type: "hello",
      sandbox_id: sandboxId,
      agent_version: "test",
      pi_version: pi,
      runs,
      ...(capabilities === undefined ? {} : { capabilities }),
    });
  }

  event(runId: string, threadId: string, seq: number, event: Record<string, unknown>): void {
    this.send({ v: 1, type: "pi.event", run_id: runId, thread_id: threadId, seq, event });
  }

  /** Waits until `predicate` holds over the received frames (or the socket closes). */
  async until<T>(predicate: () => T | undefined | false, timeoutMs = WAIT_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value !== undefined && value !== false) return value;
      if (Date.now() > deadline) throw new Error("FakeSandbox.until timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  frames<T extends ServerToSandboxFrame["type"]>(
    type: T,
  ): Extract<ServerToSandboxFrame, { type: T }>[] {
    return this.received.filter(
      (f): f is Extract<ServerToSandboxFrame, { type: T }> => f.type === type,
    );
  }

  /** Highest cumulative ack for a run. */
  acked(runId: string): number {
    return Math.max(
      0,
      ...this.frames("ack")
        .filter((a) => a.run_id === runId)
        .map((a) => a.seq),
    );
  }

  async ready(): Promise<Extract<ServerToSandboxFrame, { type: "hello.ack" }>> {
    return this.until(() => this.frames("hello.ack")[0]);
  }

  async waitClosed(timeoutMs = WAIT_MS): Promise<Closed> {
    return this.until(() => this.closed, timeoutMs);
  }

  close(): void {
    this.socket?.terminate();
  }
}

export function isFake(x: FakeSandbox | { status: number }): x is FakeSandbox {
  return x instanceof FakeSandbox;
}
