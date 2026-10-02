import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  SANDBOX_MAX_FRAME_BYTES,
  SANDBOX_WS_PATH,
  SANDBOX_WS_SUBPROTOCOL,
  type SessionTokenClaims,
} from "@kobe/protocol";
import type { Logger } from "pino";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import type { SandboxLiveness, SandboxTarget, SessionTokenVerifier } from "./types.js";

/** Headers an ingress adds: sandbox endpoints are cluster-internal (KOBE-22), so these mean "from outside". */
const FORWARDED = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

export interface GatewayOptions {
  readonly verify: SessionTokenVerifier;
  readonly liveness: SandboxLiveness;
  readonly principalAllowed: (target: SandboxTarget) => Promise<boolean>;
  readonly accept: (socket: WebSocket, claims: SessionTokenClaims) => void;
  readonly log: Logger;
  readonly onRefused: (status: number, reason: string) => void;
  /** Most connections this replica accepts (beyond: 503). */
  readonly maxConnections: number;
  readonly connections: () => number;
  /** Upgrade attempts per remote address: burst and refill per second. */
  readonly attemptBurst?: number;
  readonly attemptsPerSec?: number;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

function refuse(socket: Duplex, status: number): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}

/** Per-address token buckets for upgrade attempts (before any token check). */
class AttemptLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly burst: number,
    readonly perSec: number,
  ) {}

  allow(address: string): boolean {
    const now = Date.now();
    const b = this.#buckets.get(address) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.#buckets.set(address, b);
    if (this.#buckets.size > 10_000) {
      for (const [k, v] of this.#buckets) if (v.tokens >= this.burst) this.#buckets.delete(k);
    }
    return ok;
  }
}

/**
 * The `/v1/sandbox/connect` WebSocket endpoint (D13, contract sandbox-wire/connection.ts). Attach it
 * to the **sandbox listener only** (KOBE-22: port 8081, never the user-facing app). The upgrade is
 * refused unless: the path is exact; no ingress forwarding headers; subprotocol `kobe.sandbox.v1`;
 * `Authorization: Bearer` with a valid `kobe.sandbox-wire` session token (never in the URL); the
 * sandbox `sub` is live for (team, user); the account is active and still a team member. Frames are
 * capped at the WebSocket layer (`maxPayload`), so an oversize frame is never buffered whole.
 */
export function attachSandboxGateway(server: Server, options: GatewayOptions): () => void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: SANDBOX_MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
    handleProtocols: (protocols) =>
      protocols.has(SANDBOX_WS_SUBPROTOCOL) ? SANDBOX_WS_SUBPROTOCOL : false,
  });
  const limiter = new AttemptLimiter(options.attemptBurst ?? 20, options.attemptsPerSec ?? 2);

  const handle = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const no = (status: number, reason: string) => {
      options.onRefused(status, reason);
      refuse(socket, status);
    };
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "", "http://sandbox.invalid").pathname;
    } catch {
      return no(400, "bad url");
    }
    if (pathname !== SANDBOX_WS_PATH || req.method !== "GET") return no(404, "path");
    if (FORWARDED.some((h) => req.headers[h] !== undefined)) return no(404, "forwarded");
    if (!limiter.allow(req.socket.remoteAddress ?? "unknown")) return no(429, "rate");
    const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    if (!protocols.includes(SANDBOX_WS_SUBPROTOCOL)) return no(400, "subprotocol");
    if (options.connections() >= options.maxConnections) return no(503, "capacity");
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(req.headers.authorization ?? "");
    if (!match?.[1]) return no(401, "no token");
    let claims: SessionTokenClaims;
    try {
      claims = options.verify(match[1]);
    } catch {
      return no(401, "token");
    }
    const target = { teamId: claims.team_id, userId: claims.user_id };
    const live = await options.liveness.isLive({ sandboxId: claims.sub, ...target });
    if (!live || !(await options.principalAllowed(target))) return no(401, "not live");
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => options.accept(ws, claims));
  };

  const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    handle(req, socket, head).catch((err: unknown) => {
      options.log.error({ err }, "sandbox upgrade failed");
      refuse(socket, 503);
    });
  };
  server.on("upgrade", listener);
  return () => {
    server.off("upgrade", listener);
    wss.close();
  };
}
