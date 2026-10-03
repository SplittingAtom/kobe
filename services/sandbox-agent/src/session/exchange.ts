import { readFile } from "node:fs/promises";
import { SESSION_TOKEN_AUDIENCES, uuidSchema, type SessionTokenAudience } from "@kobe/protocol";
import { z } from "zod";
import { DEFAULT_BACKOFF, backoffDelay, type BackoffPolicy } from "../wire/backoff.js";
import type { WireLogger } from "../wire/client.js";

/**
 * Bootstrap → session tokens (KOBE-22 contract, wired in KOBE-25). A Kobe sandbox pod gets one
 * credential: a projected ServiceAccount token (audience `kobe.sandbox-bootstrap`, rotated by the
 * kubelet, file at KOBE_BOOTSTRAP_TOKEN_FILE). The agent trades it at
 * `POST <server>/v1/sandbox/session` for its sandbox id and one short-lived session token per
 * audience, and trades again before they expire. Tokens are only ever held in memory and sent
 * in an Authorization header; never logged.
 *
 * Cold start (D14: hibernated → first token p95 ≤ 8 s) is dominated by how soon the first trade
 * succeeds: right after a pod starts, the CNI may not yet admit its traffic (kube-router installs
 * a new pod's policy on its next sync, docs/ledger/KOBE-22.md). So the first attempts are short
 * (per-attempt timeout) and retried quickly for `fastRetryForMs`, then back off with jitter.
 */

const grantSchema = z.object({
  sandbox_id: uuidSchema,
  team_id: uuidSchema,
  user_id: uuidSchema,
  expires_at: z.iso.datetime({ offset: true }),
  tokens: z.object(
    Object.fromEntries(
      SESSION_TOKEN_AUDIENCES.map((a) => [a, z.string().min(20).max(8192)]),
    ) as Record<SessionTokenAudience, z.ZodString>,
  ),
});

export interface SessionGrant {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly tokens: Readonly<Record<SessionTokenAudience, string>>;
}

export interface SessionClientOptions {
  /** The server's sandbox listener (KOBE_SERVER_URL, ws:// or wss://). */
  readonly serverUrl: string;
  readonly bootstrapTokenFile: string;
  readonly logger: WireLogger;
  readonly fetch?: typeof fetch;
  readonly readFile?: (path: string) => Promise<string>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Per-attempt timeout. */
  readonly attemptTimeoutMs?: number;
  /** Retry quickly (every `fastRetryMs`) for this long after the first attempt, then back off. */
  readonly fastRetryForMs?: number;
  readonly fastRetryMs?: number;
  readonly backoff?: BackoffPolicy;
  /** Trade again when the tokens expire within this margin. */
  readonly refreshMarginMs?: number;
}

/** Thrown by a single attempt; `retryAfterMs` when the server named a delay. */
class AttemptError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const SESSION_PATH = "/v1/sandbox/session";

/** ws(s)://host:port/... → http(s)://host:port/v1/sandbox/session */
export function sessionUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = SESSION_PATH;
  url.search = "";
  return url.toString();
}

export class SessionClient {
  readonly #o: Required<Omit<SessionClientOptions, "fetch" | "readFile" | "backoff" | "logger">> & {
    fetch: typeof fetch;
    readFile: (path: string) => Promise<string>;
    backoff: BackoffPolicy;
    logger: WireLogger;
  };
  readonly #url: string;
  #grant: SessionGrant | undefined;
  #pending: Promise<SessionGrant> | undefined;

  constructor(options: SessionClientOptions) {
    this.#o = {
      serverUrl: options.serverUrl,
      bootstrapTokenFile: options.bootstrapTokenFile,
      logger: options.logger,
      fetch: options.fetch ?? globalThis.fetch,
      readFile: options.readFile ?? ((path) => readFile(path, "utf8")),
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      attemptTimeoutMs: options.attemptTimeoutMs ?? 2_000,
      fastRetryForMs: options.fastRetryForMs ?? 30_000,
      fastRetryMs: options.fastRetryMs ?? 200,
      backoff: options.backoff ?? DEFAULT_BACKOFF,
      refreshMarginMs: options.refreshMarginMs ?? 120_000,
    };
    this.#url = sessionUrl(options.serverUrl);
  }

  /** The current grant, trading (with retries, until it succeeds) when there is none or it is near expiry. */
  async grant(): Promise<SessionGrant> {
    const g = this.#grant;
    if (g && g.expiresAt - this.#o.now() > this.#o.refreshMarginMs) return g;
    this.#pending ??= this.#tradeUntilGranted().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  /** The `kobe.sandbox-wire` token for the next dial. */
  async wireToken(): Promise<string> {
    return (await this.grant()).tokens["kobe.sandbox-wire"];
  }

  async #tradeUntilGranted(): Promise<SessionGrant> {
    const started = this.#o.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const grant = await this.#tradeOnce();
        if (this.#grant?.sandboxId !== undefined && this.#grant.sandboxId !== grant.sandboxId) {
          // The pod belongs to one sandbox for its whole life; another id means a server bug.
          throw new Error("the server assigned a different sandbox id");
        }
        this.#grant = grant;
        this.#o.logger.info(
          { sandbox_id: grant.sandboxId, attempts: attempt + 1, ms: this.#o.now() - started },
          "sandbox session acquired",
        );
        return grant;
      } catch (error) {
        if (!(error instanceof AttemptError)) throw error;
        const elapsed = this.#o.now() - started;
        const delay =
          error.retryAfterMs ??
          (elapsed < this.#o.fastRetryForMs
            ? // Jittered: many sandboxes woken together (a server restart) don't retry in step.
              Math.round(this.#o.fastRetryMs * (0.5 + this.#o.random()))
            : backoffDelay(attempt, this.#o.backoff, this.#o.random));
        if (attempt === 0 || attempt % 20 === 0) {
          this.#o.logger.info({ reason: error.message, attempt, delay }, "sandbox session retry");
        }
        await this.#o.sleep(delay);
      }
    }
  }

  async #tradeOnce(): Promise<SessionGrant> {
    let bootstrap: string;
    try {
      // Re-read every time: the kubelet rotates the projected token.
      bootstrap = (await this.#o.readFile(this.#o.bootstrapTokenFile)).trim();
    } catch (error) {
      throw new AttemptError(`cannot read the bootstrap token: ${(error as Error).message}`);
    }
    if (bootstrap === "") throw new AttemptError("the bootstrap token file is empty");
    let res: Response;
    try {
      res = await this.#o.fetch(this.#url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bootstrap}` },
        signal: AbortSignal.timeout(this.#o.attemptTimeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new AttemptError(`server unreachable: ${(error as Error).name}`);
    }
    const body = (await res.json().catch(() => undefined)) as
      { code?: unknown; retry_after_ms?: unknown } | undefined;
    if (res.status === 200) {
      const parsed = grantSchema.safeParse(body);
      if (!parsed.success) throw new AttemptError("malformed session response");
      const expiresAt = Date.parse(parsed.data.expires_at);
      return {
        sandboxId: parsed.data.sandbox_id,
        teamId: parsed.data.team_id,
        userId: parsed.data.user_id,
        expiresAt,
        tokens: parsed.data.tokens,
      };
    }
    const named = typeof body?.retry_after_ms === "number" ? body.retry_after_ms : undefined;
    const header = Number(res.headers.get("retry-after"));
    const retryAfter =
      named !== undefined
        ? Math.min(Math.max(named, 100), 60_000)
        : Number.isFinite(header) && header > 0
          ? Math.min(header * 1000, 60_000)
          : undefined;
    // 409 sandbox_unassigned (warm-pool pod not claimed yet), 429, 401 (pod not verifiable yet),
    // 503 (isolation missing / unavailable): all retried; the server decides when it is ready.
    throw new AttemptError(
      `session refused: HTTP ${res.status} ${typeof body?.code === "string" ? body.code : ""}`.trim(),
      retryAfter,
    );
  }
}
