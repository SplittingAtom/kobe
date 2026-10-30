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
 *
 * Warm-pool pods (KOBE-417): a pod nobody has claimed yet gets 409 `sandbox_unassigned`. From then
 * on the agent asks with `Prefer: wait=<s>`: the server holds the request until the claim lands
 * (answering within its recheck interval) or the wait runs out (409 + `Preference-Applied`), and
 * the agent asks again at once. A server that does not hold the request gets exponential,
 * jittered backoff up to `unassignedBackoff.maxMs` instead of a poll every 2 s.
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
  /** Long-poll length asked of the server while unassigned (`Prefer: wait=<s>`). */
  readonly unassignedWaitSeconds?: number;
  /** Delays while unassigned and the server answers without holding the request. */
  readonly unassignedBackoff?: { readonly baseMs: number; readonly maxMs: number };
  /** Gaps between re-trades after rejected tokens (KOBE-522); see {@link RETRADE_BACKOFF}. */
  readonly retradeBackoff?: RetradePolicy;
}

export interface RetradePolicy {
  /** The first gap; doubles while the server keeps refusing. */
  readonly baseMs: number;
  readonly maxMs: number;
  /** A rejection this long after the last re-trade starts the backoff over. */
  readonly quietMs: number;
}

/** One re-trade per 30 s at most, doubling to 5 min while the server keeps refusing (KOBE-522). */
export const RETRADE_BACKOFF: RetradePolicy = {
  baseMs: 30_000,
  maxMs: 300_000,
  quietMs: 600_000,
};

export const UNASSIGNED_WAIT_SECONDS = 20;
export const UNASSIGNED_BACKOFF = { baseMs: 2_000, maxMs: 60_000 } as const;

/** Exponential with "equal jitter": [ceiling/2, ceiling), ceiling doubling from `baseMs` to `maxMs`. */
export function unassignedDelay(
  n: number,
  policy: { readonly baseMs: number; readonly maxMs: number },
  random: () => number,
): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(n, 30));
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

/** How the server answered a refused attempt (absent: it did not answer at all). */
type Refusal = "unassigned" | "unassigned-held" | "other";

/** Thrown by a single attempt; `retryAfterMs` when the server named a delay. */
class AttemptError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    readonly refusal?: Refusal,
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
  readonly #o: Required<
    Omit<
      SessionClientOptions,
      "fetch" | "readFile" | "backoff" | "logger" | "unassignedBackoff" | "retradeBackoff"
    >
  > & {
    fetch: typeof fetch;
    readFile: (path: string) => Promise<string>;
    backoff: BackoffPolicy;
    logger: WireLogger;
    unassignedBackoff: { readonly baseMs: number; readonly maxMs: number };
    retradeBackoff: RetradePolicy;
  };
  readonly #url: string;
  #grant: SessionGrant | undefined;
  /** The pod belongs to one sandbox for its whole life (kept across re-trades). */
  #sandboxId: string | undefined;
  #pending: Promise<SessionGrant> | undefined;
  readonly #listeners = new Set<(grant: SessionGrant) => void>();
  /** Re-trade rate limit (KOBE-522): epoch ms of the last one, the next allowed, the streak. */
  #lastRetradeAt: number | undefined;
  #nextRetradeAt = 0;
  #retradeStreak = 0;
  #limitWarned = false;

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
      unassignedWaitSeconds: options.unassignedWaitSeconds ?? UNASSIGNED_WAIT_SECONDS,
      unassignedBackoff: options.unassignedBackoff ?? UNASSIGNED_BACKOFF,
      retradeBackoff: options.retradeBackoff ?? RETRADE_BACKOFF,
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

  /**
   * A consumer saw `audience`'s token refused (KOBE-522). Today only the wire calls this (a 401 on
   * the upgrade, a 4001 close): Pi and its tools talk to the gateway and proxies directly, so the
   * agent never sees their 401s. After a signing-key change every cached token is dead until the
   * next scheduled trade (up to ~13 min), so drop the grant and trade the bootstrap token again
   * now: that trade does not depend on session keys. Rate-limited (one per 30 s, doubling to
   * 5 min while the server keeps refusing) so a permanently refused token never loops hot.
   * `token`, when given, is the token that was refused: a rejection of one already replaced is
   * ignored. Returns whether a re-trade started; listeners ({@link onGrant}) get the new grant.
   */
  rejected(audience: SessionTokenAudience, reason: string, token?: string): boolean {
    const g = this.#grant;
    if (this.#pending !== undefined || g === undefined) return false;
    if (token !== undefined && g.tokens[audience] !== token) return false;
    const now = this.#o.now();
    if (now < this.#nextRetradeAt) {
      if (!this.#limitWarned) {
        this.#limitWarned = true;
        this.#o.logger.warn(
          { audience, reason, retry_in_ms: this.#nextRetradeAt - now },
          "sandbox session re-trade rate-limited",
        );
      }
      return false;
    }
    const policy = this.#o.retradeBackoff;
    const quiet = this.#lastRetradeAt === undefined || now - this.#lastRetradeAt >= policy.quietMs;
    this.#retradeStreak = quiet ? 0 : this.#retradeStreak + 1;
    const gap = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(this.#retradeStreak, 30));
    this.#lastRetradeAt = now;
    this.#nextRetradeAt = now + gap;
    this.#limitWarned = false;
    this.#o.logger.info(
      { audience, reason, retrade: this.#retradeStreak + 1, next_allowed_in_ms: gap },
      "sandbox session re-trade after a rejected token",
    );
    this.#grant = undefined;
    this.#pending ??= this.#tradeUntilGranted(true).finally(() => {
      this.#pending = undefined;
    });
    this.#pending.catch((error: unknown) => {
      this.#o.logger.warn({ err: (error as Error).message }, "sandbox session re-trade failed");
    });
    return true;
  }

  /** Called with every new grant (each trade, scheduled or after a rejection); returns unsubscribe. */
  onGrant(listener: (grant: SessionGrant) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The `kobe.sandbox-wire` token for the next dial. */
  async wireToken(): Promise<string> {
    return (await this.grant()).tokens["kobe.sandbox-wire"];
  }

  /** The `kobe.model-gateway` token and its expiry (KOBE-41 `ModelTokenKeeper`). */
  async modelGatewayGrant(): Promise<{ token: string; expiresAt: number }> {
    const g = await this.grant();
    return { token: g.tokens["kobe.model-gateway"], expiresAt: g.expiresAt };
  }

  /** The `kobe.egress-proxy` token and its expiry (KOBE-39: tools' proxy credentials). */
  async egressProxyGrant(): Promise<{ token: string; expiresAt: number }> {
    const g = await this.grant();
    return { token: g.tokens["kobe.egress-proxy"], expiresAt: g.expiresAt };
  }

  /** The `kobe.mcp-proxy` token and its expiry (KOBE-111: Pi's per-session MCP config). */
  async mcpProxyGrant(): Promise<{ token: string; expiresAt: number }> {
    const g = await this.grant();
    return { token: g.tokens["kobe.mcp-proxy"], expiresAt: g.expiresAt };
  }

  get refreshMarginMs(): number {
    return this.#o.refreshMarginMs;
  }

  /**
   * `retrade`: after a rejected token (KOBE-522) the network is up, so no fast-retry phase, and
   * every refusal (not only transport failures) moves along the backoff schedule.
   */
  async #tradeUntilGranted(retrade = false): Promise<SessionGrant> {
    const started = this.#o.now();
    // Long-poll once the server has said the pod is unassigned (KOBE-417).
    let longPoll = false;
    // Unassigned answers the server did not hold; transport/other failures since the last answer.
    let unheld = 0;
    let failures = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const grant = await this.#tradeOnce(longPoll ? this.#o.unassignedWaitSeconds : 0);
        if (this.#sandboxId !== undefined && this.#sandboxId !== grant.sandboxId) {
          // The pod belongs to one sandbox for its whole life; another id means a server bug.
          throw new Error("the server assigned a different sandbox id");
        }
        this.#grant = grant;
        this.#sandboxId = grant.sandboxId;
        this.#o.logger.info(
          { sandbox_id: grant.sandboxId, attempts: attempt + 1, ms: this.#o.now() - started },
          "sandbox session acquired",
        );
        for (const listener of this.#listeners) {
          try {
            listener(grant);
          } catch (error) {
            this.#o.logger.warn({ err: (error as Error).message }, "session grant listener failed");
          }
        }
        return grant;
      } catch (error) {
        if (!(error instanceof AttemptError)) throw error;
        let delay: number;
        if (error.refusal === "unassigned" || error.refusal === "unassigned-held") {
          failures = 0;
          if (!longPoll || error.refusal === "unassigned-held") {
            // Into the long-poll, or straight back after a held answer: claim → ready stays
            // bounded by the server's recheck, not by our sleep.
            delay =
              error.refusal === "unassigned-held" && error.retryAfterMs !== undefined
                ? error.retryAfterMs
                : this.#fastRetry();
            longPoll = true;
          } else {
            delay = Math.max(
              error.retryAfterMs ?? 0,
              unassignedDelay(unheld++, this.#o.unassignedBackoff, this.#o.random),
            );
          }
        } else {
          delay =
            error.retryAfterMs ??
            (!retrade && this.#o.now() - started < this.#o.fastRetryForMs
              ? this.#fastRetry()
              : backoffDelay(failures, this.#o.backoff, this.#o.random));
          failures = error.refusal === undefined || retrade ? failures + 1 : 0;
        }
        if (attempt === 0 || attempt % 20 === 0) {
          this.#o.logger.info({ reason: error.message, attempt, delay }, "sandbox session retry");
        }
        await this.#o.sleep(delay);
      }
    }
  }

  /** Jittered: many sandboxes woken together (a server restart) don't retry in step. */
  #fastRetry(): number {
    return Math.round(this.#o.fastRetryMs * (0.5 + this.#o.random()));
  }

  /** One trade; `waitSeconds` > 0 asks the server to hold the request while unassigned. */
  async #tradeOnce(waitSeconds: number): Promise<SessionGrant> {
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
        headers: {
          Authorization: `Bearer ${bootstrap}`,
          ...(waitSeconds > 0 ? { Prefer: `wait=${waitSeconds}` } : {}),
        },
        signal: AbortSignal.timeout(this.#o.attemptTimeoutMs + waitSeconds * 1000),
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
    const unassigned = res.status === 409 && body?.code === "sandbox_unassigned";
    const held = unassigned && /\bwait=\d/.test(res.headers.get("preference-applied") ?? "");
    throw new AttemptError(
      `session refused: HTTP ${res.status} ${typeof body?.code === "string" ? body.code : ""}`.trim(),
      retryAfter,
      held ? "unassigned-held" : unassigned ? "unassigned" : "other",
    );
  }
}
