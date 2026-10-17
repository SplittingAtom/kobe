import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  virtualKeyContext,
  type GatewayPrincipal,
  type GatewayThinkingRow,
} from "@kobe/db";
import type { ThinkingLevel } from "@kobe/protocol";
import { deriveRunTokenKey } from "@kobe/protocol/node";
import { signSessionToken, verifySessionToken } from "@kobe/session-token";
import pino from "pino";
import { createModelGateway } from "../gateway.js";
import { ByteBudget, CallLimiter, RequestRate } from "../limits.js";
import { PrincipalCache } from "../principals.js";
import { OPEN_GATE, type CallGate, type CallRecord } from "../seams.js";
import { createFakeLlm, type SeenRequest } from "./fake-llm.js";

/**
 * The real model-gateway shim in front of the fake LLM upstream (standing in for Bifrost and the
 * provider), for integration tests of model clients (KOBE-41: Pi with kobe-models). One sandbox
 * identity with a virtual key; tokens are minted with the gateway's own session key, so the test
 * can also mint expired or foreign ones. Everything listens on 127.0.0.1 only.
 */
export interface LocalGatewayOptions {
  /** `<gateway provider>/<model>` ids the team enabled. */
  readonly enabledModels: readonly string[];
  /** Whether a run id (sent as `x-kobe-run-id`) is an active run of this sandbox. */
  readonly isRunLeased?: (runId: string) => boolean;
  /** KOBE-42 seam, e.g. to refuse calls with 503 + Retry-After. */
  readonly gate?: CallGate;
  /** KOBE-260: the enabled models' thinking settings (site and team), as the store reads them. */
  readonly thinking?: readonly GatewayThinkingRow[];
  /** KOBE-260: a run's recorded thinking level, by run id. */
  readonly runThinking?: (runId: string) => ThinkingLevel | undefined;
  /** KOBE-260: the token is an Orbit eval Job's (no run; the model's default level). */
  readonly eval?: boolean;
}

export interface LocalGateway {
  readonly url: string;
  readonly upstreamUrl: string;
  readonly identity: {
    readonly sandboxId: string;
    readonly teamId: string;
    readonly userId: string;
  };
  readonly virtualKey: string;
  /** What the upstream saw (credentials per request). */
  readonly seen: SeenRequest[];
  /** The gateway's usage records (one per call). */
  readonly calls: CallRecord[];
  /** A `kobe.model-gateway` token for this sandbox; `expiresInSeconds` may be negative. */
  mintToken(over?: { expiresInSeconds?: number; sandboxId?: string }): string;
  setEnabledModels(models: readonly string[]): void;
  /** KOBE-260: replaces the thinking settings (an admin change). */
  setThinking(rows: readonly GatewayThinkingRow[]): void;
  close(): Promise<void>;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startLocalGateway(options: LocalGatewayOptions): Promise<LocalGateway> {
  const sessionKey = randomUUID() + randomUUID();
  const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
  const identity = { sandboxId: randomUUID(), teamId: randomUUID(), userId: randomUUID() };
  const virtualKey = `sk-bf-${randomUUID()}`;
  let enabled = [...options.enabledModels];
  let thinking = [...(options.thinking ?? [])];
  const seen: SeenRequest[] = [];
  const calls: CallRecord[] = [];
  const upstream = createFakeLlm(seen);
  const upstreamUrl = await listen(upstream);
  const principal = (): GatewayPrincipal => ({
    member: true,
    sandbox: "live",
    virtualKey: {
      id: "vk-local",
      valueEnc: box.seal(virtualKey, virtualKeyContext(identity.teamId, identity.userId)),
    },
    enabledModels: enabled,
    thinking: thinking.filter((t) => enabled.includes(t.model)),
    ...(options.eval === true ? { eval: true as const } : {}),
  });
  const principals = new PrincipalCache(
    { load: async () => principal(), requestKey: async () => undefined },
    box,
    { ttlMs: 0 },
  );
  const shim = createModelGateway({
    verify: (token) => verifySessionToken(token, "kobe.model-gateway", sessionKey),
    principals,
    isRunLeased: async (_team, runId) => options.isRunLeased?.(runId) ?? true,
    runThinking: async (_team, runId) => options.runThinking?.(runId),
    // The harness' sessions carry no run token: enforcement stays off, legacy run ids apply.
    runTokens: {
      key: deriveRunTokenKey(new TextEncoder().encode(sessionKey)),
      isActive: async () => false,
      require: false,
    },
    bifrostUrl: upstreamUrl,
    limiter: new CallLimiter({ perSandbox: 8, total: 32 }),
    bytes: new ByteBudget({ perSandbox: 8 * 1024 * 1024, total: 32 * 1024 * 1024 }),
    rate: new RequestRate({ burst: 1000, perSecond: 1000 }),
    gate: options.gate ?? OPEN_GATE,
    sink: { record: (r) => calls.push(r) },
    onBifrostForgotKey: () => undefined,
    logger: pino({ level: "silent" }),
    settings: { maxBodyBytes: 8 * 1024 * 1024, idleTimeoutMs: 30_000 },
    ready: () => true,
  });
  const url = await listen(shim);
  return {
    url,
    upstreamUrl,
    identity,
    virtualKey,
    seen,
    calls,
    mintToken(over = {}) {
      const now = Math.floor(Date.now() / 1000);
      return signSessionToken(
        {
          iss: "kobe-server",
          aud: "kobe.model-gateway",
          sub: over.sandboxId ?? identity.sandboxId,
          team_id: identity.teamId,
          user_id: identity.userId,
          iat: now - 10,
          exp: now + (over.expiresInSeconds ?? 900),
          jti: randomUUID().replace(/-/g, ""),
        },
        sessionKey,
      );
    },
    setEnabledModels(models) {
      enabled = [...models];
    },
    setThinking(rows) {
      thinking = [...rows];
    },
    async close() {
      await closeServer(shim);
      await closeServer(upstream);
    },
  };
}
